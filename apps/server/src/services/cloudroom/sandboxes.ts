import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { CloudroomConnectionError, CloudroomError } from "./client.js";
import { macHarnessVersions } from "./harness-versions.js";

export const SANDBOX_PREFIX = "sandbox:";
export const sandboxThread = (coreUrl: string) => coreUrl.startsWith(SANDBOX_PREFIX) ? coreUrl.slice(SANDBOX_PREFIX.length) : null;
export class SandboxAsleep extends Error {}

const viewSchema = z.object({
  thread: z.string(), state: z.enum(["new", "awake", "asleep", "archived", "deleted", "failed"]), generation: z.number(),
  issue: z.string().nullable(), origin: z.string().url().optional(), token: z.string().optional(),
  startup: z.object({ source: z.enum(["spare", "image", "template", "backup", "resume", "restart", "reuse"]), duration_ms: z.number().nonnegative() }).optional().catch(undefined),
});
type View = z.infer<typeof viewSchema>;
export type SandboxAccount = { website: string; userId: string; token: string };
export type SandboxConnection = { url: string; token: string };
export type SandboxTrigger = "app_launch" | "app_activity" | "composer" | "thread_typing";
/** Logins the website keeps for every sandbox of an account (ADR 0145). */
export type SandboxLogin = "claude" | "codex" | "pi" | "github" | "cursor";
/** GitHub projects also name their repository and cloud folder, so the website can build a template. */
export type SandboxProject = { id: string; repository: string | null; folder: string };
// A sleeping sandbox is only looked up again after this long; sending work wakes it at once.
const RECHECK_MS = 60_000;
// The Mac's skills and global instructions that sandboxes receive, one way (docs/scopes/sandboxes.md).
const CONFIG_PATHS = [".agents/skills", ".claude/skills", ".claude/CLAUDE.md", ".codex/skills", ".codex/AGENTS.md", ".pi/agent/skills", ".pi/agent/AGENTS.md"];
const CONFIG_LIMIT = 45 * 1024 * 1024;
const codexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
export const hasMacCodexLogin = () => access(codexAuthPath()).then(() => true, () => false);

type MacCodexLogin = { child: ChildProcess; url: string | null; error: string | null; done: boolean };
let macCodexLoginRun: MacCodexLogin | null = null;
/** Runs `codex login` on this Mac. Codex opens the default browser and saves the login itself; one run at a time, 10 minutes at most. */
export function startMacCodexLogin(): MacCodexLogin {
  if (macCodexLoginRun && !macCodexLoginRun.done) return macCodexLoginRun;
  const child = spawn("codex", ["login"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
  const run: MacCodexLogin = { child, url: null, error: null, done: false };
  let output = "";
  const read = (chunk: Buffer) => { output += chunk.toString(); run.url ??= output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0] ?? null; };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  child.on("error", (error: NodeJS.ErrnoException) => {
    run.done = true;
    run.error = error.code === "ENOENT" ? "Codex is not installed on this Mac. Install it with `npm i -g @openai/codex`, then click Connect again." : `Codex sign-in could not start: ${error.message}`;
  });
  child.on("exit", code => { run.done = true; if (code !== 0) run.error ??= "Codex sign-in did not finish. Click Connect to try again."; });
  macCodexLoginRun = run;
  return run;
}
/** The current `codex login` run; a finished run is returned once, then forgotten. */
export function macCodexLogin(): MacCodexLogin | null {
  const run = macCodexLoginRun;
  if (run?.done) macCodexLoginRun = null;
  return run;
}
export function cancelMacCodexLogin(): void {
  macCodexLoginRun?.child.kill();
  macCodexLoginRun = null;
}

function contentDigest(tar: Buffer): string {
  const hash = createHash("sha256");
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const end = at + 512 + Math.ceil(Number.parseInt(tar.toString("latin1", at + 124, at + 136).replace(/\0/g, "").trim() || "0", 8) / 512) * 512;
    hash.update(tar.subarray(at, at + 136)).update(tar.subarray(at + 156, end));
    at = end;
  }
  return hash.digest("hex");
}

/** This Mac's Cursor CLI login in the file shape the CLI keeps on Linux, or null when Cursor is signed out here.
 *  The CLI stores it in the Keychain through /usr/bin/security, so reading it the same way shows no macOS prompt. */
export async function macCursorLogin(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const read = (service: string) => promisify(execFile)("/usr/bin/security", ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"], { timeout: 10_000 })
    .then(result => result.stdout.trim(), () => "");
  const [accessToken, refreshToken] = await Promise.all([read("cursor-access-token"), read("cursor-refresh-token")]);
  return accessToken && refreshToken ? JSON.stringify({ accessToken, refreshToken }, null, 2) : null;
}

const output = (command: string, args: string[]) => promisify(execFile)(command, args, { timeout: 10_000 }).then(result => result.stdout.trim(), () => "");
/** This Mac's GitHub CLI token, or "" when `gh` is missing or signed out. */
export const macGithubToken = () => output("gh", ["auth", "token", "--hostname", "github.com"]);
/** The GitHub login sandboxes receive. Agents commit as the user, with the Mac's Git identity. */
export async function sandboxGithubLogin(token: string): Promise<string> {
  const [name, email] = await Promise.all([output("git", ["config", "--global", "user.name"]), output("git", ["config", "--global", "user.email"])]);
  return JSON.stringify({ token, ...(name ? { name } : {}), ...(email ? { email } : {}) });
}

const environmentSchema = z.object({ variables: z.array(z.object({ name: z.string(), hint: z.string() })), setup: z.string() });
export type CloudEnvironment = z.infer<typeof environmentSchema>;
export const cloudEnvironmentRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({ action: z.literal("set"), variables: z.record(z.string(), z.string()) }),
  z.object({ action: z.literal("remove"), name: z.string().min(1) }),
  z.object({ action: z.literal("setup"), setup: z.string() }),
]);
export type CloudEnvironmentRequest = z.infer<typeof cloudEnvironmentRequestSchema>;

/** API keys, tokens, and secrets exported in this Mac's login shell (say, ~/.zshrc): what local agents get (ADR 0130). */
export async function macVariables(): Promise<Record<string, string>> {
  const marker = "__CLOUDROOM_ENV__";
  const run = promisify(execFile)(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '${marker}\\0'; env -0`], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  run.child.stdin?.end();
  const output = await run.then(result => result.stdout, () => "");
  const entries = output.slice(output.indexOf(`${marker}\0`) + marker.length + 1).split("\0");
  return Object.fromEntries(entries.flatMap(entry => {
    const at = entry.indexOf("="), name = entry.slice(0, at), value = entry.slice(at + 1);
    const wanted = at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /KEY|TOKEN|SECRET/i.test(name) && !/^(BB|ROOM|CLOUDROOM|ELECTRON)_/.test(name);
    return wanted && value && !/[\r\n]/.test(value) ? [[name, value]] : [];
  }));
}

/** Asks the website to delete this sign-in's token. Best effort: signing out never waits for the network. */
export function revokeDesktopToken(account: SandboxAccount): void {
  void fetch(`${account.website}/api/desktop/sign-out`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
  }).then(response => response.body?.cancel(), () => {});
}

/** Each cloud thread's own sandbox, managed by the website (docs/scopes/sandboxes.md). Lookups never wake it. */
export class SandboxDirectory {
  private readonly views = new Map<string, { view: View; at: number }>();
  private readonly wakes = new Map<string, Promise<View>>();
  private readonly wakeStarts = new Map<string, number>();
  private readonly wakeHarnesses = new Map<string, Awaited<ReturnType<typeof macHarnessVersions>>>();
  // After a failed wake, wait before asking again: 5 s, doubling to 5 minutes. Delivery retries every tick otherwise.
  private readonly backoff = new Map<string, { until: number; delay: number }>();
  private uploaded = new Map<string, string>();
  constructor(readonly account: () => Promise<SandboxAccount | null>) {}

  /** `only` sends the request solely for that account, so a login started under one account never reaches another. */
  private async call(body: Record<string, unknown>, path = "sandboxes", only?: { account: SandboxAccount; signal: AbortSignal }): Promise<unknown> {
    const account = await this.account();
    if (!account) throw new CloudroomError("Sign in to Cloudroom to use cloud sandboxes.");
    if (only && (account.userId !== only.account.userId || account.website !== only.account.website)) throw new CloudroomError("The Cloudroom account changed. Try again.");
    let response: Response;
    try {
      response = await fetch(`${account.website}/api/desktop/${path}`, {
        method: "POST", redirect: "error", signal: only ? AbortSignal.any([only.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
        body: JSON.stringify(body),
      });
    } catch (error) { throw new CloudroomConnectionError(`Cloudroom could not reach the website to manage this thread's sandbox: ${error instanceof Error ? error.message : String(error)}`); }
    const value = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) {
      const message = typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`;
      if (response.status === 409 && /busy/i.test(message)) throw new CloudroomConnectionError(message);
      throw new CloudroomError(message, response.status >= 500 ? null : response.status);
    }
    return value;
  }

  /** The member's friend invite codes. `create` makes one more, up to 3 for life (ADR 0169). */
  async invites(action: "list" | "create") {
    const value = await this.call({ action }, "invites");
    return z.object({ codes: z.array(z.object({ code: z.string(), used: z.boolean() })), left: z.number(), created: z.string().nullable() }).parse(value);
  }

  /** Whether the website judges a generated thread title too vague to keep, at the user's sensitivity (2–5). */
  async titleTooVague(check: { title: string; firstMessage: string; agentReply: string; sensitivity: number }): Promise<boolean> {
    const value = await this.call({ ...check, sensitivity: String(check.sensitivity) }, "thread-title");
    return z.object({ rename: z.boolean() }).parse(value).rename;
  }

  private remember(view: View): View {
    this.views.set(view.thread, { view, at: Date.now() });
    return view;
  }

  /** The thread's Core, or null while it sleeps. `wake` starts it; only callers with work to send pass true. */
  async connection(thread: string, project: SandboxProject, wake: boolean): Promise<SandboxConnection | null> {
    const cached = this.views.get(thread);
    let view = cached?.view;
    const place = { thread, project: project.id, ...(project.repository ? { repository: project.repository, folder: project.folder } : {}) };
    // A wake registers too, so only lookups need their own call.
    if (!wake && (!view || (view.state !== "awake" && Date.now() - cached!.at > RECHECK_MS))) {
      view = this.remember(viewSchema.parse(await this.call({ action: "register", ...place })));
    }
    if (view?.state === "awake" && view.origin && view.token) return { url: view.origin, token: view.token };
    if (!wake) return null;
    const waiting = this.backoff.get(thread);
    if (waiting && Date.now() < waiting.until) throw new CloudroomConnectionError(`The cloud sandbox could not start. Retrying in ${Math.ceil((waiting.until - Date.now()) / 1000)} seconds.`);
    let pending = this.wakes.get(thread);
    if (!pending) {
      this.wakeStarts.set(thread, Date.now());
      // The Mac's harness versions: the sandbox upgrades to them before its agent starts (ADR 0133).
      pending = macHarnessVersions().then(harnesses => {
        this.wakeHarnesses.set(thread, harnesses);
        return this.call({ action: "wake", ...place, harnesses, ...(this.backoff.has(thread) ? { trigger: "retry" } : {}) });
      }).then(value => this.remember(viewSchema.parse(value))).then(view => { this.backoff.delete(thread); return view; }, error => {
        const delay = Math.min((this.backoff.get(thread)?.delay ?? 2_500) * 2, 300_000);
        this.backoff.set(thread, { until: Date.now() + delay, delay });
        throw error;
      }).finally(() => this.wakes.delete(thread));
      this.wakes.set(thread, pending);
    }
    const woken = await pending;
    if (!woken.origin || !woken.token) throw new CloudroomError(woken.issue ?? "The sandbox did not start.");
    return { url: woken.origin, token: woken.token };
  }

  private mode: { on: boolean; at: number } | null = null;
  /** Whether the account's new cloud threads get sandboxes. Unknown (website unreachable) keeps the last answer. */
  async forNewThreads(): Promise<boolean> {
    if (this.mode && Date.now() - this.mode.at < RECHECK_MS) return this.mode.on;
    try { this.mode = { on: z.object({ sandboxes: z.boolean() }).parse(await this.call({ action: "mode" })).sandboxes, at: Date.now() }; }
    catch { return this.mode?.on ?? true; }
    return this.mode.on;
  }

  /** What the account's cloud offers, read by the website from a running spare or sandbox. Null until one runs. */
  async capabilities(): Promise<unknown> {
    return z.object({ capabilities: z.unknown() }).parse(await this.call({ action: "capabilities" })).capabilities ?? null;
  }

  wokeSince(thread: string, at: number): boolean { return (this.wakeStarts.get(thread) ?? 0) >= at; }

  startupSince(thread: string, at: number) {
    const startup = this.views.get(thread)?.view.startup;
    const versions = this.wakeHarnesses.get(thread);
    if (!this.wokeSince(thread, at)) return { startup_source: "reuse" as const, sandbox_start_ms: 0, versions };
    return { startup_source: startup?.source ?? null, sandbox_start_ms: startup?.duration_ms ?? null, versions };
  }

  private warmed: { project: string; at: number } | null = null;
  /** Asks the website to keep hot spare sandboxes ready for the next cloud threads, in any project. The project lets it
   *  build that project's template. At most once a minute per project. */
  async warm(project: SandboxProject, trigger: SandboxTrigger = "composer"): Promise<void> {
    if (this.warmed?.project === project.id && Date.now() - this.warmed.at < RECHECK_MS) return;
    this.warmed = { project: project.id, at: Date.now() };
    await this.call({ action: "warm", project: project.id, trigger, ...(project.repository ? { repository: project.repository, folder: project.folder } : {}), harnesses: await macHarnessVersions() });
  }

  /** Forgets what was learned under the last account: sandbox tokens, uploaded logins and config, and its settings. */
  reset(): void {
    this.views.clear();
    this.backoff.clear();
    this.uploaded.clear();
    this.mode = null;
    this.warmed = null;
    this.copiedAt = 0;
    this.configAt = 0;
    this.configDigest = "";
  }

  /** A broken stream or failed request may mean the sandbox went to sleep; look it up again next time. */
  forget(thread: string): void { this.views.delete(thread); }

  async archive(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "archive", thread }); }
  async restore(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "restore", thread }); }
  async remove(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "remove", thread }); }

  /** Saves a login for every sandbox of this account (ADR 0145), skipping values already uploaded. */
  async saveLogin(name: SandboxLogin, value: string, only?: { account: SandboxAccount; signal: AbortSignal }): Promise<void> {
    const digest = createHash("sha256").update(value).digest("hex");
    if (this.uploaded.get(name) === digest) return;
    await this.call({ name, value }, "logins", only);
    this.uploaded.set(name, digest);
  }

  /** The account's Cloud environment, shared with the website: variables (names only) and the setup script. */
  async environment(request: CloudEnvironmentRequest): Promise<CloudEnvironment> {
    return environmentSchema.parse(await this.call(request, "environment"));
  }

  /** Which logins the website holds for this account's sandboxes. */
  async logins(): Promise<Record<SandboxLogin, boolean>> {
    // Missing names mean an older website that cannot hold that login yet.
    return z.object({ claude: z.boolean(), codex: z.boolean(), pi: z.boolean(), github: z.boolean(), cursor: z.boolean().default(false) }).parse(await this.call({ action: "status" }, "logins"));
  }

  private copiedAt = 0;
  get loginsCopied(): boolean { return this.copiedAt > 0; }
  /** Copies this Mac's Codex, Pi, Cursor, and GitHub logins when the user allowed it (ADRs 0128, 0130).
   *  At most once a minute, unless the user just clicked Connect. */
  async copyMacLogins(force = false): Promise<void> {
    if (!force && Date.now() - this.copiedAt < RECHECK_MS) return;
    this.copiedAt = Date.now();
    const piHome = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
    const files = [["codex", codexAuthPath()], ["pi", join(piHome, "auth.json")]] as const;
    // One failed login never stops the others; all failures are reported together.
    const failed: string[] = [];
    const save = (name: "codex" | "pi" | "cursor" | "github", value: string) => this.saveLogin(name, value).catch((error: unknown) => { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); });
    for (const [name, path] of files) {
      const value = await readFile(path, "utf8").catch(() => null);
      if (!value) continue;
      try { JSON.parse(value); } catch { continue; }
      await save(name, value);
    }
    const cursor = await macCursorLogin();
    if (cursor) await save("cursor", cursor);
    const github = await macGithubToken();
    if (github) await save("github", await sandboxGithubLogin(github));
    if (failed.length) throw new CloudroomError(`Some logins could not be copied to cloud sandboxes. ${failed.join("; ")}`);
  }

  private configAt = 0;
  private configDigest = "";
  /** Uploads this Mac's skills and instructions when they change, then pushes them to awake sandboxes. At most once a minute. */
  async copyMacConfig(): Promise<void> {
    if (Date.now() - this.configAt < RECHECK_MS) return;
    this.configAt = Date.now();
    const home = homedir();
    const present = (await Promise.all(CONFIG_PATHS.map(path => stat(join(home, path)).then(() => path, () => null)))).filter((path): path is string => path !== null);
    if (!present.length) return;
    // Links are followed: sandboxes lack the targets. The digest skips file times, since Claude Code re-saves unchanged skills at every start.
    const { stdout } = await promisify(execFile)("tar", ["-c", "-h", "--format", "ustar", "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".DS_Store", "-C", home, ...present],
      { encoding: "buffer", maxBuffer: 4 * CONFIG_LIMIT, timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const digest = contentDigest(stdout);
    if (digest === this.configDigest) return;
    const body = gzipSync(stdout);
    if (body.length > CONFIG_LIMIT) throw new CloudroomError("Your skills are too large to copy to cloud sandboxes.");
    const { url } = z.object({ url: z.string().url() }).parse(await this.call({ action: "upload" }, "config"));
    const response = await fetch(url, { method: "PUT", redirect: "error", headers: { "Content-Type": "application/gzip", "x-upsert": "true" }, body, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new CloudroomError(`Your skills could not be copied to cloud sandboxes (HTTP ${response.status}).`);
    this.configDigest = digest;
    // Awake sandboxes get the change now; sleeping ones apply it when they wake.
    await this.call({ action: "push" }, "config").catch((error: unknown) => {
      throw new CloudroomError(`Your skills were saved, but awake sandboxes could not get them yet: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
