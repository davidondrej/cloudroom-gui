import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { CLOUDROOM_PYTHON_PATH, CLOUDROOM_SYNC_SCRIPT_PATH as script } from "../../cloudroom-workspace-asset.js";

const state = z.enum(["synced", "syncing", "offline", "conflict"]);
const statusSchema = z.object({ state, checkedAt: z.number(), roots: z.record(z.string(), z.object({ state, conflicts: z.number().optional() })).optional() });
type Deps = Pick<AppDeps, "config">;
const folder = (deps: Deps) => join(deps.config.dataDir, "cloudroom-sync");

export async function syncStatus(deps: Deps) {
  try {
    const data = statusSchema.parse(JSON.parse(await readFile(join(folder(deps), "status.json"), "utf8")));
    return { state: Date.now() - data.checkedAt > 30_000 ? "offline" as const : data.state, conflicts: Object.values(data.roots ?? {}).reduce((sum, root) => sum + (root.conflicts ?? 0), 0) };
  } catch { return { state: "offline" as const, conflicts: 0 }; }
}

export async function setupSync(deps: Deps): Promise<void> {
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json")], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "cloudroom_sync_setup", "Skills and settings sync could not start. Cloud sessions are unaffected."); }
}

export async function importCodexLogin(deps: Deps): Promise<void> {
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "auth", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json")], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "codex_auth_unavailable", "Could not check your saved Codex login. Check the cloud connection and try again."); }
}

export async function stopSync(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try { await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "stop", folder(deps)], { timeout: 15_000, maxBuffer: 64 * 1024 }); }
  catch {}
}
