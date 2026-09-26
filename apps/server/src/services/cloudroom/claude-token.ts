import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CloudroomError } from "./client.js";

const TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{20,})[^A-Za-z0-9_-]/;
const SIGN_IN = /(https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com)\/(?:cai\/)?oauth\/authorize\?[^\s\x07\x1b]+)[\s\x07\x1b]/;
export const claudeBinary = () => [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(existsSync);

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
 * Runs `claude setup-token` on this Mac and returns its one-year token (ADR 0121).
 * The token goes straight to the VM; it never reaches the app UI.
 */
export function createClaudeToken(signal?: AbortSignal): Promise<string> {
  const binary = claudeBinary();
  if (!binary) return Promise.reject(new CloudroomError("Install Claude Code on this computer first."));
  // setup-token needs a terminal, and `script` needs a real pipe as input. A wide terminal keeps the token on one line.
  // macOS and Linux `script` take the command differently. `kill 0` ends the `sleep` if Claude exits early.
  const run = `stty cols 1000; exec "$CLAUDE_BIN" setup-token`;
  const tty = process.platform === "linux" ? `/usr/bin/script -q -c '${run}' /dev/null` : `/usr/bin/script -q /dev/null /bin/sh -c '${run}'`;
  // BROWSER=true stops Claude from opening the page, so the app opens it once in the default browser.
  const env = { ...process.env, CLAUDE_BIN: binary, SHELL: "/bin/sh", BROWSER: "true" };
  const child = spawn("/bin/sh", ["-c", `sleep 600 | { ${tty}; kill 0; }`], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
  return new Promise((resolve, reject) => {
    let output = "";
    let done = false;
    let opened = false;
    const finish = (result: string | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { process.kill(-child.pid!); } catch { /* already gone */ }
      if (typeof result === "string") resolve(result);
      else reject(result);
    };
    const abort = () => finish(new CloudroomError("Claude sign-in was cancelled."));
    const timer = setTimeout(() => finish(new CloudroomError("Claude sign-in timed out. Try again.")), 5 * 60_000);
    signal?.addEventListener("abort", abort);
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const url = text.match(SIGN_IN)?.[1];
      if (url && !opened) {
        opened = true;
        openInBrowser(url);
      }
      const match = text.match(TOKEN);
      if (match?.[1]) finish(match[1]);
    });
    child.on("error", () => finish(new CloudroomError("Could not start Claude Code on this computer.")));
    child.on("close", () => finish(new CloudroomError("Claude sign-in did not finish. Try again.")));
  });
}

/** Opens a URL in the default browser on macOS or Linux. */
function openInBrowser(url: string): void {
  const opener = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  opener.on("error", () => undefined);
  opener.unref();
}
