import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRoomCliShim,
  resolveBundledRoomCliPath,
} from "../src/room-cli-shim.js";

let root: string;
let homeDir: string;
let shimPath: string;

async function installApp(appDir: string): Promise<string> {
  const cliPath = resolveBundledRoomCliPath(
    join(root, appDir, "Contents/Resources/app.asar"),
  );
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "#!/bin/sh\n");
  await chmod(cliPath, 0o755);
  return cliPath;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "room-cli-shim-"));
  homeDir = join(root, "home");
  shimPath = join(homeDir, ".local/bin/room-cli");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("room-cli shim", () => {
  it("resolves the CLI bundled beside the app asar", () => {
    expect(
      resolveBundledRoomCliPath(
        "/Applications/Cloudroom.app/Contents/Resources/app.asar",
      ),
    ).toBe(
      "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli",
    );
  });

  it("creates the shim, then leaves it alone on the next startup", async () => {
    const cliPath = await installApp("Cloudroom.app");

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "created" });
    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "unchanged" });
    expect(await readlink(shimPath)).toBe(cliPath);
  });

  it("repoints a link left by a moved app or an old CLI name", async () => {
    const cliPath = await installApp("Moved/Cloudroom.app");
    await mkdir(dirname(shimPath), { recursive: true });
    await symlink(
      "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room",
      shimPath,
    );

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ kind: "repaired" });
    expect(await readlink(shimPath)).toBe(cliPath);
  });

  it("never replaces a file or link the user owns", async () => {
    const cliPath = await installApp("Cloudroom.app");
    await mkdir(dirname(shimPath), { recursive: true });
    await writeFile(shimPath, "#!/bin/sh\necho mine\n");

    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({
      kind: "skipped",
      reason: "user-owned",
    });
    expect(await readFile(shimPath, "utf8")).toBe("#!/bin/sh\necho mine\n");

    await rm(shimPath);
    await symlink("/Users/me/code/room-cli-dev", shimPath);
    await expect(
      ensureRoomCliShim({ cliPath, homeDir }),
    ).resolves.toMatchObject({ reason: "user-owned" });
    expect(await readlink(shimPath)).toBe("/Users/me/code/room-cli-dev");
  });

  it("does not link to a missing or translocated app", async () => {
    await expect(
      ensureRoomCliShim({ cliPath: join(root, "missing/room-cli"), homeDir }),
    ).resolves.toMatchObject({ reason: "missing-cli" });
    const translocated = await installApp(
      "AppTranslocation/ABC/d/Cloudroom.app",
    );
    await expect(
      ensureRoomCliShim({ cliPath: translocated, homeDir }),
    ).resolves.toMatchObject({
      reason: "translocated",
    });
    await expect(lstat(shimPath)).rejects.toThrow();
  });
});
