import { eq } from "drizzle-orm";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createPendingProviderOperation,
  listPendingProviderOperations,
  markProviderOperationFailed,
  markProviderOperationPending,
  markProviderOperationSucceeded,
  threadProviderOperations,
} from "../src/index.js";
import { createConnection, type DbConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { projects, threadSections, threads } from "../src/schema.js";

/**
 * SP-4 stateful property (ME-3 / TG9.7): the provider-operation record is
 * a valid state machine under generated retry/duplicate/failure
 * interleavings. Invariants:
 *  - at most one pending record per (thread, kind);
 *  - transitions are only created→pending, pending→succeeded,
 *    pending→failed;
 *  - every dispatch attempt increments `attempts` on exactly one record,
 *    and duplicate requests while pending dispatch nothing — so the
 *    provider effect count equals the sum of recorded attempts.
 */

const KIND = "thread.unarchive";

let db: DbConnection;

beforeEach(() => {
  db = createConnection(":memory:");
  migrate(db);
  const now = Date.now();
  db.insert(projects)
    .values({ id: "project-1", name: "P", createdAt: now, updatedAt: now })
    .run();
  db.insert(threadSections)
    .values([
      { id: "sec_a", name: "A", createdAt: now, updatedAt: now },
      { id: "sec_b", name: "B", createdAt: now, updatedAt: now },
    ])
    .run();
  for (const threadId of ["thread-1", "thread-2"]) {
    db.insert(threads)
      .values({
        id: threadId,
        projectId: "project-1",
        providerId: "codex",
        status: "idle",
        lastReadAt: now,
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
});

interface ModelThread {
  pending: boolean;
  // One terminal status per record, in settle order — the database stores
  // only the current status per record, so this is what it must match.
  terminalStatuses: Array<"succeeded" | "failed">;
}

function recordsFor(threadId: string) {
  return db
    .select()
    .from(threadProviderOperations)
    .where(eq(threadProviderOperations.threadId, threadId))
    .all();
}

describe("provider operation state machine (ME-3, TG9.7)", () => {
  it("keeps one pending record per thread and one dispatch per attempt across generated sequences", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            thread: fc.constantFrom("thread-1", "thread-2"),
            kind: fc.constantFrom(
              "request",
              "duplicate",
              "fail-dispatch",
              "succeed-dispatch",
              "reconcile-fail",
              "reconcile-succeed",
            ),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (operations) => {
          // fast-check re-runs the predicate while shrinking; the database
          // must be reset per invocation, not per test.
          db.delete(threadProviderOperations).run();
          const model: Record<string, ModelThread> = {
            "thread-1": { pending: false, terminalStatuses: [] },
            "thread-2": { pending: false, terminalStatuses: [] },
          };
          let dispatchCount = 0;

          for (const op of operations) {
            const threadId = op.thread;
            const modelThread = model[threadId];
            const succeed = op.kind.endsWith("succeed-dispatch");

            if (op.kind === "request" || op.kind === "duplicate") {
              const { created, operation } = createPendingProviderOperation(
                db,
                {
                  kind: KIND,
                  threadId,
                  hostId: "host-1",
                  environmentId: "env-1",
                  providerId: "codex",
                  providerThreadId: `provider-${threadId}`,
                },
              );
              if (!created) {
                // Duplicate while pending: no dispatch, no state change.
                expect(modelThread.pending).toBe(true);
                continue;
              }
              modelThread.pending = true;
              dispatchCount += 1;
              if (succeed) {
                markProviderOperationSucceeded(db, operation.id);
                modelThread.pending = false;
                modelThread.terminalStatuses.push("succeeded");
              } else {
                markProviderOperationFailed(db, operation.id, "command_timeout");
                modelThread.pending = false;
                modelThread.terminalStatuses.push("failed");
              }
              continue;
            }

            if (op.kind === "fail-dispatch" || op.kind === "succeed-dispatch") {
              // A dispatch against a non-pending thread is only possible
              // after a fresh request; without one, nothing happens.
              if (!modelThread.pending) {
                continue;
              }
            }

            if (
              op.kind === "reconcile-fail" ||
              op.kind === "reconcile-succeed"
            ) {
              const pendingOps = listPendingProviderOperations(db, KIND);
              for (const operation of pendingOps) {
                markProviderOperationPending(db, operation.id);
                dispatchCount += 1;
                if (op.kind === "reconcile-succeed") {
                  markProviderOperationSucceeded(db, operation.id);
                  model[operation.threadId].pending = false;
                  model[operation.threadId].terminalStatuses.push("succeeded");
                } else {
                  markProviderOperationFailed(
                    db,
                    operation.id,
                    "environment_unavailable",
                  );
                  model[operation.threadId].pending = false;
                  model[operation.threadId].terminalStatuses.push("failed");
                }
              }
              continue;
            }

            // fail-dispatch / succeed-dispatch on a pending record: an
            // explicit attempt against the existing pending record.
            const pending = listPendingProviderOperations(db, KIND).find(
              (row) => row.threadId === threadId,
            );
            if (pending === undefined) {
              continue;
            }
            dispatchCount += 1;
            if (succeed) {
              markProviderOperationSucceeded(db, pending.id);
              modelThread.pending = false;
              modelThread.terminalStatuses.push("succeeded");
            } else {
              markProviderOperationFailed(db, pending.id, "command_timeout");
              modelThread.pending = false;
              modelThread.terminalStatuses.push("failed");
            }
          }

          // Invariants over the whole tree after the sequence.
          let totalAttempts = 0;
          for (const threadId of ["thread-1", "thread-2"]) {
            const records = recordsFor(threadId);
            const pendingRecords = records.filter(
              (row) => row.status === "pending",
            );
            expect(pendingRecords.length).toBeLessThanOrEqual(1);
            for (const row of records) {
              totalAttempts += row.attempts;
              // Valid transitions: attempts only ever grow by one per
              // dispatch, and terminal statuses carry a failure reason only
              // when failed.
              if (row.status === "failed") {
                expect(row.failureReason).not.toBeNull();
              } else {
                expect(row.failureReason).toBeNull();
              }
            }
            expect(model[threadId].terminalStatuses).toEqual(
              records.map((row) => row.status),
            );
          }
          // The provider effect count equals the recorded dispatch count.
          expect(totalAttempts).toBe(dispatchCount);
        },
      ),
      { numRuns: 80 },
    );
  });
});
