import { and, eq, isNull, sql } from "drizzle-orm";
import { cloudroomCommands, cloudroomThreads, threads, threadPluginMetadata, type DbQueryConnection } from "@bb/db";
import type { ProjectCopyProgress } from "@bb/domain";

export type TeleportProgress = {
  id: string; owner: string; phase: "checking" | "stopping" | "uploading" | "running" | "complete" | "cancelled" | "error" | "cancelling";
  completed: number; total: number; error?: string; cloudStarted?: boolean;
};
const teleportNamespace = "cloudroom.teleport";
export function teleportProgress(db: DbQueryConnection, threadId: string): TeleportProgress | null {
  const row = db.select({ value: threadPluginMetadata.metadataJson }).from(threadPluginMetadata)
    .where(and(eq(threadPluginMetadata.threadId, threadId), eq(threadPluginMetadata.pluginId, teleportNamespace))).get();
  return row ? JSON.parse(row.value) as TeleportProgress : null;
}
export function teleportBlocked(db: DbQueryConnection, threadId: string): boolean {
  const progress = teleportProgress(db, threadId);
  return Boolean(progress && !["checking", "complete", "cancelled"].includes(progress.phase));
}
export function saveTeleportProgress(db: DbQueryConnection, threadId: string, value: TeleportProgress): void {
  db.insert(threadPluginMetadata).values({ threadId, pluginId: teleportNamespace, metadataJson: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [threadPluginMetadata.threadId, threadPluginMetadata.pluginId], set: { metadataJson: JSON.stringify(value) } }).run();
}
export function pendingTeleports(db: DbQueryConnection): { threadId: string; progress: TeleportProgress }[] {
  return db.select({ threadId: threadPluginMetadata.threadId, value: threadPluginMetadata.metadataJson }).from(threadPluginMetadata)
    .where(eq(threadPluginMetadata.pluginId, teleportNamespace)).all()
    .map(row => ({ threadId: row.threadId, progress: JSON.parse(row.value) as TeleportProgress }))
    .filter(row => row.threadId === row.progress.owner && !["complete", "cancelled", "error"].includes(row.progress.phase));
}
const projectCopyNamespace = "cloudroom.project-copy";
export function projectCopyProgress(db: DbQueryConnection, threadId: string): ProjectCopyProgress | null {
  const row = db.select({ value: threadPluginMetadata.metadataJson }).from(threadPluginMetadata)
    .where(and(eq(threadPluginMetadata.threadId, threadId), eq(threadPluginMetadata.pluginId, projectCopyNamespace))).get();
  return row ? JSON.parse(row.value) as ProjectCopyProgress : null;
}
export function saveProjectCopyProgress(db: DbQueryConnection, threadId: string, value: ProjectCopyProgress): void {
  db.insert(threadPluginMetadata).values({ threadId, pluginId: projectCopyNamespace, metadataJson: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [threadPluginMetadata.threadId, threadPluginMetadata.pluginId], set: { metadataJson: JSON.stringify(value) } }).run();
}

export type Binding = typeof cloudroomThreads.$inferSelect;
export type Command = typeof cloudroomCommands.$inferSelect;

export function binding(db: DbQueryConnection, threadId: string): Binding | null {
  return db.select().from(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).get() ?? null;
}

export function bindings(db: DbQueryConnection): Binding[] {
  return db.select().from(cloudroomThreads).all();
}

/** Unstamped cloud threads belong to the signed-in account. Before another account signs in, they are stamped with the old one. */
export function stampBindings(db: DbQueryConnection, accountId: string): void {
  db.update(cloudroomThreads).set({ accountId }).where(isNull(cloudroomThreads.accountId)).run();
}

export function saveBinding(db: DbQueryConnection, threadId: string, values: Partial<Omit<Binding, "threadId">>): void {
  db.update(cloudroomThreads).set(values).where(eq(cloudroomThreads.threadId, threadId)).run();
}

export function commands(db: DbQueryConnection, threadId: string): Command[] {
  return db.select().from(cloudroomCommands).where(eq(cloudroomCommands.threadId, threadId)).orderBy(cloudroomCommands.createdAt, cloudroomCommands.id).all();
}

export function queuedPrompts(db: DbQueryConnection, threadId: string): Command[] {
  const all = commands(db, threadId);
  const status = db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId)).get()?.status;
  const active = status === "active" || status === "pending" || status === "starting";
  const turnId = binding(db, threadId)?.turnId;
  const cancelling = new Set(all.filter(item => item.command === "cancel" && ["sending", "accepted", "completed"].includes(item.state)).map(item => JSON.parse(item.input).target_request_id));
  const queued = all.filter(item => item.command === "prompt" && item.id !== `first_${threadId}` && item.id !== turnId && (item.state === "accepted" || (active && item.state === "sending")) && !cancelling.has(item.id) && !JSON.parse(item.input).teleport_handoff);
  // Mirror the core: the latest reorder puts its listed prompts first; newer prompts follow in send order.
  const reorder = [...all].reverse().find(item => item.command === "reorder" && ["sending", "accepted", "completed"].includes(item.state));
  if (!reorder) return queued;
  const order: string[] = JSON.parse(reorder.input).order;
  const rank = (id: string) => { const index = order.indexOf(id); return index === -1 ? order.length : index; };
  return queued.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(({ item }) => item);
}

export function command(db: DbQueryConnection, id: string): Command | null {
  return db.select().from(cloudroomCommands).where(eq(cloudroomCommands.id, id)).get() ?? null;
}

export function unstartedTurn(db: DbQueryConnection, threadId: string): Command | null {
  const turnId = binding(db, threadId)?.turnId;
  const turn = turnId ? command(db, turnId) : null;
  return turn?.command === "prompt" && (turn.state === "sending" || turn.state === "accepted") ? turn : null;
}

export function saveCommandState(db: DbQueryConnection, threadId: string, id: string, state: string): void {
  const unstarted = unstartedTurn(db, threadId)?.id === id;
  db.update(cloudroomCommands).set({ state }).where(and(eq(cloudroomCommands.id, id), eq(cloudroomCommands.threadId, threadId))).run();
  if (unstarted && !["sending", "accepted", "running", "delivered"].includes(state)) saveStatus(db, threadId, ["failed", "unknown", "unknown_after_restart"].includes(state) ? "error" : "idle");
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
