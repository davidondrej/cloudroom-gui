import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { events, findLastCompletedRootStoredTurn, findLastRootStoredTurnStarted, getThread, listStoredTurnCompletedRowsByTurnIds, type DbConnection } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { UPLOAD_PART, type CloudroomClient, type Harness, type TeleportManifest } from "./client.js";
import { cloudroom } from "./commands.js";
import { binding } from "./store.js";
import { download, findNative, vm } from "./teleport-local.js";

/** A Cloud fork: a new Cloud thread, in its own sandbox, that continues another Cloud thread's conversation
 *  from a chosen turn, with that thread's code (docs/scopes/sandboxes.md). Saved in the fork's first message. */
export const cloudForkSchema = z.object({
  source_thread_id: z.string(),
  end_sequence: z.number(),
  before: z.string().optional(),
  last_turn_id: z.string().optional(),
  transfer: z.string().optional(),
});
export type CloudFork = z.infer<typeof cloudForkSchema>;

export const FORK_HARNESSES: readonly string[] = ["claude-code", "codex"];
export const FORK_HINT = "[Cloud fork]\nThis conversation was forked from another Cloud thread and now runs in its own new sandbox. Cloudroom is copying that thread's code (its commits and uncommitted changes) into this folder. If files you worked on are missing or out of date, wait briefly and check again instead of recreating them.";
// Core takes teleport uploads in 1 MB parts.
const PART = 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function cloudForkOf(input: string | undefined): CloudFork | null {
  const fork = input ? (JSON.parse(input) as { fork?: unknown }).fork : undefined;
  return fork ? cloudForkSchema.parse(fork) : null;
}

/** Keeps the turn holding `sourceSeqEnd` (or the last finished turn) and everything before it, like a Local fork. */
export function cloudForkPoint(db: DbConnection, source: Thread, sourceSeqEnd: number | undefined): CloudFork {
  const started = sourceSeqEnd === undefined ? findLastCompletedRootStoredTurn(db, { threadId: source.id }) : findLastRootStoredTurnStarted(db, { threadId: source.id, atOrBeforeSequence: sourceSeqEnd });
  const completed = started && listStoredTurnCompletedRowsByTurnIds(db, { threadId: source.id, turnIds: [started.turnId] }).at(-1);
  if (!started || !completed) throw new ApiError(400, "fork_source_session_unavailable", "Fork from a message whose turn has finished.");
  const checkpoints = db.select({ sequence: events.sequence, data: events.data }).from(events)
    .where(and(eq(events.threadId, source.id), eq(events.type, "system/operation"))).orderBy(asc(events.sequence)).all()
    .map((row) => ({ sequence: row.sequence, ...(JSON.parse(row.data) as { operation?: string; metadata?: { id?: unknown; request_id?: unknown } }) }))
    .filter((event) => event.operation === "checkpoint" && typeof event.metadata?.id === "string");
  const fork = { source_thread_id: source.id, end_sequence: completed.sequence };
  // Codex checkpoints a turn when it ends. Claude checkpoints the user message that starts the next turn;
  // with no next turn yet, the fork copies the whole conversation.
  if (source.providerId === "codex") {
    const own = checkpoints.find((event) => event.metadata?.request_id === started.turnId);
    if (!own) throw new ApiError(400, "fork_source_session_unavailable", "That turn has no saved checkpoint to fork from.");
    return { ...fork, last_turn_id: own.metadata!.id as string };
  }
  const next = checkpoints.find((event) => event.sequence > completed.sequence);
  return next ? { ...fork, before: next.metadata!.id as string } : fork;
}

/** Copies the source conversation into this thread's new sandbox and waits until its agent is ready. The code
 *  snapshot starts at the same time and is applied once the project copy lands (`landForkCode`). */
export async function startCloudFork(
  deps: Parameters<typeof cloudroom>[0], client: CloudroomClient, threadId: string, fork: CloudFork,
  start: Omit<TeleportManifest, "request_id" | "harness" | "native_id" | "files" | "handoff" | "queued" | "fork">,
  saveTransfer: (id: string) => void,
): Promise<{ sessionId: string; transfer: string; code: Promise<Buffer | Error | null> }> {
  const source = binding(deps.db, fork.source_thread_id);
  const harness = getThread(deps.db, fork.source_thread_id)?.providerId;
  if (!source?.sessionId || !source.nativeId || !/^[A-Za-z0-9_-]+$/.test(source.nativeId) || !harness || !FORK_HARNESSES.includes(harness))
    throw new ApiError(409, "fork_source_unavailable", "The source Cloud thread has no saved conversation to fork.");
  const from = await cloudroom(deps).threadClient(fork.source_thread_id);
  const workspace = (await from.sessionWorkspace(source.sessionId)).path;
  const snapshot = (id: string) => sourceCode(from, workspace, id).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  // A retry after activation keeps the started fork instead of starting a second one.
  const done = fork.transfer ? await client.teleportStatus(fork.transfer).catch(() => null) : null;
  if (fork.transfer && done?.session_id) {
    await idle(client, done.session_id);
    return { sessionId: done.session_id, transfer: fork.transfer, code: snapshot(fork.transfer) };
  }
  const transfer = `fork_${randomUUID().replaceAll("-", "")}`;
  const code = snapshot(transfer);
  const path = (await vm(from, findNative(harness as "codex" | "claude-code", source.nativeId))).toString().trim();
  if (!path) throw new ApiError(409, "fork_source_unavailable", "The source conversation file was not found in its sandbox.");
  const file = await download(from, path);
  // The source may be writing its next turn; a partial last line is not part of the fork.
  const data = file.subarray(0, file.lastIndexOf(10) + 1);
  const sha256 = createHash("sha256").update(data).digest("hex");
  saveTransfer(transfer);
  await client.prepareTeleport({
    ...start, request_id: transfer, harness: harness as Harness, native_id: source.nativeId, handoff: "", queued: [], fork: true,
    files: [{ path: basename(path), size: data.length, sha256, kind: "native", executable: false }],
  });
  for (let offset = 0; offset < data.length; offset += PART)
    await client.uploadTeleport(transfer, 0, offset, sha256, data.subarray(offset, offset + PART), data.length);
  const sessionId = (await client.activateTeleport(transfer)).session_id;
  if (!sessionId) throw new ApiError(503, "fork_start_failed", "The fork's sandbox did not start its agent.");
  await idle(client, sessionId);
  return { sessionId, transfer, code };
}

/** A fork's first message is a native fork (a rewind), which needs the resumed agent to be idle. */
async function idle(client: CloudroomClient, sessionId: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const session = await client.session(sessionId);
    if (session.state === "idle" || session.current_request !== null) return;
    if (["failed", "process_lost", "closed"].includes(session.state) || tries === 240)
      throw new ApiError(503, "fork_start_failed", `The fork's agent did not start (${session.state}).`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The source's branch plus its uncommitted changes as one extra commit, packed as a Git bundle. The source is untouched. */
async function sourceCode(from: CloudroomClient, workspace: string, id: string): Promise<Buffer | null> {
  const ref = `refs/cloudroom/${id}`;
  const packed = (await vm(from, [
    `cd ${quote(workspace)} 2>/dev/null && git rev-parse -q --verify HEAD >/dev/null || exit 0`,
    // A temporary index, so the source's own staging area stays as it was. An empty file is not a valid index.
    `index=$(mktemp) && rm -f "$index" && trap 'rm -f "$index"; git update-ref -d ${ref} 2>/dev/null' EXIT`,
    `cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null`,
    `GIT_INDEX_FILE="$index" git add -A >/dev/null 2>&1 && tree=$(GIT_INDEX_FILE="$index" git write-tree) || exit 1`,
    `commit=$(git -c user.name=Cloudroom -c user.email=cloudroom@localhost commit-tree "$tree" -p HEAD -m 'Cloudroom fork: uncommitted changes') || exit 1`,
    `git update-ref ${ref} "$commit" && mkdir -p ~/.cache/cloudroom || exit 1`,
    `f=~/.cache/cloudroom/${id}.bundle`,
    `{ git bundle create -q "$f" ${ref} --not --remotes 2>/dev/null || git bundle create -q "$f" ${ref}; } && echo "$f"`,
  ].join("\n"))).toString().trim();
  if (!packed) return null;
  try { return await download(from, packed, 500); }
  finally { await vm(from, `rm -f ${quote(packed)}`).catch(() => {}); }
}

/** Puts the source's code in the fork's folder once its project copy landed. Returns why it could not, or null. */
export async function landForkCode(client: CloudroomClient, started: { sessionId: string; transfer: string; code: Promise<Buffer | Error | null> | null }): Promise<string | null> {
  const bundle = await started.code;
  if (!bundle) return "The source thread's code was not copied, since its folder has no Git history.";
  try {
    if (bundle instanceof Error) throw bundle;
    await applyForkCode(client, (await client.sessionWorkspace(started.sessionId)).path, started.transfer, bundle);
    return null;
  } catch (error) {
    return `The source thread's code could not be copied: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

/** Moves the fork's branch to the source's commit and leaves the source's uncommitted changes uncommitted. */
async function applyForkCode(client: CloudroomClient, workspace: string, id: string, bundle: Buffer): Promise<void> {
  const file = `.cache/cloudroom/${id}.bundle`;
  for (let offset = 0; offset < bundle.length; offset += UPLOAD_PART) {
    const part = new Uint8Array(bundle.subarray(offset, offset + UPLOAD_PART));
    const result = await client.runOnVm({ command: `mkdir -p ~/.cache/cloudroom && truncate -s ${offset} ~/${file} && cat >> ~/${file}` }, undefined, part);
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || "The code upload failed.");
  }
  await vm(client, [
    `cd ${quote(workspace)} && git rev-parse --git-dir >/dev/null 2>&1 || { echo 'The project folder has no Git repository.' >&2; rm -f ~/${file}; exit 1; }`,
    `{ git fetch -q ~/${file} refs/cloudroom/${id} 2>/dev/null || { git fetch -q origin; git fetch -q ~/${file} refs/cloudroom/${id}; }; } && git reset -q --hard FETCH_HEAD && git reset -q HEAD~1`,
    `code=$?; rm -f ~/${file}; exit $code`,
  ].join("\n"));
}
