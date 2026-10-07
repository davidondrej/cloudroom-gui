import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// browser-harness for Local threads (ADR 0190). Agents run `browser-harness` exactly as upstream
// documents. The first run installs a pinned copy into Cloudroom's data folder; every run drives the
// user's own browser with telemetry and update checks off. Kept free of `${` and backslashes so the
// template literal is the script verbatim.
const SHIM = `#!/bin/sh
# Written by the Cloudroom host daemon (ADR 0190); edits are overwritten.
set -e
version=0.1.13
uv_version=0.12.23
home=$(cd "$(dirname "$0")/.." && pwd)/browser-harness
venv="$home/$version"
export BH_TELEMETRY=0 BH_UPDATE_CHECK=0

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

if [ ! -f "$venv/.ready" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin sum=50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544 ;;
    Darwin-x86_64) target=x86_64-apple-darwin sum=960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4 ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu sum=6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f ;;
    Linux-x86_64) target=x86_64-unknown-linux-gnu sum=9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6 ;;
    *) echo "browser-harness: $(uname -sm) is not supported" >&2; exit 1 ;;
  esac
  mkdir -p "$home"
  # One installer at a time; a lock left by a killed install expires after 10 minutes.
  find "$home" -maxdepth 1 -name install.lock -mmin +10 -exec rmdir {} + 2>/dev/null || true
  until mkdir "$home/install.lock" 2>/dev/null; do sleep 1; done
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"; rmdir "$home/install.lock" 2>/dev/null' EXIT
  if [ ! -f "$venv/.ready" ]; then
    echo "browser-harness: installing $version (first use only)..." >&2
    curl -fsSL --proto '=https' "https://github.com/astral-sh/uv/releases/download/$uv_version/uv-$target.tar.gz" -o "$tmp/uv.tgz"
    [ "$(sha256 "$tmp/uv.tgz")" = "$sum" ] || { echo 'browser-harness: uv checksum mismatch' >&2; exit 1; }
    tar -xzf "$tmp/uv.tgz" -C "$tmp"
    export UV_PYTHON_INSTALL_DIR="$home/python" UV_CACHE_DIR="$home/cache" UV_PYTHON_PREFERENCE=only-managed UV_NO_CONFIG=1
    rm -rf "$venv"
    "$tmp/uv-$target/uv" venv --quiet --python 3.12 "$venv"
    "$tmp/uv-$target/uv" pip install --quiet --python "$venv/bin/python" "browser-harness==$version"
    for old in "$home"/0.*; do [ "$old" = "$venv" ] || rm -rf "$old"; done
    touch "$venv/.ready"
  fi
  rm -rf "$tmp"; rmdir "$home/install.lock"; trap - EXIT
fi

# Use the user's default browser: when it is Chromium-based and closed, open it in the background so
# browser-harness attaches to it. Safari and Firefox have no DevTools protocol.
if [ "$(uname -s)" = Darwin ] && { [ $# -eq 0 ] || [ "$1" = -c ]; } && [ -z "$BU_CDP_WS$BU_CDP_URL$BU_NAME" ]; then
  app=$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
    const id = url.isNil() ? "" : ($.NSBundle.bundleWithURL(url).bundleIdentifier.js || "");
    const chromium = /^(com[.]google[.]chrome|com[.]brave[.]browser|com[.]microsoft[.]edgemac|company[.]thebrowser[.](browser|dia)|org[.]chromium[.]chromium|ai[.]perplexity[.]comet)/i;
    chromium.test(id) && $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count === 0 ? id : "";
  ' 2>/dev/null || true)
  [ -z "$app" ] || open -g -b "$app" 2>/dev/null || true
fi
exec "$venv/bin/browser-harness" "$@"
`;

/** Writes the shim to `<dataDir>/bin` and returns that folder for agents' PATH. */
export async function installBrowserHarnessShim(
  dataDir: string,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const bin = join(dataDir, "bin");
  const file = join(bin, "browser-harness");
  await mkdir(bin, { recursive: true });
  if ((await readFile(file, "utf8").catch(() => "")) !== SHIM) {
    await writeFile(file, SHIM);
  }
  await chmod(file, 0o755);
  return bin;
}
