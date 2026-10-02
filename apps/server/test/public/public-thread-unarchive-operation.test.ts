import { createPendingProviderOperation, threadProviderOperations } from "@bb/db";
import { reconcilePendingThreadUnarchiveOperations } from "../../src/services/threads/thread-commands.js";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

/**
 * ME-3 (TG9): unarchive reports the truthful provider-operation status —
 * the response carries pending/succeeded/failed instead of a bare
 * {ok:true}, duplicate requests never double-dispatch, and the durable
 * record's failure reasons are sanitized.
 */

function seedUnarchiveFixture(
  harness: TestAppHarness,
  hostId: string,
) {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${thread.id}`,
    threadId: thread.id,
  });
  return { environment, host, thread };
}

describe("thread unarchive provider operation (ME-3, TG9)", () => {
  it("reports succeeded only after the provider confirms (9.4)", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedUnarchiveFixture(harness, "host-unarchive-ok");

      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandSuccess(harness, queued, {});

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        providerUnarchiveStatus: "succeeded",
      });

      const record = harness.db
        .select()
        .from(threadProviderOperations)
        .all()
        .find((row) => row.threadId === thread.id);
      expect(record?.status).toBe("succeeded");
      expect(record?.attempts).toBe(1);
    });
  });

  it("surfaces failed instead of success when the provider errors (9.5)", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedUnarchiveFixture(harness, "host-unarchive-fail");

      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandError(harness, queued, {
        errorCode: "command_timeout",
        errorMessage: "Provider unarchive timed out",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        providerUnarchiveStatus: string;
      };
      expect(body.providerUnarchiveStatus).toBe("failed");

      const record = harness.db
        .select()
        .from(threadProviderOperations)
        .all()
        .find((row) => row.threadId === thread.id);
      expect(record?.status).toBe("failed");
      // 9.9: the persisted reason is the sanitized error code — not the
      // raw message or any host internals.
      expect(record?.failureReason).toBe("command_timeout");
    });
  });

  it("dispatches a duplicate request exactly once while pending (9.5/9.8)", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedUnarchiveFixture(harness, "host-unarchive-dup");

      const first = harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      // Duplicate click while the first operation is still pending.
      const second = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      expect((await second.json())["providerUnarchiveStatus"]).toBe("pending");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandSuccess(harness, queued, {});
      const firstResponse = await first;
      expect(
        (await firstResponse.json())["providerUnarchiveStatus"],
      ).toBe("succeeded");

      // Exactly one dispatch for the pending operation.
      expect(
        harness.db.select().from(threadProviderOperations).all(),
      ).toHaveLength(1);
    });
  });

  it("reconciles a pending operation exactly once on restart (9.6)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedUnarchiveFixture(
        harness,
        "host-unarchive-rec",
      );

      // Simulate a crash mid-operation: a pending record exists, the
      // provider command was never answered.
      createPendingProviderOperation(harness.db, {
        kind: "thread.unarchive",
        threadId: thread.id,
        hostId: environment.hostId,
        environmentId: environment.id,
        providerId: thread.providerId,
        providerThreadId: `provider-${thread.id}`,
      });

      // Restart reconciliation: the pending operation is re-dispatched
      // once and settles.
      const reconcilePromise = reconcilePendingThreadUnarchiveOperations(
        harness.deps,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandSuccess(harness, queued, {});
      await reconcilePromise;

      const record = harness.db
        .select()
        .from(threadProviderOperations)
        .all()
        .find((row) => row.threadId === thread.id);
      expect(record?.status).toBe("succeeded");
      expect(record?.attempts).toBe(1);

      // A second reconciliation pass dispatches nothing: the record is no
      // longer pending, so attempts stay at 1.
      await reconcilePendingThreadUnarchiveOperations(harness.deps);
      const afterSecondPass = harness.db
        .select()
        .from(threadProviderOperations)
        .all()
        .find((row) => row.threadId === thread.id);
      expect(afterSecondPass?.attempts).toBe(1);
      expect(afterSecondPass?.status).toBe("succeeded");
    });
  });

  it("allows a fresh attempt after a failed operation, scoped per thread (9.8)", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedUnarchiveFixture(harness, "host-unarchive-retry");

      const first = harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      const failed = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandError(harness, failed, {
        errorCode: "command_timeout",
        errorMessage: "timed out",
      });
      await first;
      expect(
        harness.db
          .select()
          .from(threadProviderOperations)
          .all()
          .filter((row) => row.status === "failed"),
      ).toHaveLength(1);

      // Retry after failure: a new pending record, a new dispatch.
      const retry = harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      const retried = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.unarchive",
      );
      await reportQueuedCommandSuccess(harness, retried, {});
      await retry;

      const records = harness.db
        .select()
        .from(threadProviderOperations)
        .all()
        .filter((row) => row.threadId === thread.id);
      expect(records).toHaveLength(2);
      expect(records.map((row) => row.status).sort()).toEqual([
        "failed",
        "succeeded",
      ]);
    });
  });
});
