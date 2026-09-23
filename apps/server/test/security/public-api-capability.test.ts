import http from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOrCreatePublicApiCapability,
  presentedCapability,
  PUBLIC_API_CAPABILITY_FILE_NAME,
} from "../../src/services/public-api-capability.js";
import {
  startTestServer,
  withTestHarness,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("public api capability service", () => {
  it("creates a 0600 token file, reuses it, and verifies in constant time", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-capability-"));
    try {
      const first = loadOrCreatePublicApiCapability({ dataDir });
      const second = loadOrCreatePublicApiCapability({ dataDir });
      expect(second.token).toBe(first.token);
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      const tokenFile = join(dataDir, PUBLIC_API_CAPABILITY_FILE_NAME);
      const stored = (await readFile(tokenFile, "utf8")).trim();
      expect(stored).toBe(first.token);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

      expect(first.verify(first.token)).toBe(true);
      expect(first.verify(`${first.token}x`)).toBe(false);
      expect(first.verify("")).toBe(false);
      expect(first.verify(undefined)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("extracts the capability from the dedicated header or Bearer token", () => {
    const headerOnly = (name: string) =>
      name === "x-bb-capability" ? "  token-value  " : undefined;
    expect(presentedCapability(headerOnly)).toBe("token-value");

    const bearer = (name: string) =>
      name === "authorization" ? "Bearer token-value" : undefined;
    expect(presentedCapability(bearer)).toBe("token-value");

    expect(presentedCapability(() => undefined)).toBeUndefined();
    expect(
      presentedCapability((name) =>
        name === "authorization" ? "Basic dXNlcjpwYXNz" : undefined,
      ),
    ).toBeUndefined();
    expect(
      presentedCapability((name) =>
        name === "authorization" ? "Bearer" : undefined,
      ),
    ).toBeUndefined();
  });
});

describe("public api capability middleware", () => {
  it("rejects /api/v1 requests without a valid capability when enabled", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        const denied = await harness.app.request("/api/v1/threads");
        expect(denied.status).toBe(401);

        const wrongToken = await harness.app.request("/api/v1/threads", {
          headers: { "x-bb-capability": "not-the-token" },
        });
        expect(wrongToken.status).toBe(401);

        const allowed = await harness.app.request("/api/v1/threads", {
          headers: { "x-bb-capability": token },
        });
        expect(allowed.status).toBe(200);

        const bearerAllowed = await harness.app.request("/api/v1/threads", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(bearerAllowed.status).toBe(200);
      },
    );
  });

  it("leaves requests ungated when the flag is disabled", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await harness.app.request("/api/v1/threads");
      expect(response.status).toBe(200);
    });
  });

  it("rejects browser WebSocket upgrades without a capability when enabled", async () => {
    server = await startTestServer({ requirePublicApiCapability: true });
    const token = (
      await readFile(
        join(server.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
        "utf8",
      )
    ).trim();

    const deniedStatus = await upgradeStatus(server.baseUrl, {});
    expect(deniedStatus).toBe(401);

    const allowedStatus = await upgradeStatus(server.baseUrl, {
      "x-bb-capability": token,
    });
    expect(allowedStatus).toBe(101);
  });
});

async function upgradeStatus(
  baseUrl: string,
  extraHeaders: Record<string, string>,
): Promise<number | undefined> {
  const url = new URL("/ws", baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          ...extraHeaders,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("upgrade", () => {
      request.destroy();
      resolve(101);
    });
    request.on("error", (error) => {
      reject(error);
    });
    request.end();
  });
}
