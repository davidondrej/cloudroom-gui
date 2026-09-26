import { execFile } from "node:child_process";
import type { AppDeps } from "../../types.js";
import { claudeBinary } from "./claude-token.js";
import { cloudroom } from "./commands.js";

export function macClaudeVersion(): Promise<string | undefined> {
  const binary = claudeBinary();
  if (!binary) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : /^(\d+\.\d+\.\d+) /.exec(stdout)?.[1]);
    });
  });
}

export function startClaudeVersionSync(deps: AppDeps): void {
  let reported: string | undefined;
  const sync = async () => {
    const version = await macClaudeVersion();
    if (!version) return;
    try {
      const result = await (await cloudroom(deps).teleportClient()).matchClaudeVersion(version);
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
