import { and, eq, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { createProviderOperationId } from "../ids.js";
import { threadProviderOperations } from "../schema.js";

export type ThreadProviderOperation = typeof threadProviderOperations.$inferSelect;

export type ThreadProviderOperationKind = "thread.unarchive";

export interface FindPendingProviderOperationArgs {
  kind: ThreadProviderOperationKind;
  threadId: string;
}

export function findPendingProviderOperation(
  db: Pick<DbConnection, "select">,
  args: FindPendingProviderOperationArgs,
): ThreadProviderOperation | null {
  return (
    db
      .select()
      .from(threadProviderOperations)
      .where(
        and(
          eq(threadProviderOperations.threadId, args.threadId),
          eq(threadProviderOperations.kind, args.kind),
          eq(threadProviderOperations.status, "pending"),
        ),
      )
      .get() ?? null
  );
}

export interface CreateProviderOperationArgs {
  kind: ThreadProviderOperationKind;
  hostId: string;
  environmentId: string;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

/**
 * Creates the pending operation record, or returns the already-pending
 * record for the same (thread, kind) — the idempotency mechanism (TG9.8):
 * while an operation is pending, duplicate requests re-use it and never
 * re-dispatch. The partial unique index enforces this at the database
 * level even under concurrent inserts.
 */
export function createPendingProviderOperation(
  db: DbConnection,
  args: CreateProviderOperationArgs,
): { created: boolean; operation: ThreadProviderOperation } {
  const now = Date.now();
  const attemptedId = createProviderOperationId();
  db.insert(threadProviderOperations)
    .values({
      id: attemptedId,
      attempts: 0,
      createdAt: now,
      environmentId: args.environmentId,
      hostId: args.hostId,
      kind: args.kind,
      providerId: args.providerId,
      providerThreadId: args.providerThreadId,
      status: "pending",
      threadId: args.threadId,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const existing = findPendingProviderOperation(db, {
    kind: args.kind,
    threadId: args.threadId,
  });
  if (existing === null) {
    throw new Error("Expected a pending provider operation after insert");
  }
  // `created` is false when a concurrent/prior pending operation for the
  // same (thread, kind) won the partial unique index — the caller must not
  // re-dispatch (TG9.5/9.8).
  return { created: existing.id === attemptedId, operation: existing };
}

export function listPendingProviderOperations(
  db: Pick<DbConnection, "select">,
  kind: ThreadProviderOperationKind,
): ThreadProviderOperation[] {
  return db
    .select()
    .from(threadProviderOperations)
    .where(
      and(
        eq(threadProviderOperations.kind, kind),
        eq(threadProviderOperations.status, "pending"),
      ),
    )
    .all();
}

export function markProviderOperationSucceeded(
  db: DbConnection,
  operationId: string,
): void {
  db.update(threadProviderOperations)
    .set({ status: "succeeded", updatedAt: Date.now() })
    .where(eq(threadProviderOperations.id, operationId))
    .run();
}

export function markProviderOperationFailed(
  db: DbConnection,
  operationId: string,
  failureReason: string,
): void {
  db.update(threadProviderOperations)
    .set({
      attempts: sql`${threadProviderOperations.attempts} + 1`,
      failureReason,
      status: "failed",
      updatedAt: Date.now(),
    })
    .where(eq(threadProviderOperations.id, operationId))
    .run();
}

export function markProviderOperationPending(
  db: DbConnection,
  operationId: string,
): void {
  db.update(threadProviderOperations)
    .set({
      attempts: sql`${threadProviderOperations.attempts} + 1`,
      status: "pending",
      updatedAt: Date.now(),
    })
    .where(eq(threadProviderOperations.id, operationId))
    .run();
}
