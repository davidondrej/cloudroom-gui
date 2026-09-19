import { and, eq, sql } from "drizzle-orm";
import { cloudroomCommands, cloudroomThreads, threads, type DbQueryConnection } from "@bb/db";

export type Binding = typeof cloudroomThreads.$inferSelect;
export type Command = typeof cloudroomCommands.$inferSelect;

export function binding(db: DbQueryConnection, threadId: string): Binding | null {
  return db.select().from(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).get() ?? null;
}

export function bindings(db: DbQueryConnection): Binding[] {
  return db.select().from(cloudroomThreads).all();
}

export function saveBinding(db: DbQueryConnection, threadId: string, values: Partial<Omit<Binding, "threadId">>): void {
  db.update(cloudroomThreads).set(values).where(eq(cloudroomThreads.threadId, threadId)).run();
}

export function commands(db: DbQueryConnection, threadId: string): Command[] {
  return db.select().from(cloudroomCommands).where(eq(cloudroomCommands.threadId, threadId)).orderBy(cloudroomCommands.createdAt, cloudroomCommands.id).all();
}

export function command(db: DbQueryConnection, id: string): Command | null {
  return db.select().from(cloudroomCommands).where(eq(cloudroomCommands.id, id)).get() ?? null;
}

export function saveCommandState(db: DbQueryConnection, threadId: string, id: string, state: string): void {
  db.update(cloudroomCommands).set({ state }).where(and(eq(cloudroomCommands.id, id), eq(cloudroomCommands.threadId, threadId))).run();
}

export function effectivePrompt(db: DbQueryConnection, threadId: string, id: string): Record<string, unknown> {
  const original = command(db, id);
  let input: Record<string, unknown> = original ? JSON.parse(original.input) : {};
  let revision = 1;
  const edits = commands(db, threadId)
    .filter((item) => item.command === "edit" && ["accepted", "completed"].includes(item.state))
    .map((item) => JSON.parse(item.input))
    .filter((item) => item.target_request_id === id)
    .sort((a, b) => a.expected_revision - b.expected_revision);
  for (const edit of edits) {
    if (edit.expected_revision !== revision) continue;
    const { target_request_id: _target, expected_revision: _revision, ...changes } = edit;
    input = { ...input, ...changes };
    revision++;
  }
  return { ...input, revision };
}

export function saveStatus(db: DbQueryConnection, threadId: string, status: typeof threads.$inferSelect["status"]): void {
  db.update(threads).set({ status, updatedAt: Date.now(), latestAttentionAt: Date.now() }).where(and(eq(threads.id, threadId), sql`${threads.status} != ${status}`)).run();
}
