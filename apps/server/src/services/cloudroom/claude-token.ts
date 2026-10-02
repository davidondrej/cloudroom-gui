import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../../errors.js";

const TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{20,})[^A-Za-z0-9_-]/;
export const isClaudeApiKey = (value: string) => /^sk-ant-(?!oat|ort|admin)[A-Za-z0-9_-]{1,1017}$/.test(value);
/** Same lookup as the shell: the native install first, then PATH (npm, nvm, bun), then other common folders. */
export const claudeBinary = () => [join(homedir(), ".local/bin"), ...(process.env.PATH ?? "").split(":").filter(dir => dir.startsWith("/")), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"]
  .map(dir => join(dir, "claude")).find(existsSync);
const failed = (message: string) => new ApiError(409, "claude_token_failed", message);

/** Installs Claude Code with Anthropic's official installer, which needs no terminal and puts it in ~/.local/bin. */
function installClaude(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, signal }, () => {
      const binary = claudeBinary();
      if (binary) resolve(binary);
      else reject(failed("Claude Code could not be installed on this computer. Run `curl -fsSL https://claude.ai/install.sh | bash` in Terminal, then try again."));
    });
  });
}

/** The Mac's Claude plan, such as `max`. The VM needs it to offer plan-only models like Opus 1M. */
export function claudePlan(): Promise<string | undefined> {
  const binary = claudeBinary();
  if (!binary) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(binary, ["auth", "status", "--json"], { timeout: 10_000 }, (error, stdout) => {
      try {
        const plan: unknown = error ? undefined : JSON.parse(stdout).subscriptionType;
        resolve(typeof plan === "string" && /^[a-z_]{1,32}$/.test(plan) ? plan : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * Runs `claude setup-token` on this Mac and returns its one-year token (ADR 0121), installing Claude Code first if needed.
 * The token goes straight to the VM; it never reaches the app UI.
 */
export async function createClaudeToken(signal?: AbortSignal): Promise<string> {
  const binary = claudeBinary() ?? await installClaude(signal);
  // setup-token needs a terminal, and `script` needs a real pipe as input. A wide terminal keeps the token on one line.
  // macOS and Linux `script` take the command differently. `kill 0` ends the `sleep` if Claude exits early.
  const run = `stty cols 1000; exec "$CLAUDE_BIN" setup-token`;
  const tty = process.platform === "linux" ? `/usr/bin/script -q -c '${run}' /dev/null` : `/usr/bin/script -q /dev/null /bin/sh -c '${run}'`;
  // Claude opens the browser itself: only that URL returns to Claude on localhost. The printed URL needs a pasted code.
  const env = { ...process.env, CLAUDE_BIN: binary, SHELL: "/bin/sh" };
  const child = spawn("/bin/sh", ["-c", `sleep 600 | { ${tty}; kill 0; }`], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
  return new Promise((resolve, reject) => {
    let output = "";
    let done = false;
    const finish = (result: string | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { process.kill(-child.pid!); } catch { /* already gone */ }
      if (typeof result === "string") resolve(result);
      else reject(result);
    };
    const abort = () => finish(failed("Claude sign-in was cancelled."));
    const timer = setTimeout(() => finish(failed("Claude sign-in timed out. Try again.")), 5 * 60_000);
    signal?.addEventListener("abort", abort);
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(TOKEN);
      if (match?.[1]) finish(match[1]);
    });
    child.on("error", () => finish(failed("Could not start Claude Code on this computer.")));
    child.on("close", () => finish(failed("Claude sign-in did not finish. Try again.")));
  });
}
