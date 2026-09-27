import { describe, expect, it } from "vitest";
import { DEFAULT_BB_REQUIRE_PUBLIC_API_CAPABILITY } from "../src/env-vars.js";
import { loadServerConfig } from "../src/server.js";

function createServerRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    BB_DATA_DIR: "/tmp/bb-data",
    BB_HOST_DAEMON_PORT: "5555",
    BB_SERVER_PORT: "4444",
    NODE_ENV: "development",
    OPENAI_API_KEY: "test-openai-key",
    ...overrides,
  };
}

describe("public api capability default", () => {
  it("is enabled by default (TG1 tail: secure by default)", () => {
    expect(DEFAULT_BB_REQUIRE_PUBLIC_API_CAPABILITY).toBe(true);
  });

  it("flows into the loaded server config by default", () => {
    const config = loadServerConfig({
      env: createServerRuntimeEnv(),
    });
    expect(config.BB_REQUIRE_PUBLIC_API_CAPABILITY).toBe(true);
  });

  it("can be disabled explicitly", () => {
    const config = loadServerConfig({
      env: createServerRuntimeEnv({ BB_REQUIRE_PUBLIC_API_CAPABILITY: "0" }),
    });
    expect(config.BB_REQUIRE_PUBLIC_API_CAPABILITY).toBe(false);
  });
});
