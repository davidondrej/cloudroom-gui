import { execFile } from "node:child_process";
import { findCliExecutable } from "@bb/process-utils";
import type { AppDeps } from "../../types.js";
import { claudeBinary } from "./claude-token.js";
import type { CloudroomClient } from "./client.js";

/** The Mac's Codex and Claude Code versions. Cloud runs what ran locally (ADR 0133). */
export type HarnessVersions = { codex?: string; claude?: string };

function versionOf(binary: string | undefined): Promise<string | undefined> {
  if (!binary) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout)?.[1]);
    });
  });
}

let cached: { at: number; versions: Promise<HarnessVersions> } | undefined;
/** Read at most once a minute, from the same binaries Local threads run. */
export function macHarnessVersions(): Promise<HarnessVersions> {
  if (!cached || Date.now() - cached.at > 60_000) {
    const versions = Promise.all([versionOf(findCliExecutable("codex") ?? undefined), versionOf(claudeBinary())])
      .then(([codex, claude]) => ({ ...(codex ? { codex } : {}), ...(claude ? { claude } : {}) }));
    cached = { at: Date.now(), versions };
  }
  return cached.versions;
}

/** Accounts on a shared VM (not sandboxes) keep its Claude Code on the Mac's version. */
export function startClaudeVersionSync(deps: AppDeps, vm: () => Promise<CloudroomClient>): void {
  let reported: string | undefined;
  const sync = async () => {
    const version = (await macHarnessVersions()).claude;
    if (!version) return;
    try {
      const result = await (await vm()).matchClaudeVersion(version);
      const problem = result.error ? `${result.state}: ${result.error}` : undefined;
      if (problem && problem !== reported) deps.logger?.warn({ target: version, state: result.state, error: result.error }, "Cloud Claude Code version could not match this Mac");
      reported = problem;
    } catch {
      return;
    }
  };
  setTimeout(() => void sync(), 30_000).unref();
  setInterval(() => void sync(), 5 * 60_000).unref();
}
