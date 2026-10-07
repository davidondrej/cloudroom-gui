import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findCliExecutable } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";

const TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{20,})[^A-Za-z0-9_-]/;
export const isClaudeApiKey = (value: string) => /^sk-ant-(?!oat|ort|admin)[A-Za-z0-9_-]{1,1017}$/.test(value);
/** The Claude Code that Local threads run: PATH first, then common install folders. */
export const claudeBinary = () => findCliExecutable("claude") ?? undefined;
const failed = (message: string) => new ApiError(409, "claude_token_failed", message);

const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
let installing: Promise<string> | null = null;
/** Installs Claude Code with Anthropic's official installer, which needs no terminal and puts it in ~/.local/bin. One install at a time. */
function installClaude(): Promise<string> {
  installing ??= new Promise<string>((resolve, reject) => {
    execFile("/bin/bash", ["-c", INSTALL], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const binary = claudeBinary();
      if (binary) return resolve(binary);
      const reason = stderr.trim().split("\n").at(-1) || (error?.killed ? "the download took longer than 10 minutes" : error?.message);
      reject(failed(`Claude Code could not be installed${reason ? `: ${reason}` : ""}. Run \`${INSTALL}\` in Terminal, then try again.`));
    });
  }).finally(() => { installing = null; });
  return installing;
}

/**
 * Connecting Claude means the user wants Claude Code in Cloudroom, so a missing CLI is installed silently (ADR 0193).
 * With the Claude desktop app's copy, sign-in goes ahead and the install runs in the background.
 */
export async function ensureClaudeCli(onError: (error: unknown) => void): Promise<void> {
  if (claudeBinary()) return;
  const install = installClaude();
  if (!desktopClaude()) await install;
  else void install.catch(onError);
}

/** The Claude Code that the Claude desktop app keeps for itself: its newest fully downloaded version. */
function desktopClaude(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const root = join(homedir(), "Library/Application Support/Claude/claude-code");
  let versions: string[];
  try { versions = readdirSync(root); } catch { return undefined; }
  for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const binary = join(root, version, "claude.app/Contents/MacOS/claude");
    try {
      if (!existsSync(join(root, version, ".verified"))) continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch { /* incomplete version */ }
  }
  return undefined;
}

/** `claude auth status` on this Mac, or null when Claude Code is missing or the check fails. */
function claudeAuthStatus(): Promise<{ loggedIn?: unknown; subscriptionType?: unknown } | null> {
  const binary = claudeBinary();
  if (!binary) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Signed out exits 1 with valid JSON.
    execFile(binary, ["auth", "status", "--json"], { timeout: 10_000 }, (_error, stdout) => {
      try { resolve(JSON.parse(stdout) ?? null); } catch { resolve(null); }
    });
  });
}

/** The Mac's Claude plan, such as `max`. The VM needs it to offer plan-only models like Opus 1M. */
export async function claudePlan(): Promise<string | undefined> {
  const status = await claudeAuthStatus();
  const plan = status?.loggedIn === true ? status.subscriptionType : undefined;
  return typeof plan === "string" && /^[a-z_]{1,32}$/.test(plan) ? plan : undefined;
}

/** Whether Claude Code on this Mac has its own login; null when that can't be checked. */
export async function macClaudeSignedIn(): Promise<boolean | null> {
  const status = await claudeAuthStatus();
  return typeof status?.loggedIn === "boolean" ? status.loggedIn : null;
}

const isSignInUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ["https://claude.ai", "https://claude.com", "https://platform.claude.com"].includes(url.origin) && ["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname);
  } catch { return false; }
};

// Claude Code 2.1.292+ skips characters already on screen, so its token is only whole on the rebuilt screen.
const skipsShownText = (text: string) => {
  const [major = 0, minor = 0, patch = 0] = text.match(/Code ?v(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [];
  return major * 1e12 + minor * 1e6 + patch >= 2e12 + 1e6 + 292;
};
function screenText(output: string): string {
  const rows: string[][] = [];
  let row = 0, col = 0;
  for (const [, params = "", command, char] of output.matchAll(/\x1b\[([0-9;?<>=]*)([A-Za-z@`])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+]?[^\[\]]|([^])/gu)) {
    const n = Number(params) || 1;
    if (command === "G") col = n - 1;
    else if (command === "C") col += n;
    else if (command === "D") col = Math.max(0, col - n);
    else if (command === "A") row = Math.max(0, row - n);
    else if (command === "B") row += n;
    else if (command === "K") rows[row] = params === "2" ? [] : (rows[row] ?? []).slice(0, col);
    else if (char === "\r") col = 0;
    else if (char === "\n") row++;
    else if (char && char >= " ") (rows[row] ??= [])[col++] = char;
  }
  return Array.from(rows, line => Array.from(line ?? [], cell => cell ?? " ").join("")).join("\n");
}

interface TokenRun { id: string; url: string | null; error: string | null; done: boolean; stop: () => void }
let tokenRun: TokenRun | null = null;

/**
 * Runs `claude setup-token` on this Mac for a one-year token (ADR 0121), using the Claude desktop app's copy when no CLI is installed.
 * `BROWSER` hands us Claude's sign-in link, so the app opens it itself. The token goes straight to `save`; it never reaches the UI.
 */
function runSetupToken(id: string, save: (token: string) => Promise<unknown>): TokenRun {
  const binary = claudeBinary() ?? desktopClaude();
  if (!binary) throw new ApiError(409, "claude_missing", "Claude Code isn't installed on this Mac.");
  const dir = mkdtempSync(join(tmpdir(), "cloudroom-claude-"));
  const browser = join(dir, "open");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > "$0.url"\n`, { mode: 0o700 });
  // setup-token needs a terminal, and `script` needs a real pipe as input. A wide terminal keeps the token on one line.
  // macOS and Linux `script` take the command differently. `kill 0` ends the `sleep` if Claude exits early.
  const command = `stty cols 1000; exec "$CLAUDE_BIN" setup-token`;
  const tty = process.platform === "linux" ? `/usr/bin/script -q -c '${command}' /dev/null` : `/usr/bin/script -q /dev/null /bin/sh -c '${command}'`;
  const env = { ...process.env, CLAUDE_BIN: binary, SHELL: "/bin/sh", BROWSER: browser };
  const child = spawn("/bin/sh", ["-c", `sleep 600 | { ${tty}; kill 0; }`], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
  const stopChild = () => { try { process.kill(-child.pid!); } catch { /* already gone */ } };
  const run: TokenRun = { id, url: null, error: null, done: false, stop: () => finish("Claude sign-in was cancelled.") };
  let output = "";
  let saving = false;
  const finish = (error: string | null) => {
    if (run.done) return;
    Object.assign(run, { done: true, error });
    clearTimeout(timer);
    clearInterval(poll);
    stopChild();
    rmSync(dir, { recursive: true, force: true });
  };
  const timer = setTimeout(() => finish("Claude sign-in timed out. Try again."), 5 * 60_000);
  const poll = setInterval(() => {
    const url = (() => { try { return readFileSync(`${browser}.url`, "utf8").trim(); } catch { return ""; } })();
    if (isSignInUrl(url)) { run.url = url; clearInterval(poll); }
  }, 250);
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65536);
    const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const token = (skipsShownText(text) ? screenText(output) : text).match(TOKEN)?.[1];
    if (!token || saving) return;
    saving = true;
    stopChild();
    save(token).then(() => finish(null), (error: unknown) => finish(error instanceof Error ? error.message : String(error)));
  });
  child.on("error", () => finish("Could not start Claude Code on this computer."));
  child.on("close", () => { if (!saving) finish("Claude sign-in did not finish. Try again."); });
  return run;
}

/** Starts Claude sign-in (or joins the running one) and waits briefly for its sign-in link. */
export async function startClaudeToken(id: string, save: (token: string) => Promise<unknown>): Promise<void> {
  if (!tokenRun || tokenRun.done) tokenRun = runSetupToken(id, save);
  const run = tokenRun;
  for (let waited = 0; !run.url && !run.done && waited < 15_000; waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
}

/** Stops the running sign-in; false when none was running. */
export function cancelClaudeToken(): boolean {
  const run = tokenRun;
  tokenRun = null;
  run?.stop();
  return Boolean(run);
}

/** Shows a running sign-in as `waiting` with its link. A finished run is reported once, then forgotten. */
export function withClaudeTokenRun<T extends { state: string; message: string | null; login_id: string | null; verification_url: string | null }>(status: T): T {
  const run = tokenRun;
  if (!run) return status;
  if (!run.done) return { ...status, state: "waiting", message: null, login_id: run.id, verification_url: run.url };
  tokenRun = null;
  return run.error ? { ...status, state: "error", message: run.error } : status;
}
