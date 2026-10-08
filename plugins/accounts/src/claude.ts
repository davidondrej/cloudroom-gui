import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageWindow } from "./contract.js";
import { readReset, SignInAgainError, type Secret } from "./tokens.js";

const TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{20,})[^A-Za-z0-9_-]/;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const LIMITS = "anthropic-ratelimit-unified";

function claudeBinary(): string | null {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const binary = path.join(dir, "claude");
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {}
  }
  return null;
}

interface Run {
  url: string | null;
  token: string | null;
  error: string | null;
  stop: () => void;
}

export class ClaudeLogin {
  private readonly runs = new Map<string, Run>();

  async start(): Promise<{ sessionId: string; authorizeUrl: string }> {
    const binary = claudeBinary();
    if (!binary)
      throw new Error("Install Claude Code on this computer, then try again.");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cloudroom-claude-"));
    const browser = path.join(dir, "open");
    writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > "$0.url"\n`, {
      mode: 0o700,
    });
    const command = `stty cols 1000; exec "$CLAUDE_BIN" setup-token`;
    const tty =
      process.platform === "linux"
        ? `/usr/bin/script -q -c '${command}' /dev/null`
        : `/usr/bin/script -q /dev/null /bin/sh -c '${command}'`;
    const child = spawn("/bin/sh", ["-c", `sleep 600 | { ${tty}; kill 0; }`], {
      env: {
        ...process.env,
        CLAUDE_BIN: binary,
        SHELL: "/bin/sh",
        BROWSER: browser,
      },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const sessionId = randomUUID();
    const run: Run = { url: null, token: null, error: null, stop: () => {} };
    const finish = (error: string | null) => {
      if (run.token === null) run.error ??= error;
      clearTimeout(timer);
      try {
        process.kill(-child.pid!);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    };
    run.stop = () => finish("Claude sign-in was cancelled.");
    const timer = setTimeout(
      () => finish("Claude sign-in timed out. Try again."),
      10 * 60_000,
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      const token = output
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .match(TOKEN)?.[1];
      if (token && run.token === null) {
        run.token = token;
        finish(null);
      }
    });
    child.on("error", () => finish("Could not start Claude Code."));
    child.on("close", () =>
      finish("Claude sign-in did not finish. Try again."),
    );
    this.runs.set(sessionId, run);
    for (
      let waited = 0;
      !run.url && !run.error && waited < 15_000;
      waited += 250
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        run.url = readFileSync(`${browser}.url`, "utf8").trim() || null;
      } catch {}
    }
    if (!run.url) {
      run.stop();
      throw new Error(run.error ?? "Claude did not open its sign-in page.");
    }
    return { sessionId, authorizeUrl: run.url };
  }

  poll(sessionId: string): string | null {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error("This sign-in expired. Start again.");
    if (run.token) {
      this.runs.delete(sessionId);
      return run.token;
    }
    if (run.error) {
      this.runs.delete(sessionId);
      throw new Error(run.error);
    }
    return null;
  }
}

export const claudeSecret = (token: string) => ({
  accessToken: token,
  refreshToken: "",
  expiresAt: Date.now() + YEAR_MS,
});

// One-year setup tokens can't read /api/oauth/usage (it needs user:profile),
// but every Claude reply carries the account's limits in its headers, even a 429.
// OAuth replies need the Claude Code system prompt, or Anthropic answers 429.
export async function claudeUsage(secret: Secret): Promise<UsageWindow[]> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status === 401)
    throw new SignInAgainError("Claude rejected this login. Sign in again.");
  const windows = (
    [
      ["Five-hour limit", "5h"],
      ["Weekly limit", "7d"],
    ] as const
  ).flatMap(([label, key]) => {
    const used = response.headers.get(`${LIMITS}-${key}-utilization`);
    if (used === null || !Number.isFinite(Number(used))) return [];
    return [
      {
        label,
        usedPercent: Number(used) * 100,
        resetsAt: readReset(response.headers.get(`${LIMITS}-${key}-reset`)),
      },
    ];
  });
  if (windows.length === 0)
    throw new Error(`Claude usage failed (HTTP ${response.status}).`);
  return windows;
}

export async function localClaudeEmail(): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
    );
    const email = z
      .object({ oauthAccount: z.object({ emailAddress: z.string() }) })
      .safeParse(value);
    return email.success ? email.data.oauthAccount.emailAddress : null;
  } catch {
    return null;
  }
}
