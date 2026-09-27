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

  it("accepts the capability cookie channel when enabled", async () => {
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

        const allowed = await harness.app.request("/api/v1/threads", {
          headers: { cookie: `bb_capability=${token}` },
        });
        expect(allowed.status).toBe(200);

        const wrongCookie = await harness.app.request("/api/v1/threads", {
          headers: { cookie: "bb_capability=not-the-token" },
        });
        expect(wrongCookie.status).toBe(401);
      },
    );
  });

  it("issues the capability cookie only to loopback peers with a loopback host", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        // Synthetic request: no socket peer address is known, so the
        // bootstrap must refuse rather than guess.
        const synthetic = await harness.app.request(
          "/api/v1/system/capability-bootstrap",
        );
        expect(synthetic.status).toBe(403);

        // Real loopback socket + loopback host: cookie issued, and the
        // cookie then authenticates API requests.
        server = await startTestServer({ requirePublicApiCapability: true });
        const bootstrap = await fetch(
          new URL("/api/v1/system/capability-bootstrap", server.baseUrl),
        );
        expect(bootstrap.status).toBe(204);
        const setCookie = bootstrap.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("bb_capability=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Strict");

        const cookieValue = /bb_capability=([^;]+)/u.exec(setCookie)?.[1] ?? "";
        const authorized = await fetch(
          new URL("/api/v1/threads", server.baseUrl),
          { headers: { cookie: `bb_capability=${cookieValue}` } },
        );
        expect(authorized.status).toBe(200);

        // A spoofed Host header (DNS-rebinding shape) must be refused even
        // from a loopback socket. Raw http.request because fetch forbids
        // overriding the Host header.
        const rebound = await rawStatus(
          "/api/v1/system/capability-bootstrap",
          "attacker.example:1",
        );
        expect(rebound).toBe(403);
      },
    );
  });

  it("bootstrap endpoint is absent when the flag is disabled", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await harness.app.request(
        "/api/v1/system/capability-bootstrap",
      );
      expect(response.status).toBe(404);
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

  it("gate covers every registered /api/v1 route (route enumeration)", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        // Round-1 finding: routes registered on the root app (cloudroom)
        // bypassed a gate that lived on the publicApi sub-app. This test
        // enumerates every mounted /api/v1 route from the final app object,
        // so coverage cannot depend on registration order or mount point.
        const wirePath = /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/u;
        // Carve-outs (see the gate): plugin wire routes carry their own
        // credential; the capability bootstrap is the credential-issuance
        // route itself (loopback-only, no data). Everything else must 401.
        const capabilityBootstrapPath = "/api/v1/system/capability-bootstrap";
        const paths = [
          ...new Set(
            harness.app.routes
              .filter(
                (route) =>
                  route.method !== "ALL" && route.path.startsWith("/api/v1"),
              )
              .map((route) => route.path),
          ),
        ].filter(
          (path) => !wirePath.test(path) && path !== capabilityBootstrapPath,
        );

        // Sanity: the enumeration must actually see a real route set,
        // including the cloudroom mounts that escaped the round-1 gate.
        expect(paths.length).toBeGreaterThan(10);
        expect(paths).toContain("/api/v1/cloudroom/account");

        for (const path of paths) {
          const response = await harness.app.request(path);
          expect(response.status).toBe(401);
        }
      },
    );
  });
});

async function rawStatus(
  path: string,
  hostHeader: string,
): Promise<number | undefined> {
  const url = new URL(path, server?.baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        setHost: false,
        headers: { host: hostHeader },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", (error) => reject(error));
    request.end();
  });
}

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
