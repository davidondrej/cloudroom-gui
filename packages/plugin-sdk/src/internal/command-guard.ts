import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexGuardConfig, codexHookSource, shellQuote } from "./command-guard-runtime.mjs";
export { checkCommand, commandGuardBlockReason } from "./command-guard-runtime.mjs";

let config: ReturnType<typeof codexGuardConfig> | undefined;

export function prepareCodexGuard(): ReturnType<typeof codexGuardConfig> {
  if (config) return config;
  const directory = mkdtempSync(join(tmpdir(), "cloudroom-command-guard-"));
  const path = join(directory, "cloudroom-command-guard.mjs");
  writeFileSync(path, codexHookSource(), { mode: 0o600 });
  const command = `${shellQuote(process.execPath)} ${shellQuote(path)} || { printf 'Cloudroom Command Guard unavailable; command blocked.' >&2; exit 2; }`;
  config = codexGuardConfig(command);
  return config;
}
