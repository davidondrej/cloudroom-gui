import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";

export const IDLE_INSTALL_AFTER_MS = 10 * 60_000;
const IDLE_CHECK_MS = 15_000;

export interface IdleInstallArgs {
  isUpdateDownloaded(): boolean;
  systemIdleSeconds(): number;
  hasRunningThreads(): Promise<boolean>;
  report?(installAt: number | null): Promise<boolean>;
  install(): Promise<void>;
  now?: () => number;
}

export function startIdleInstall(args: IdleInstallArgs): {
  check(): Promise<void>;
  stop(): void;
} {
  const now = args.now ?? Date.now;
  let busyAt = now();
  let installing = false;
  async function check(): Promise<void> {
    if (installing) return;
    if (!args.isUpdateDownloaded()) {
      busyAt = now();
      return;
    }
    const running = await args.hasRunningThreads().catch(() => true);
    if (running) busyAt = now();
    const installAt = running
      ? null
      : Math.max(busyAt, now() - args.systemIdleSeconds() * 1000) +
        IDLE_INSTALL_AFTER_MS;
    const requested = (await args.report?.(installAt).catch(() => false)) ?? false;
    if (!requested && (installAt === null || now() < installAt)) return;
    installing = true;
    await args.install();
  }
  const timer = setInterval(() => void check(), IDLE_CHECK_MS);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}

const REOPEN_SCRIPT = `
id=$(defaults read "$1/Contents/Info" CFBundleIdentifier) || exit 1
running() { [ -n "$(lsappinfo find bundleid="$id")" ]; }
for _ in $(seq 1800); do kill -0 "$2" 2>/dev/null || break; sleep 1; done
sleep 5
for _ in $(seq 100); do
  running && exit 0
  pgrep -x ShipIt >/dev/null || break
  sleep 3
done
sleep 5
running || open "$1"
`;

export function macAppBundle(execPath: string): string | null {
  return /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/u.exec(execPath)?.[1] ?? null;
}

// Squirrel.Mac needs an admin password ("trying to add a new helper tool") when
// this user can't write the app bundle or its folder, e.g. another account installed it.
export function installNeedsPassword(execPath: string): boolean {
  const bundle = macAppBundle(execPath);
  if (bundle === null) return false;
  try {
    accessSync(bundle, constants.W_OK);
    accessSync(dirname(bundle), constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export function reopenAfterExit(execPath: string, pid: number): boolean {
  const bundle = macAppBundle(execPath);
  if (bundle === null) return false;
  spawn("/bin/sh", ["-c", REOPEN_SCRIPT, "sh", bundle, String(pid)], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}
