import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@bb/config/server";
import { runServer } from "../../src/start-server.js";

/**
 * Startup wiring for the CR-1 Phase 0 bind refusal (unit coverage for the
 * gate itself lives in packages/config/test/loopback.test.ts). The refusal is
 * the first statement of runServer, so these calls must reject before any
 * socket, database, or service initialization happens.
 */

function partialConfig(args: {
  BB_SERVER_BIND_HOST: string;
  BB_SERVER_ALLOW_NON_LOOPBACK: boolean;
}): ServerConfig {
  return args as unknown as ServerConfig;
}

describe("startup bind refusal (CR-1 Phase 0)", () => {
  it("fails startup fatally before any initialization on a wildcard bind", async () => {
    await expect(
      runServer(
        partialConfig({
          BB_SERVER_BIND_HOST: "0.0.0.0",
          BB_SERVER_ALLOW_NON_LOOPBACK: false,
        }),
      ),
    ).rejects.toThrow(/BB_SERVER_ALLOW_NON_LOOPBACK/u);
  });

  it("fails on any non-loopback bind and names the Connect gateway", async () => {
    await expect(
      runServer(
        partialConfig({
          BB_SERVER_BIND_HOST: "192.168.1.50",
          BB_SERVER_ALLOW_NON_LOOPBACK: false,
        }),
      ),
    ).rejects.toThrow(/Connect gateway/u);
  });
});
