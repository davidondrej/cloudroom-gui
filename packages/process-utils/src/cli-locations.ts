import { accessSync, constants, existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type KnownCli = "codex" | "claude";

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDanglingLink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink() && !existsSync(candidate);
  } catch {
    return false;
  }
}

function pathCandidates(cli: KnownCli, env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, cli));
}

function codexAppBundlePaths(home: string): string[] {
  if (process.platform !== "darwin") return [];
  return ["/Applications", join(home, "Applications")].flatMap((apps) =>
    ["ChatGPT.app", "Codex.app"].flatMap((app) => {
      const resources = join(apps, app, "Contents", "Resources");
      return [
        join(resources, "codex-cli", "bin", "codex"),
        join(resources, "codex"),
      ];
    }),
  );
}

function fallbackCandidates(cli: KnownCli, env: NodeJS.ProcessEnv): string[] {
  if (process.getuid?.() === 0) return [];
  const home = env.HOME?.trim() || homedir();
  const binDirs = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
  ];
  const providerPaths =
    cli === "codex"
      ? [
          join(
            env.CODEX_HOME?.trim() || join(home, ".codex"),
            "packages",
            "standalone",
            "current",
            "codex",
          ),
          ...codexAppBundlePaths(home),
        ]
      : [join(home, ".claude", "local", "claude")];
  return [...binDirs.map((dir) => join(dir, cli)), ...providerPaths];
}

export function findCliExecutable(
  cli: KnownCli,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    [...pathCandidates(cli, env), ...fallbackCandidates(cli, env)].find(
      isExecutableFile,
    ) ?? null
  );
}

export function findBrokenCliLink(
  cli: KnownCli,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return pathCandidates(cli, env).find(isDanglingLink) ?? null;
}
