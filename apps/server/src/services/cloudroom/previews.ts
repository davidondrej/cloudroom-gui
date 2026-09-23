import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { CLOUDROOM_PYTHON_PATH, CLOUDROOM_PREVIEW_SCRIPT_PATH } from "../../cloudroom-workspace-asset.js";

type Deps = Pick<AppDeps, "config">;
const folder = (deps: Deps) => join(deps.config.dataDir, "cloudroom-preview");
const statusSchema = z.object({ state: z.enum(["connected", "offline"]), count: z.number().int().nonnegative().optional(), message: z.string().max(512).optional(), checkedAt: z.number() });

export async function previewStatus(deps: Deps) {
  try {
    const status = statusSchema.parse(JSON.parse(await readFile(join(folder(deps), "status.json"), "utf8")));
    const age = Date.now() - status.checkedAt;
    return { state: age >= -5000 && age <= 15_000 ? status.state : "offline", count: status.count ?? 0, message: status.message ?? null };
  } catch { return { state: "offline", count: 0, message: null }; }
}

export async function setupPreviews(deps: Deps): Promise<void> {
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", CLOUDROOM_PREVIEW_SCRIPT_PATH, "configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json")], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "cloudroom_preview_setup", "Cloud previews could not start. Inspect the private preview helper status. Cloud sessions are unaffected."); }
}

export async function stopPreviews(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", CLOUDROOM_PREVIEW_SCRIPT_PATH, "stop", folder(deps)], { timeout: 20_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "cloudroom_preview_stop", "Preview shutdown or SSH-key revocation could not be confirmed. Retry sign-out when the cloud is reachable."); }
}
