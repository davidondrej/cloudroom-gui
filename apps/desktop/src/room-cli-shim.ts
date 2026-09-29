import fs from "node:fs/promises";
import { dirname, join } from "node:path";

const BUNDLED_CLI_TARGET = /\/node_modules\/bb-app\/host-daemon\/dist\/[^/]+$/;

export type RoomCliShimResult =
  | { kind: "created" | "repaired" | "unchanged"; shimPath: string }
  | {
      kind: "skipped";
      reason: "missing-cli" | "translocated" | "user-owned";
      shimPath: string;
    };

interface EnsureRoomCliShimArgs {
  cliPath: string;
  homeDir: string;
}

export function resolveBundledRoomCliPath(appPath: string): string {
  return join(
    `${appPath}.unpacked`,
    "node_modules",
    "bb-app",
    "host-daemon",
    "dist",
    "room-cli",
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

async function readShimTarget(
  shimPath: string,
): Promise<string | null | "not-a-link"> {
  try {
    return await fs.readlink(shimPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "EINVAL") return "not-a-link";
    throw error;
  }
}

export async function ensureRoomCliShim(
  args: EnsureRoomCliShimArgs,
): Promise<RoomCliShimResult> {
  const shimPath = join(args.homeDir, ".local", "bin", "room-cli");
  if (args.cliPath.includes("/AppTranslocation/")) {
    return { kind: "skipped", reason: "translocated", shimPath };
  }
  try {
    await fs.access(args.cliPath, fs.constants.X_OK);
  } catch {
    return { kind: "skipped", reason: "missing-cli", shimPath };
  }

  const current = await readShimTarget(shimPath);
  if (current === args.cliPath) return { kind: "unchanged", shimPath };
  if (
    current === "not-a-link" ||
    (current !== null && !BUNDLED_CLI_TARGET.test(current))
  ) {
    return { kind: "skipped", reason: "user-owned", shimPath };
  }

  await fs.mkdir(dirname(shimPath), { recursive: true });
  if (current === null) {
    await fs.symlink(args.cliPath, shimPath);
    return { kind: "created", shimPath };
  }
  const tempPath = `${shimPath}.${process.pid}.tmp`;
  await fs.rm(tempPath, { force: true });
  await fs.symlink(args.cliPath, tempPath);
  try {
    await fs.rename(tempPath, shimPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  return { kind: "repaired", shimPath };
}
