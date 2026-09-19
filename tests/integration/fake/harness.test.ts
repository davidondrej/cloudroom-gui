import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { waitForHostConnected } from "../helpers/assertions.js";
import { withHarness } from "../helpers/harness.js";

describe("integration harness", () => {
  it("starts the server and daemon, then cleans up the temp repo", async () => {
    let repoDir = "";
    await withHarness(async (harness) => {
      repoDir = harness.repoDir;
      const host = await waitForHostConnected(harness.api);
      expect(host.id).toBe(harness.hostId);
      expect(harness.server.config.transcriptionModel).toBe(
        "test/mock-transcription",
      );

      await fs.access(harness.repoDir);
    });
    await expect(fs.access(repoDir)).rejects.toThrow();
  });

  it("keeps the same host identity across daemon restarts", async () => {
    await withHarness(async (harness) => {
      const initialHostId = harness.hostId;

      await harness.restartDaemon();
      const host = await waitForHostConnected(harness.api);

      expect(harness.hostId).toBe(initialHostId);
      expect(host.id).toBe(initialHostId);
    });
  });

  it("reloads bb-app managed config through the integration server", async () => {
    await withHarness(async (harness) => {
      await fs.writeFile(
        path.join(harness.server.config.dataDir, "env.json"),
        `${JSON.stringify({ env: { OPENAI_API_KEY: "stored-openai-key" } })}\n`,
        "utf8",
      );

      const response = await harness.api.system.config.reload.$post({});

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(harness.server.config.openAiApiKey).toBe("stored-openai-key");
    });
  });
});
