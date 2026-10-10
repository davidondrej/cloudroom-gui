import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import type { HostDaemonContributedEnvEntry } from "@cloudroom/host-daemon-contract";
import { findCliExecutable } from "@cloudroom/process-utils";
import matter from "gray-matter";
import { z } from "zod";
import { hasSupportedFrontmatterDelimiter } from "../skills/injected-skills.js";
import { macClaudeSignedIn } from "./claude-token.js";
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
export type SandboxTrigger = "app_launch" | "app_activity" | "composer" | "thread_typing" | "thread_view";
/** Why a sleeping thread wakes before any work is sent: the user opened it or started typing (ADR 0176). */
export type SandboxWakeTrigger = Extract<SandboxTrigger, "thread_typing" | "thread_view">;
/** Logins the website keeps for every sandbox of an account (ADR 0145). */
export type SandboxLogin = "claude" | "codex" | "pi" | "github" | "cursor" | "opencode";
/** GitHub projects also name their repository and cloud folder, so the website can build a template. */
export type SandboxProject = { id: string; repository: string | null; folder: string };
// A sleeping sandbox is only looked up again after this long; sending work wakes it at once.
const RECHECK_MS = 60_000;
const USAGE_LIMIT = "cloud_usage_limit";
// The Mac's skills and global instructions that sandboxes receive, one way (docs/scopes/sandboxes.md).
const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills"];
const INSTRUCTION_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".pi/agent/AGENTS.md", ".config/opencode/AGENTS.md"];
const CONFIG_LIMIT = 45 * 1024 * 1024;
const codexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
export const hasMacCodexLogin = () => access(codexAuthPath()).then(() => true, () => false);

/** The account's cloud Claude login while this Mac's Claude Code is signed out (ADR 0175). */
let cloudClaude: Record<string, string> | null = null;
/** Variables that sign in Local Claude threads with it. The Mac's Keychain and terminal `claude` stay untouched. */
export const cloudClaudeEnvironment = (): HostDaemonContributedEnvEntry[] => Object.entries(cloudClaude ?? {})
  .map(([name, value]) => ({ name, value, source: { core: "machine-environment" }, reason: "Cloud Claude login" }));
// Same variables as Core's (core/src/runtime/claude.rs): Claude prefers an API key over a token, so pass only one.
function claudeVariables(value: string): Record<string, string> | null {
  const { token, plan, apiKey } = JSON.parse(value) as Record<string, unknown>;
  if (typeof apiKey === "string" && apiKey) return { ANTHROPIC_API_KEY: apiKey };
  if (typeof token !== "string" || !token) return null;
  return { CLAUDE_CODE_OAUTH_TOKEN: token, ...(typeof plan === "string" && plan ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: plan } : {}) };
}

type MacCodexLogin = { child: ChildProcess; url: string | null; error: string | null; done: boolean };
let macCodexLoginRun: MacCodexLogin | null = null;
/** Runs `codex login` on this Mac. Codex opens the default browser and saves the login itself; one run at a time, 10 minutes at most. */
export function startMacCodexLogin(): MacCodexLogin {
  if (macCodexLoginRun && !macCodexLoginRun.done) return macCodexLoginRun;
  const child = spawn(findCliExecutable("codex") ?? "codex", ["login"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
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

/** When the saved Codex access token stops working, in milliseconds, or null when the login has none. */
function codexTokenExpiry(text: string): number | null {
  try {
    const token = (JSON.parse(text) as { tokens?: { access_token?: unknown } }).tokens?.access_token;
    const exp = typeof token === "string" ? (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: unknown }).exp : null;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch { return null; }
}
/** True only when this Mac's Codex login is dead: its access token is past expiry and Codex itself could not renew it.
 *  A valid token, an offline Mac, or any other failure counts as signed in, so working logins behave as before. */
export async function macCodexLoginExpired(): Promise<boolean> {
  const expiry = codexTokenExpiry(await readFile(codexAuthPath(), "utf8").catch(() => ""));
  if (expiry === null || Date.now() < expiry) return false;
  return new Promise(resolve => {
    const child = spawn(findCliExecutable("codex") ?? "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], timeout: 20_000 });
    const end = (expired: boolean) => { resolve(expired); child.kill(); };
    const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on("error", () => end(false));
    child.on("error", () => end(false));
    child.on("exit", () => end(false));
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
        let message: { id?: unknown; result?: { account?: unknown; requiresOpenaiAuth?: unknown } };
        try { message = JSON.parse(buffer.slice(0, at)); } catch { continue; }
        if (message.id === 1) {
          send({ method: "initialized" });
          // Codex renews the token itself and saves it; a rejected renewal reports no account.
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        }
        if (message.id === 2) end(message.result?.account === null && message.result.requiresOpenaiAuth === true);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "cloudroom", version: "1" } } });
  });
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

/** OpenCode 1 keeps its logins in auth.json. OpenCode 2 keeps them in its database and exports them as a JSON array,
 *  kept byte for byte so a sandbox's unchanged export matches it (ADR 0172). */
async function macOpencodeLogin(): Promise<string | null> {
  const binary = findCliExecutable("opencode");
  const version = (await macHarnessVersions()).opencode;
  const value = binary && version && !version.startsWith("1.")
    ? (await promisify(execFile)(binary, ["auth", "export", "--standalone"], { timeout: 20_000 }).catch(() => null))?.stdout ?? null
    : await readFile(join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/auth.json"), "utf8").catch(() => null);
  try { const parsed: unknown = value && JSON.parse(value); return parsed && (!Array.isArray(parsed) || parsed.length) ? value : null; } catch { return null; }
}

/** This computer's Cursor CLI login in the file shape the CLI keeps on Linux, or null when Cursor is signed out here.
 *  On macOS the CLI stores it in the Keychain through /usr/bin/security, so reading it the same way shows no macOS prompt. */
export async function macCursorLogin(): Promise<string | null> {
  const login = (accessToken: unknown, refreshToken: unknown) =>
    typeof accessToken === "string" && accessToken && typeof refreshToken === "string" && refreshToken ? JSON.stringify({ accessToken, refreshToken }, null, 2) : null;
  if (process.platform === "linux") {
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor", "auth.json");
    const saved = await readFile(file, "utf8").then(text => JSON.parse(text) as { accessToken?: unknown; refreshToken?: unknown } | null, () => null);
    return login(saved?.accessToken, saved?.refreshToken);
  }
  if (process.platform !== "darwin") return null;
  const read = (service: string) => promisify(execFile)("/usr/bin/security", ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"], { timeout: 10_000 })
    .then(result => result.stdout.trim(), () => "");
  const [accessToken, refreshToken] = await Promise.all([read("cursor-access-token"), read("cursor-refresh-token")]);
  return login(accessToken, refreshToken);
}

const output = (command: string, args: string[]) => promisify(execFile)(command, args, { timeout: 10_000 }).then(result => result.stdout.trim(), () => "");
export const githubAccountSchema = z.object({ login: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() });
export type GithubAccount = z.infer<typeof githubAccountSchema>;
/** This Mac's GitHub CLI token, or "" when `gh` is missing or signed out. */
export const macGithubToken = () => output("gh", ["auth", "token", "--hostname", "github.com"]);
/** The GitHub login sandboxes receive. Agents commit as the user, with the Mac's Git identity. */
export async function sandboxGithubLogin(token: string): Promise<string> {
  const [name, email] = await Promise.all([output("git", ["config", "--global", "user.name"]), output("git", ["config", "--global", "user.email"])]);
  return JSON.stringify({ token, ...(name ? { name } : {}), ...(email ? { email } : {}) });
}

const environmentSchema = z.object({
  variables: z.array(z.object({ name: z.string(), hint: z.string() })), setup: z.string(),
  repos: z.array(z.string()).default([]), mcp: z.array(z.string()).default([]), available: z.array(z.string()).optional(), pushed: z.record(z.string(), z.number()).optional(), login: z.string().optional(),
});
export type CloudEnvironment = z.infer<typeof environmentSchema>;
export const cloudEnvironmentRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({ action: z.literal("set"), variables: z.record(z.string(), z.string()) }),
  z.object({ action: z.literal("remove"), name: z.string().min(1) }),
  z.object({ action: z.literal("setup"), setup: z.string() }),
  z.object({ action: z.literal("addRepo"), repo: z.string().min(1) }),
  z.object({ action: z.literal("removeRepo"), repo: z.string().min(1) }),
  z.object({ action: z.literal("githubRepos") }),
]);
/** One MCP server in Claude Code's format, as the website stores it for sandboxes. */
type McpServer = { type: "stdio"; command: string; args: string[]; env: Record<string, string> } | { type: "http" | "sse"; url: string; headers: Record<string, string> };
type McpChange = { action: "mcp"; servers: Record<string, McpServer>; remove: string[] };
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

export type MacSkill = { name: string; description: string; paths: string[] };
/** This Mac's skills: folders with a SKILL.md in a harness skill root. One name may sit in several roots. */
export async function macSkills(): Promise<MacSkill[]> {
  const home = homedir();
  const found = new Map<string, MacSkill>();
  for (const root of SKILL_ROOTS) {
    for (const name of await readdir(join(home, root)).catch(() => [])) {
      const file = join(home, root, name, "SKILL.md");
      if (name.startsWith(".") || !await stat(file).then(info => info.isFile(), () => false)) continue;
      const skill = found.get(name) ?? { name, paths: [], description: await readFile(file, "utf8").then(text => hasSupportedFrontmatterDelimiter(text) ? String(matter(text).data.description ?? "").replace(/\s+/g, " ").trim() : "", () => "") };
      skill.paths.push(`${root}/${name}`);
      found.set(name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type MacMcpServer = { name: string; server: McpServer | null };
const texts = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
// Paths that exist only on this Mac, and servers running on it.
const MAC_PATH = /(^|[\s=:'"])(~\/|\/Users\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/homebrew\/|\/private\/)/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;
const portable = (server: McpServer) => server.type === "stdio"
  ? !server.command.includes("/") && ![...server.args, ...Object.values(server.env)].some(text => MAC_PATH.test(text))
  : !LOCAL_URL.test(server.url);
/** Claude Code's user-scope MCP servers; `${VAR}` stays as typed and is filled in the sandbox from the API keys. */
function claudeServer(value: Record<string, unknown>): McpServer | null {
  const type = value.type ?? (value.command ? "stdio" : undefined);
  if (type === "stdio" && typeof value.command === "string") return { type, command: value.command, args: list(value.args), env: texts(value.env) };
  if ((type === "http" || type === "sse") && typeof value.url === "string") return { type, url: value.url, headers: texts(value.headers) };
  return null;
}
/** A server from `codex mcp list --json`. Variables Codex reads from the environment become `${VAR}`. */
function codexServer(transport: Record<string, unknown>): McpServer | null {
  const fromEnvironment = (names: string[]) => Object.fromEntries(names.map(name => [name, `\${${name}}`]));
  if (transport.type === "stdio" && typeof transport.command === "string" && !transport.cwd) {
    const forwarded = Array.isArray(transport.env_vars) ? transport.env_vars.map(item => typeof item === "string" ? item : (item as { name?: unknown })?.name).filter((name): name is string => typeof name === "string") : [];
    return { type: "stdio", command: transport.command, args: list(transport.args), env: { ...fromEnvironment(forwarded), ...texts(transport.env) } };
  }
  if (transport.type === "streamable_http" && typeof transport.url === "string") {
    const headers = { ...texts(transport.http_headers), ...Object.fromEntries(Object.entries(texts(transport.env_http_headers)).map(([header, name]) => [header, `\${${name}}`])) };
    if (typeof transport.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${transport.bearer_token_env_var}}`;
    return { type: "http", url: transport.url, headers };
  }
  return null;
}
/** This Mac's MCP servers from Claude Code (user scope) and Codex; Claude's wins on a name clash. `server` is null when
 *  it only works on this Mac. An older Codex without `mcp list --json` just adds none. */
export async function macMcpServers(): Promise<MacMcpServer[]> {
  const found = new Map<string, McpServer | null>();
  const add = (name: string, server: McpServer | null) => {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && name !== "cloudroom" && !found.has(name)) found.set(name, server && portable(server) ? server : null);
  };
  const claudeFile = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  const claude = await readFile(claudeFile, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; });
  const servers: unknown = (JSON.parse(claude) as { mcpServers?: unknown }).mcpServers;
  for (const [name, value] of Object.entries(servers && typeof servers === "object" ? servers : {})) add(name, value && typeof value === "object" ? claudeServer(value as Record<string, unknown>) : null);
  const codex = findCliExecutable("codex");
  if (codex) {
    const listed = await promisify(execFile)(codex, ["mcp", "list", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => z.array(z.object({ name: z.string(), enabled: z.boolean().default(true), transport: z.record(z.string(), z.unknown()) })).parse(JSON.parse(stdout)), () => []);
    for (const { name, enabled, transport } of listed) if (enabled) add(name, codexServer(transport));
  }
  return [...found].map(([name, server]) => ({ name, server })).sort((a, b) => a.name.localeCompare(b.name));
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
  private readonly lookups = new Map<string, Promise<View>>();
  private readonly wakeStarts = new Map<string, number>();
  private readonly wakeHarnesses = new Map<string, Awaited<ReturnType<typeof macHarnessVersions>>>();
  // After a failed wake, wait before asking again. Network and server errors retry every 2 s three times first;
  // then 5 s, doubling to 5 minutes. Delivery retries every tick otherwise.
  private readonly backoff = new Map<string, { until: number; delay: number; tries: number }>();
  private uploaded = new Map<string, string>();
  /** `woke` runs after each wake, so the Mac helper lists the new sandbox now instead of at its next minute check. */
  constructor(readonly account: () => Promise<SandboxAccount | null>, private readonly woke: () => void = () => {}) {}

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
    const value = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    if (!response.ok) {
      const message = typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`;
      if (response.status === 409 && /busy/i.test(message)) throw new CloudroomConnectionError(message);
      const code = typeof value.code === "string" ? value.code : null;
      if (code === USAGE_LIMIT) this.limit = { on: true, at: Date.now() };
      throw new CloudroomError(message, response.status >= 500 ? null : response.status, code);
    }
    return value;
  }

  private limit: { on: boolean; at: number } | null = null;
  private checkingLimit = false;
  usageLimited(): boolean {
    if (!this.checkingLimit && (!this.limit || Date.now() - this.limit.at > RECHECK_MS)) {
      this.checkingLimit = true;
      void this.checkMode().catch(() => { this.limit = { on: this.limit?.on ?? false, at: Date.now() }; }).finally(() => { this.checkingLimit = false; });
    }
    return this.limit?.on ?? false;
  }

  /** Reports today as active, with finished days' active minutes. True when the website saved the minutes. */
  async active(minutes: Record<string, number>): Promise<boolean> {
    const value = await this.call(Object.keys(minutes).length ? { minutes } : {}, "active");
    return z.object({ minutes: z.boolean().optional() }).parse(value).minutes !== false;
  }

  async requestMoreUsage() {
    return z.object({ sent: z.boolean() }).parse(await this.call({}, "usage-request"));
  }

  /** The member's friend invite codes. `create` makes one more, up to 3 for life (ADR 0169). `waiting` is the waitlist size, or null. */
  async invites(action: "list" | "create") {
    const value = await this.call({ action }, "invites");
    const joined = z.object({ name: z.string().nullable(), at: z.string() }).optional();
    return z.object({ codes: z.array(z.object({ code: z.string(), used: z.boolean(), url: z.string().optional(), joined })), left: z.number(), created: z.string().nullable(), waiting: z.number().nullable().default(null) }).parse(value);
  }

  /** Whether to remind this member to book an onboarding call, and the booking link (docs/scopes/onboarding-calls.md). */
  async onboardingCall() {
    return z.object({ due: z.boolean(), url: z.string().url().optional() }).parse(await this.call({}, "onboarding-call"));
  }

  /** Whether the website judges a generated thread title too vague to keep, at the user's sensitivity (2–5). */
  async titleTooVague(check: { title: string; firstMessage: string; agentReply: string; sensitivity: number }): Promise<boolean> {
    const value = await this.call({ ...check, sensitivity: String(check.sensitivity) }, "thread-title");
    return z.object({ rename: z.boolean() }).parse(value).rename;
  }

  /** Onboarding failures and the install ID link, saved with this account (ADR 0201). */
  setupEvent(event: string, context: Record<string, unknown>): Promise<unknown> {
    return this.call({ event, context }, "setup-events");
  }

  /** Backup voice transcription on the website, or null when signed out. */
  async transcribe(file: File): Promise<string | null> {
    const account = await this.account();
    if (!account) return null;
    const body = new FormData();
    body.set("file", file, file.name);
    const response = await fetch(`${account.website}/api/desktop/transcribe`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(110_000),
      headers: { Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
      body,
    });
    const value = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
    if (!response.ok || typeof value.text !== "string") throw new CloudroomError(typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`);
    return value.text;
  }

  /** Thread share links on the website (docs/scopes/thread-share-links.md): save, stop, or open one. */
  async shares(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "shares");
  }

  private remember(view: View): View {
    this.views.set(view.thread, { view, at: Date.now() });
    return view;
  }

  /** The thread's Core, or null while it sleeps. `wake` starts it; only callers with work to send pass true. */
  async connection(thread: string, project: SandboxProject, wake: boolean, trigger?: SandboxWakeTrigger): Promise<SandboxConnection | null> {
    const cached = this.views.get(thread);
    let view = cached?.view;
    const place = { thread, project: project.id, ...(project.repository ? { repository: project.repository, folder: project.folder } : {}) };
    // A wake registers too, so only lookups need their own call. Every thread in a sandbox shares one lookup.
    if (!wake && (!view || (view.state !== "awake" && Date.now() - cached!.at > RECHECK_MS))) {
      let lookup = this.lookups.get(thread);
      if (!lookup) {
        lookup = this.call({ action: "register", ...place }).then(value => this.remember(viewSchema.parse(value))).finally(() => this.lookups.delete(thread));
        this.lookups.set(thread, lookup);
      }
      view = await lookup;
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
        return this.call({ action: "wake", ...place, harnesses, ...(this.backoff.has(thread) ? { trigger: "retry" } : trigger ? { trigger } : {}) });
      }).then(value => this.remember(viewSchema.parse(value))).then(view => {
        this.woke();
        this.backoff.delete(thread);
        if (this.limit?.on) this.limit = { on: false, at: Date.now() };
        return view;
      }, error => {
        const previous = this.backoff.get(thread);
        const tries = (previous?.tries ?? 0) + 1;
        // A 4xx answer (say, usage limit) won't fix itself in 2 s, so it backs off at once.
        const quick = tries <= 3 && error instanceof CloudroomError && error.status === null;
        const delay = quick ? 2_000 : Math.min(Math.max(previous?.delay ?? 0, 2_500) * 2, 300_000);
        this.backoff.set(thread, { until: Date.now() + delay, delay, tries });
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
    try { return await this.checkMode(); }
    catch { return this.mode?.on ?? true; }
  }

  private async checkMode(): Promise<boolean> {
    const value = z.object({ sandboxes: z.boolean(), limited: z.boolean().default(false), small_disk: z.boolean().default(false) }).parse(await this.call({ action: "mode" }));
    this.mode = { on: value.sandboxes, at: Date.now() };
    this.limit = { on: value.limited, at: Date.now() };
    this.small = value.small_disk;
    return value.sandboxes;
  }

  private small = false;
  /** Free accounts get 10 GB sandboxes, so a full disk is their moment to upgrade (ADR 0206). Refreshed with usageLimited(). */
  smallDisk(): boolean { return this.small; }

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
    this.limit = null;
    this.warmed = null;
    this.copiedAt = 0;
    this.pulledAt = 0;
    cloudClaude = null;
    this.configAt = 0;
    this.configDigest = "";
    this.configIssue = null;
  }

  /** A broken stream or failed request may mean the sandbox went to sleep; look it up again next time. */
  forget(thread: string): void { this.views.delete(thread); }
  coolingDown(thread: string | null): boolean { return Boolean(thread && (this.backoff.get(thread)?.until ?? 0) > Date.now()); }

  /** Saves a thread's title, project name, and Core session ID on the website (ADR 0182). */
  async label(thread: string, label: { title: string | null; project_name: string | null; session: string }): Promise<void> {
    await this.call({ action: "label", thread, ...label });
  }
  async archive(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "archive", thread }); }
  /** An unarchive right after an archive finds the sandbox busy until the archive ends (up to ~60 s), so keep trying. */
  async restore(thread: string): Promise<void> {
    this.forget(thread);
    this.backoff.delete(thread);
    for (let tries = 1; ; tries++) {
      try { return void await this.call({ action: "restore", thread }); }
      catch (error) { if (!(error instanceof CloudroomConnectionError) || tries >= 30) throw error; }
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  }
  async remove(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "remove", thread }); }

  /** Saves a login for every sandbox of this account (ADR 0145), skipping values already uploaded. */
  async saveLogin(name: SandboxLogin, value: string, only?: { account: SandboxAccount; signal: AbortSignal }): Promise<void> {
    const digest = createHash("sha256").update(value).digest("hex");
    if (this.uploaded.get(name) === digest) return;
    await this.call({ name, value }, "logins", only);
    this.uploaded.set(name, digest);
  }

  /** The account's Cloud environment, shared with the website: variables (names only), repos, and the setup script. */
  async environment(request: CloudEnvironmentRequest | McpChange): Promise<CloudEnvironment> {
    const environment = environmentSchema.parse(await this.call(request, "environment"));
    this.mcpNames = environment.mcp;
    return environment;
  }

  async autoDelete(body: { action: "get" | "deleted" } | { action: "set"; days: number | null }): Promise<unknown> {
    return this.call(body, "auto-delete");
  }

  /** Cloud automations live on the website, which runs them while this Mac is off (ADR 0212). */
  async automations(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "automations");
  }

  /** MCP servers in the cloud, as of the last Cloud environment answer. */
  private mcpNames: string[] | null = null;
  private mcpAt = 0;
  private mcpDigest = "";
  /** Adds MCP servers from this Mac to the Cloud environment, or removes them. */
  async setMacMcp(names: string[], cloud: boolean): Promise<CloudEnvironment> {
    if (!cloud) return this.environment({ action: "mcp", servers: {}, remove: names });
    const servers = Object.fromEntries((await macMcpServers()).flatMap(({ name, server }) => server && names.includes(name) ? [[name, server]] : []));
    if (!Object.keys(servers).length) throw new CloudroomError("Those MCP servers only work on this Mac.", 400);
    return this.environment({ action: "mcp", servers, remove: [] });
  }
  /** Copies edits to this Mac's MCP servers, such as a new key, to the ones already in the cloud. At most once a minute;
   *  never removes one, so a server missing for a moment stays in the cloud. */
  async refreshMacMcp(): Promise<void> {
    if (Date.now() - this.mcpAt < RECHECK_MS) return;
    this.mcpAt = Date.now();
    const names = this.mcpNames ?? (await this.environment({ action: "get" })).mcp;
    if (!names.length) return;
    const servers = Object.fromEntries((await macMcpServers()).flatMap(({ name, server }) => server && names.includes(name) ? [[name, server]] : []));
    const digest = createHash("sha256").update(JSON.stringify(servers)).digest("hex");
    if (digest === this.mcpDigest || !Object.keys(servers).length) return;
    await this.environment({ action: "mcp", servers, remove: [] });
    this.mcpDigest = digest;
  }

  /** Which logins the website holds for this account's sandboxes. */
  async logins(): Promise<Record<SandboxLogin, boolean>> {
    // Missing names mean an older website that cannot hold that login yet.
    return z.object({ claude: z.boolean(), codex: z.boolean(), pi: z.boolean(), github: z.boolean(), cursor: z.boolean().default(false), opencode: z.boolean().default(false) }).parse(await this.call({ action: "status" }, "logins"));
  }

  /** Who the account's GitHub login belongs to, or null when GitHub or an older website can't tell. */
  async githubAccount(): Promise<GithubAccount | null> {
    return z.object({ account: githubAccountSchema.nullable() }).parse(await this.call({ action: "github" }, "logins")).account;
  }

  /** Forgets the account's GitHub login for every sandbox. */
  async removeGithubLogin(): Promise<void> {
    await this.call({ action: "remove", name: "github" }, "logins");
    this.uploaded.delete("github");
  }

  private copiedAt = 0;
  get loginsCopied(): boolean { return this.copiedAt > 0; }
  /** Copies this Mac's Codex, Pi, opencode, Cursor, and GitHub logins when the user allowed it (ADRs 0128, 0130).
   *  At most once a minute, unless the user just clicked Connect. `github` is false after the user picked another GitHub account. */
  async copyMacLogins(force = false, github = true): Promise<void> {
    if (!force && Date.now() - this.copiedAt < RECHECK_MS) return;
    this.copiedAt = Date.now();
    const piHome = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
    const files = [["codex", codexAuthPath()], ["pi", join(piHome, "auth.json")]] as const;
    // One failed login never stops the others; all failures are reported together.
    const failed: string[] = [];
    const save = (name: "codex" | "pi" | "opencode" | "cursor" | "github", value: string) => this.saveLogin(name, value).catch((error: unknown) => { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); });
    for (const [name, path] of files) {
      const value = await readFile(path, "utf8").catch(() => null);
      if (!value) continue;
      try { JSON.parse(value); } catch { continue; }
      await save(name, value);
    }
    const opencode = await macOpencodeLogin();
    if (opencode) await save("opencode", opencode);
    const cursor = await macCursorLogin();
    if (cursor) await save("cursor", cursor);
    const githubToken = github ? await macGithubToken() : "";
    if (githubToken) await save("github", await sandboxGithubLogin(githubToken));
    if (failed.length) throw new CloudroomError(`Some logins could not be copied to cloud sandboxes. ${failed.join("; ")}`);
  }

  private pulledAt = 0;
  /** Fills in the Claude and Codex logins this Mac lacks from the account's cloud logins (ADR 0175).
   *  At most once a minute, unless a cloud login just changed. */
  async copyCloudLogins(force = false): Promise<void> {
    if (!force && Date.now() - this.pulledAt < RECHECK_MS) return;
    this.pulledAt = Date.now();
    const [claudeHere, codexHere] = await Promise.all([macClaudeSignedIn(), hasMacCodexLogin()]);
    if (claudeHere) cloudClaude = null;
    if (claudeHere !== false && codexHere) return;
    const saved = await this.logins();
    if (claudeHere === false) {
      const value = saved.claude ? await this.cloudLogin("claude") : null;
      cloudClaude = value ? claudeVariables(value) : null;
    }
    if (!codexHere && saved.codex) {
      const value = await this.cloudLogin("codex");
      if (!value) return;
      await mkdir(dirname(codexAuthPath()), { recursive: true, mode: 0o700 });
      // `wx` never replaces a login Codex saved meanwhile.
      await writeFile(codexAuthPath(), value, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      this.uploaded.set("codex", createHash("sha256").update(value).digest("hex"));
    }
  }

  private async cloudLogin(name: "claude" | "codex"): Promise<string | null> {
    return z.object({ value: z.string().nullable() }).parse(await this.call({ action: "get", name }, "logins")).value;
  }

  private configAt = 0;
  private configDigest = "";
  private configRun: Promise<unknown> = Promise.resolve();
  /** Why the last skills upload failed, until one succeeds. */
  configIssue: string | null = null;
  /** Uploads this Mac's skills and instructions when they change, then pushes them to awake sandboxes. At most once a minute,
   *  unless the user just changed which skills the cloud gets. `inCloud` picks the skills by name. */
  copyMacConfig(inCloud: (name: string) => boolean, force = false): Promise<void> {
    // One upload at a time, so an older skill choice never lands after a newer one.
    const run = this.configRun.then(() => this.uploadConfig(inCloud, force)).catch((error: unknown) => {
      this.configIssue = error instanceof Error ? error.message : String(error);
      throw error;
    });
    this.configRun = run.catch(() => {});
    return run;
  }

  private async uploadConfig(inCloud: (name: string) => boolean, force: boolean): Promise<void> {
    if (!force && Date.now() - this.configAt < RECHECK_MS) return;
    this.configAt = Date.now();
    const home = homedir();
    const instructions = (await Promise.all(INSTRUCTION_FILES.map(path => stat(join(home, path)).then(() => path, () => null)))).filter((path): path is string => path !== null);
    const present = [...(await macSkills()).filter(skill => inCloud(skill.name)).flatMap(skill => skill.paths), ...instructions];
    // Links are followed: sandboxes lack the targets. The digest skips file times, since Claude Code re-saves unchanged skills at every start.
    // Nothing chosen still uploads an empty archive, so new sandboxes stop getting the old skills.
    const tar = present.length ? (await promisify(execFile)("tar", ["-c", "-h", "--format", "ustar", "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".DS_Store", "-C", home, ...present],
      { encoding: "buffer", maxBuffer: 4 * CONFIG_LIMIT, timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } })).stdout : Buffer.alloc(1024);
    const digest = contentDigest(tar);
    if (digest === this.configDigest) { this.configIssue = null; return; }
    const body = gzipSync(tar);
    if (body.length > CONFIG_LIMIT) throw new CloudroomError("Your skills are too large to copy to cloud sandboxes.");
    const { url } = z.object({ url: z.string().url() }).parse(await this.call({ action: "upload" }, "config"));
    const response = await fetch(url, { method: "PUT", redirect: "error", headers: { "Content-Type": "application/gzip", "x-upsert": "true" }, body, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new CloudroomError(`Your skills could not be copied to cloud sandboxes (HTTP ${response.status}).`);
    this.configDigest = digest;
    this.configIssue = null;
    // Awake sandboxes get the change now; sleeping ones apply it when they wake.
    await this.call({ action: "push" }, "config").catch((error: unknown) => {
      throw new CloudroomError(`Your skills were saved, but awake sandboxes could not get them yet: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
