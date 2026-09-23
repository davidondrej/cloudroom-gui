import { createHash } from "node:crypto";
import { commandGuardBlockReason } from "@get-bb/plugin-sdk/internal/command-guard";
import { cloudroomCommands, cloudroomThreads, deleteThreadEventSuffixInTransaction, events, threadConversationOutlines, threadSearchSegments, getThread, type DbConnection, type DbQueryConnection, type DbTransaction, type AppendStoredThreadEventArgs } from "@bb/db";
import { and, desc, eq } from "drizzle-orm";
import { appendThreadEventsInTransaction } from "../threads/thread-events.js";
import { reasoningLevelSchema, threadEventSchema, threadScope, turnScope, encodeClientTurnRequestIdNumber, type ThreadEvent } from "@bb/domain";
import { z } from "zod";
import { CloudroomError, type SessionRecord } from "./client.js";
import { binding, command, saveBinding, saveCommandState, saveStatus, effectivePrompt, type Binding, type Command } from "./store.js";

const object = z.record(z.string(), z.unknown());
const nativeFrame = z.object({ method: z.string(), params: object.optional() });
const bbRequestId = (id: string) => encodeClientTurnRequestIdNumber({ value: createHash("sha256").update(id).digest().readUIntBE(0, 6) });

function messageReasoning(input: string, fallback: string): string {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : fallback;
  } catch {
    return fallback;
  }
}

function requestedTurns(db: DbQueryConnection, threadId: string) {
  const found = new Map<string, { id: string; sequence: number }>();
  for (const row of db.select({ id: events.id, data: events.data, sequence: events.sequence }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"))).all()) {
    try {
      const requestId = JSON.parse(row.data).requestId;
      if (typeof requestId === "string") found.set(requestId, { id: row.id, sequence: row.sequence });
    } catch { /* a malformed row cannot match a live cloud request */ }
  }
  return found;
}

function promptRequestedEvent(db: DbQueryConnection, saved: Binding, request: Command): ThreadEvent {
  const stored = effectivePrompt(db, saved.threadId, request.id);
  const initial = request.id === `first_${saved.threadId}`;
  return threadEventSchema.parse({
    type: "client/turn/requested", scope: threadScope(), threadId: saved.threadId,
    direction: "outbound", requestId: bbRequestId(request.id), source: initial ? "spawn" : "tell", initiator: "user", senderThreadId: null,
    input: Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }],
    target: { kind: initial ? "thread-start" : "new-turn" }, request: { method: initial ? "thread/start" : "turn/start", params: {} },
    execution: { source: "client/turn/requested", model: saved.model, reasoningLevel: messageReasoning(JSON.stringify(stored), saved.reasoning), permissionMode: "full", serviceTier: stored.service_tier === "fast" ? "fast" : "default" },
  });
}

export function projectInitialPrompt(tx: DbTransaction, threadId: string): boolean {
  const saved = binding(tx, threadId);
  const request = command(tx, `first_${threadId}`);
  if (!saved || !request || saved.turnId ||
      !(request.state === "sending" || request.state === "accepted" || (request.state === "failed" && !saved.sessionId)) ||
      requestedTurns(tx, threadId).has(bbRequestId(request.id))) return false;
  const event = promptRequestedEvent(tx, saved, request);
  appendThreadEventsInTransaction(tx, [{
    threadId, environmentId: null, providerThreadId: saved.nativeId, createdAt: request.createdAt,
    type: event.type, scope: event.scope, data: event,
  } as AppendStoredThreadEventArgs]);
  return true;
}

export function retractStillQueuedPrompts(db: DbConnection, threadId: string, requestIds: readonly string[]): boolean {
  const wanted = new Set(requestIds.filter(id => id !== `first_${threadId}`).map(bbRequestId));
  const matches = [...requestedTurns(db, threadId)].filter(([id]) => wanted.has(id));
  if (!matches.length) return false;
  db.transaction((tx) => {
    for (const [, row] of matches) {
      tx.delete(events).where(eq(events.id, row.id)).run();
      tx.delete(threadSearchSegments).where(and(eq(threadSearchSegments.threadId, threadId), eq(threadSearchSegments.sourceKey, `event:${row.sequence}`))).run();
    }
    tx.delete(threadConversationOutlines).where(eq(threadConversationOutlines.threadId, threadId)).run();
  });
  return true;
}

export function projectRecord(db: DbConnection, threadId: string, record: SessionRecord): ThreadEvent["type"][] {
  return db.transaction((tx) => {
    const saved = binding(tx, threadId);
    if (!saved || record.sequence <= saved.cursor) return [];
    if (record.session_id !== saved.sessionId) throw new Error("Cloudroom session mismatch");
    const data = object.parse(record.data);
    const harness = getThread(tx, threadId)?.providerId;
    const projected: ThreadEvent[] = [];
    const emit = (event: unknown) => {
      const parsed = threadEventSchema.safeParse(event);
      if (!parsed.success) throw new CloudroomError(`Invalid cloud event fields: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
      projected.push(parsed.data);
    };
    if (["storage_warning", "storage_pause", "storage_recovered"].includes(record.kind)) {
      emit({ type: "system/operation", scope: threadScope(), threadId, operation: record.kind,
        operationId: `cloud-storage:${record.sequence}`, status: "completed", message: z.string().parse(data.text) });
    }
    if (record.kind === "teleport") {
      const imported = z.array(z.object({ request_id: z.string(), input: object, state: z.string() })).parse(data.prompts);
      for (const [index, prompt] of imported.entries()) {
        if (!command(tx, prompt.request_id)) tx.insert(cloudroomCommands).values({ id: prompt.request_id, threadId, command: "prompt", input: JSON.stringify(prompt.input), state: prompt.state, createdAt: (record.timestamp_ms ?? 0) + index }).run();
      }
      if (typeof data.native_id === "string") saveBinding(tx, threadId, { nativeId: data.native_id });
      emit({ type: "system/operation", scope: threadScope(), threadId, operation: "teleport", operationId: `teleport:${record.sequence}`, status: "completed", message: "Conversation continued in cloud; files may still be uploading." });
    }
    if (record.kind === "receipt") {
      const receipt = z.object({ request_id: z.string(), command: z.string(), state: z.string(), error: z.string().optional() }).parse(data);
      const previous = command(tx, receipt.request_id);
      if (!previous && ["prompt", "edit", "cancel"].includes(receipt.command) && data.input) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId, command: receipt.command as "prompt" | "edit" | "cancel", input: JSON.stringify(data.input), state: receipt.state, createdAt: record.timestamp_ms ?? 0 }).run();
      }
      saveCommandState(tx, threadId, receipt.request_id, receipt.state);
      if (receipt.command === "start" && receipt.state === "accepted" && object.parse(data.input).workspace) saveStatus(tx, threadId, "pending");
      if ((harness === "pi" || harness === "acp-cursor" || harness === "claude-code") && previous && receipt.command === "prompt" && ["completed", "failed", "interrupted", "unknown", "unknown_after_restart"].includes(receipt.state) && saved.nativeId) {
        emit({ threadId, providerThreadId: saved.nativeId, scope: turnScope(receipt.request_id), type: "turn/completed", status: receipt.state === "completed" ? "completed" : receipt.state === "interrupted" ? "interrupted" : "failed" });
      }
      if (receipt.state === "failed" && receipt.error) {
        emit({ type: "system/error", scope: threadScope(), threadId, message: receipt.error });
      }
      if (receipt.state === "accepted" && ["stop", "resume"].includes(receipt.command)) {
        saveBinding(tx, threadId, { queuePaused: receipt.command === "stop" });
      }
      if (receipt.command === "cancel" && ["accepted", "completed"].includes(receipt.state)) {
        const stored = data.input ? object.parse(data.input) : previous ? JSON.parse(previous.input) as { target_request_id?: string } : {};
        if (typeof stored.target_request_id === "string") saveCommandState(tx, threadId, stored.target_request_id, "cancelled");
      }
    }
    if (record.kind === "receipt" && data.command === "rewind" && data.state === "accepted") saveStatus(tx, threadId, "starting");
    if (record.kind === "rewind_failed") saveStatus(tx, threadId, "idle");
    if (record.kind === "native_identity" && typeof data.id === "string") {
      saveBinding(tx, threadId, { nativeId: data.id });
    }
    if (record.kind === "rewind" && typeof data.id === "string") {
      const checkpoints = tx.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "system/operation"))).all();
      const checkpoint = checkpoints.map((row) => JSON.parse(row.data)).find((event) => event.operation === "checkpoint" && event.metadata?.id === data.before);
      const cutoff = typeof checkpoint?.metadata?.request_id === "string" ? requestedTurns(tx, threadId).get(bbRequestId(checkpoint.metadata.request_id))?.sequence : undefined;
      if (cutoff !== undefined) {
        const last = tx.select({ sequence: events.sequence }).from(events).where(eq(events.threadId, threadId)).orderBy(desc(events.sequence)).get();
        deleteThreadEventSuffixInTransaction(tx, { threadId, cutoffSequence: cutoff, oldMaxSequence: last?.sequence ?? cutoff });
      }
      saveBinding(tx, threadId, { nativeId: data.id, turnId: null });
      if (typeof data.request_id === "string") saveCommandState(tx, threadId, data.request_id, "completed");
      if (data.replacement) {
        const replacement = z.object({ request_id: z.string(), input: object }).parse(data.replacement);
        if (!command(tx, replacement.request_id)) tx.insert(cloudroomCommands).values({ id: replacement.request_id, threadId, command: "prompt", input: JSON.stringify(replacement.input), state: "accepted", createdAt: record.timestamp_ms ?? 0 }).run();
      }
      emit({ type: "system/operation", scope: threadScope(), threadId, operation: "edit_message", status: "completed", message: "Message edited", operationId: String(data.request_id), metadata: { cutoffSequence: cutoff ?? null, replacementProviderThreadId: data.id } });
      emit({ type: "thread/contextWindowUsage/updated", scope: threadScope(), threadId, providerThreadId: data.id, contextWindowUsage: { usedTokens: null, modelContextWindow: null, estimated: false } });
    }
    if (record.kind === "checkpoint" && typeof data.id === "string" && saved.nativeId) {
      emit({
        type: "system/operation", scope: threadScope(), threadId,
        operation: "checkpoint", status: "completed", message: "Native rewind checkpoint",
        operationId: `${threadId}:${data.id}`,
        metadata: { kind: typeof data.kind === "string" ? data.kind : "turn", id: data.id, request_id: typeof data.request_id === "string" ? data.request_id : null },
      });
    }
    if (record.kind === "child" && saved.nativeId && typeof data.id === "string" && typeof data.request_id === "string") {
      const completed = data.state !== "started";
      const result = data.result && typeof data.result === "object" ? object.parse(data.result) : {};
      const child = tx.select({ threadId: cloudroomThreads.threadId }).from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, saved.coreUrl), eq(cloudroomThreads.sessionId, data.id))).get();
      emit({ type: completed ? "item/delegation/completed" : "item/delegation/progress", scope: threadScope(), threadId, providerThreadId: saved.nativeId,
        item: { type: "delegation", id: `child:${data.id}`, childRef: child?.threadId ?? data.id, label: "Cloud child", background: true,
          status: !completed ? "pending" : data.state === "completed" ? "completed" : "failed",
          ...(typeof result.result === "string" ? { summary: result.result } : {}) } });
    }
    if (record.kind === "usage" && saved.nativeId && (data.contextUsage !== undefined || data.used !== undefined || data.usedTokens !== undefined || data.contextWindow !== undefined)) {
      const context = data.contextUsage && typeof data.contextUsage === "object" ? object.parse(data.contextUsage) : data;
      const used = typeof context.tokens === "number" ? context.tokens : typeof context.used === "number" ? context.used : typeof context.usedTokens === "number" ? context.usedTokens : null;
      const total = typeof context.contextWindow === "number" ? context.contextWindow : typeof context.total === "number" ? context.total : typeof context.modelContextWindow === "number" ? context.modelContextWindow : null;
      emit({
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        threadId, providerThreadId: saved.nativeId,
        contextWindowUsage: { usedTokens: used, modelContextWindow: total, estimated: harness === "pi" },
      });
      if (data.tokens && data.lastUsage && saved.turnId) {
        const totals = object.parse(data.tokens);
        const last = object.parse(data.lastUsage);
        const breakdown = (value: Record<string, unknown>, total: unknown) => ({
          totalTokens: Number(total ?? 0), inputTokens: Number(value.input ?? 0), outputTokens: Number(value.output ?? 0),
          cachedInputTokens: Number(value.cacheRead ?? 0), cacheReadInputTokens: Number(value.cacheRead ?? 0), cacheWriteInputTokens: Number(value.cacheWrite ?? 0), reasoningOutputTokens: 0,
        });
        emit({ type: "thread/tokenUsage/updated", scope: turnScope(saved.turnId), threadId, providerThreadId: saved.nativeId,
          tokenUsage: { total: breakdown(totals, totals.total), last: breakdown(last, last.totalTokens), modelContextWindow: total } });
      }
    }
    if (record.kind === "state") {
      const state = z.string().parse(data.state);
      if (state === "starting_turn" && typeof data.request_id === "string") {
        saveBinding(tx, threadId, { turnId: data.request_id });
        const request = command(tx, data.request_id);
        saveCommandState(tx, threadId, data.request_id, "running");
        if (request?.command === "prompt" && !JSON.parse(request.input).teleport_handoff && !requestedTurns(tx, threadId).has(bbRequestId(data.request_id))) {
          emit(promptRequestedEvent(tx, saved, request));
        }
        if ((harness === "pi" || harness === "acp-cursor" || harness === "claude-code") && saved.nativeId) {
          const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(data.request_id) };
          emit({ ...base, type: "turn/started" });
          emit({ ...base, type: "turn/input/accepted", clientRequestId: bbRequestId(data.request_id) });
        }
      }
      saveStatus(tx, threadId,
        state === "pending" || state === "waiting_for_files" ? "pending" :
        ["starting", "resuming"].includes(state) ? "starting" :
        ["starting_turn", "running"].includes(state) ? "active" :
        state === "interrupting" ? "stopping" :
        ["failed", "process_lost"].includes(state) ? "error" : "idle");
      if (["failed", "process_lost"].includes(state)) emit({
        type: "system/error", scope: threadScope(), threadId,
        message: typeof data.reason === "string" ? data.reason : "Cloudroom execution failed",
      });
    }
    if (harness === "claude-code" && data.harness === "claude-code" && saved.nativeId && typeof data.request_id === "string") {
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(data.request_id) };
      const id = typeof data.item_id === "string" ? `${data.request_id}:${data.item_id}` : null;
      if (id && (record.kind === "text_delta" || record.kind === "thinking_delta")) {
        emit({ ...base, type: record.kind === "text_delta" ? "item/agentMessage/delta" : "item/reasoning/textDelta", itemId: id, delta: z.string().parse(data.delta) });
      } else if (id && ["item_started", "item_completed"].includes(record.kind)) {
        const type = record.kind === "item_started" ? "item/started" : "item/completed";
        if (data.item_type === "text") emit({ ...base, type, item: { type: "agentMessage", id, text: typeof data.text === "string" ? data.text : "" } });
        else if (data.item_type === "thinking") emit({ ...base, type, item: { type: "reasoning", id, summary: [], content: typeof data.text === "string" && data.text ? [data.text] : [] } });
        else if (data.item_type === "tool_use") emit({ ...base, type, item: {
          type: "toolCall", id, tool: typeof data.tool_name === "string" ? data.tool_name : "Claude tool", status: record.kind === "item_started" ? "pending" : data.is_error === true ? "failed" : "completed",
          ...(data.input && typeof data.input === "object" ? { arguments: data.input } : {}), ...(data.result !== undefined ? { result: data.result } : {}),
        } });
      }
    }
    if (harness === "pi" && record.native && record.kind !== "native_record" && saved.nativeId && saved.turnId) {
      const frame = object.parse(JSON.parse(record.native));
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(saved.turnId) };
      const latestMessage = () => tx.select({ id: events.itemId }).from(events).where(and(eq(events.threadId, threadId), eq(events.turnId, saved.turnId!), eq(events.type, "item/started"), eq(events.itemKind, "agentMessage"))).orderBy(desc(events.sequence)).limit(1).get()?.id;
      const contentText = (value: unknown) => {
        const content = object.parse(value).content;
        return Array.isArray(content) ? content.map((part) => { const item = object.parse(part); return item.type === "text" && typeof item.text === "string" ? item.text : ""; }).filter(Boolean).join("\n") : "";
      };
      if (frame.type === "message_start" && object.parse(frame.message).role === "assistant") {
        emit({ ...base, type: "item/started", item: { type: "agentMessage", id: `${saved.turnId}:pi:${record.sequence}`, text: "" } });
      } else if (frame.type === "message_update") {
        const update = object.parse(frame.assistantMessageEvent);
        if (["text_delta", "thinking_start", "thinking_delta"].includes(String(update.type))) {
          const id = latestMessage();
          if (!id) throw new CloudroomError("Pi message update has no recorded message start");
          if (update.type === "thinking_start") emit({ ...base, type: "item/started", item: { type: "reasoning", id: `${id}:thinking`, summary: [], content: [] } });
          else emit({ ...base, type: update.type === "text_delta" ? "item/agentMessage/delta" : "item/reasoning/textDelta", itemId: update.type === "text_delta" ? id : `${id}:thinking`, delta: z.string().parse(update.delta) });
        }
      } else if (frame.type === "message_end" && object.parse(frame.message).role === "assistant") {
        const id = latestMessage();
        if (!id) throw new CloudroomError("Pi message completion has no recorded message start");
        const message = object.parse(frame.message);
        emit({ ...base, type: "item/completed", item: { type: "agentMessage", id, text: contentText(message) } });
        const thinking = Array.isArray(message.content) ? message.content.map(part => object.parse(part)).filter(part => part.type === "thinking" && typeof part.thinking === "string").map(part => part.thinking) : [];
        if (thinking.length) emit({ ...base, type: "item/completed", item: { type: "reasoning", id: `${id}:thinking`, summary: [], content: thinking } });
        if (typeof message.errorMessage === "string") emit({ type: "system/error", scope: threadScope(), threadId, message: message.errorMessage });
      } else if (frame.customType === "cloudroom_subagent" || (frame.type === "custom" && frame.customType === "cloudroom_subagent")) {
        let payload: { id?: string; state?: string; result?: string } = {};
        try { payload = JSON.parse(String(frame.content ?? "{}")); } catch { payload = {}; }
        if (typeof payload.id === "string") {
          emit({
            ...base,
            type: payload.state === "completed" ? "item/completed" : "item/started",
            item: {
              type: "delegation",
              id: `${saved.turnId}:${payload.id}`,
              childRef: payload.id,
              label: "child",
              status: payload.state === "completed" ? "completed" : "pending",
              background: false,
              ...(typeof payload.result === "string" ? { summary: payload.result } : {}),
            },
          });
        }
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(frame.type))) {
        const id = `${saved.turnId}:${z.string().parse(frame.toolCallId)}`;
        if (frame.type === "tool_execution_update") emit({ ...base, type: "item/toolCall/progress", itemId: id, message: contentText(frame.partialResult) });
        else emit({ ...base, type: frame.type === "tool_execution_start" ? "item/started" : "item/completed", item: {
          type: "toolCall", id, tool: z.string().parse(frame.toolName), status: frame.type === "tool_execution_start" ? "pending" : frame.isError ? "failed" : "completed",
          ...(frame.args ? { arguments: object.parse(frame.args) } : {}), ...(frame.result ? { result: frame.result } : {}),
        } });
      }
    }
    if (harness === "acp-cursor" && saved.nativeId && saved.turnId && data.harness === "cursor") {
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(saved.turnId) };
      const itemId = `${saved.turnId}:${String(data.item_id)}`;
      if (record.kind === "text_delta" || record.kind === "thinking_delta") {
        emit({ ...base, type: record.kind === "text_delta" ? "item/agentMessage/delta" : "item/reasoning/textDelta", itemId, delta: z.string().parse(data.delta) });
      } else if (["item_started", "item_completed", "tool_snapshot"].includes(record.kind)) {
        const completed = record.kind === "item_completed";
        const type = completed ? "item/completed" : "item/started";
        if (data.item_type === "agentMessage") emit({ ...base, type, item: { type: "agentMessage", id: itemId, text: String(data.text ?? "") } });
        else if (data.item_type === "reasoning") emit({ ...base, type, item: { type: "reasoning", id: itemId, summary: [], content: data.text ? [String(data.text)] : [] } });
        else if (data.tool) {
          const tool = object.parse(data.tool);
          const argumentsValue = object.safeParse(tool.rawInput);
          if (record.kind === "tool_snapshot") emit({ ...base, type: "item/toolCall/progress", itemId, message: JSON.stringify(tool.content ?? []) });
          else emit({ ...base, type, item: { type: "toolCall", id: itemId, tool: String(tool.title ?? tool.kind ?? "Cursor tool"),
            status: !completed ? "pending" : tool.status === "completed" ? "completed" : "failed",
            ...(argumentsValue.success ? { arguments: argumentsValue.data } : {}),
            ...(completed ? { result: tool.rawOutput ?? tool.content ?? null } : {}) } });
        }
      } else if (record.kind === "warning") emit({ ...base, type: "provider/warning", category: "general", summary: z.string().parse(data.message) });
    }
    if (harness === "codex" && record.native && record.kind !== "native_record") {
      const parsed = nativeFrame.safeParse(JSON.parse(record.native));
      if (parsed.success && saved.nativeId && saved.turnId) {
        const { method, params = {} } = parsed.data;
        if (!params.threadId || params.threadId === saved.nativeId) {
          const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(saved.turnId) };
          const itemId = (id: unknown) => `${saved.turnId}:${z.string().parse(id)}`;
          if (method === "turn/started") {
            emit({ ...base, type: method });
            const request = command(tx, saved.turnId);
            if (request?.command === "prompt") {
              emit({ ...base, type: "turn/input/accepted", clientRequestId: bbRequestId(request.id) });
            }
          } else if (method === "turn/completed") {
            const turn = object.parse(params.turn);
            emit({ ...base, type: method, status: turn.status, ...(turn.error ? { error: turn.error } : {}) });
          } else if (["item/started", "item/completed"].includes(method)) {
            const native = object.parse(params.item);
            if (native.type === "subAgentActivity" || native.type === "collabAgentToolCall") {
              const childRef = String(native.agentThreadId ?? (Array.isArray(native.receiverThreadIds) ? native.receiverThreadIds[0] : "") ?? "");
              if (childRef) {
                emit({
                  ...base,
                  type: method === "item/started" ? "item/started" : "item/completed",
                  item: {
                    type: "delegation",
                    id: itemId(native.id),
                    childRef,
                    label: String(native.agentPath ?? native.tool ?? "child"),
                    status: method === "item/started" ? "pending" : "completed",
                    background: native.type === "subAgentActivity",
                  },
                });
              }
            } else if (native.type !== "userMessage") {
              const item: Record<string, unknown> = { ...native, id: itemId(native.id), status: method === "item/started" ? "pending" : ["failed", "declined"].includes(String(native.status)) ? "failed" : native.status === "interrupted" ? "interrupted" : "completed", approvalStatus: null };
              for (const key of ["exitCode", "durationMs", "aggregatedOutput"]) if (item[key] === null) delete item[key];
              if (native.type === "fileChange" && Array.isArray(native.changes)) item.changes = native.changes.map((entry) => {
                const change = object.parse(entry);
                const kind = typeof change.kind === "string" ? change.kind : object.parse(change.kind).type;
                return { ...change, kind };
              });
              const event = threadEventSchema.safeParse({ ...base, type: method, item });
              if (event.success) projected.push(event.data);
              else emit({ ...base, type: method, item: { type: "toolCall", id: itemId(native.id), tool: String(native.type), status: item.status, result: native } });
            }
          } else if (/^item\/(agentMessage\/delta|commandExecution\/outputDelta|fileChange\/outputDelta|reasoning\/(summaryTextDelta|textDelta)|plan\/delta)$/.test(method)) {
            emit({ ...base, type: method, itemId: itemId(params.itemId), delta: z.string().parse(params.delta) });
          } else if (method === "thread/compacted") {
            emit({ ...base, type: "thread/compacted" });
          } else if (method === "hook/completed") {
            const reason = commandGuardBlockReason(params);
            if (reason) emit({ ...base, type: "provider/warning", category: "general", summary: reason });
          } else if (method === "error") {
            const error = object.parse(params.error);
            emit({ type: "system/error", scope: threadScope(), threadId, message: z.string().parse(error.message) });
          }
        }
      }
    }
    appendThreadEventsInTransaction(tx, projected.map((event) => ({
      threadId, environmentId: null, providerThreadId: saved.nativeId, createdAt: record.timestamp_ms,
      type: event.type, scope: event.scope, data: event,
    } as AppendStoredThreadEventArgs)));
    saveBinding(tx, threadId, { cursor: record.sequence, error: null });
    return projected.map((event) => event.type);
  });
}
