import { cloudroomCommands, cloudroomThreads, events, threads, type DbConnection } from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import type { NotificationHub } from "../../ws/hub.js";
import type { TelemetryEvent, TelemetryExecution, TelemetryService } from "./telemetry.js";
import type { SandboxDirectory } from "../cloudroom/sandboxes.js";

const OUTPUT_TYPES: ThreadEventType[] = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
];
const TURN_TYPES: ThreadEventType[] = ["turn/started", "turn/completed"];
const MAX_WAIT_MS = 10 * 60_000;

interface SentMessage {
  afterSequence: number;
  execution: TelemetryExecution;
  isChildThread: boolean;
  messageSource: Extract<TelemetryEvent, { name: "first_response" }>["properties"]["message_source"];
  provider: string;
  sentAt: number;
  model?: string | null;
  reasoningLevel?: string | null;
  serviceTier?: string | null;
}

interface Tracker {
  db: DbConnection;
  pending: Map<string, SentMessage>;
  telemetry: TelemetryService;
  wokeSince: (threadId: string, at: number) => boolean;
  startupSince: (threadId: string, at: number) => ReturnType<SandboxDirectory["startupSince"]> | null;
}

let tracker: Tracker | null = null;

export function installFirstResponseTelemetry(
  deps: { db: DbConnection; hub: NotificationHub; telemetry: TelemetryService },
  wokeSince: Tracker["wokeSince"],
  startupSince: Tracker["startupSince"] = () => null,
): () => void {
  const current: Tracker = { db: deps.db, pending: new Map(), telemetry: deps.telemetry, wokeSince, startupSince };
  tracker = current;
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (message.entity !== "thread" || !message.changes.includes("events-appended")) return;
    const sent = current.pending.get(message.id);
    if (!sent) return;
    const types = message.metadata?.eventTypes;
    if ((!types || types.some((type) => OUTPUT_TYPES.includes(type))) && hasOutputAfter(current.db, message.id, sent.afterSequence)) {
      current.pending.delete(message.id);
      const ms = Date.now() - sent.sentAt;
      if (ms > MAX_WAIT_MS) return;
      const startup = sent.execution === "cloud_sandbox" ? current.startupSince(message.id, sent.sentAt) : null;
      current.telemetry.capture({
        name: "first_response",
        properties: {
          execution: sent.execution,
          is_child_thread: sent.isChildThread,
          message_source: sent.messageSource,
          ms,
          provider: sent.provider,
          sandbox_woke: sent.execution === "cloud_sandbox" ? current.wokeSince(message.id, sent.sentAt) : null,
          startup_source: startup?.startup_source ?? null,
          sandbox_start_ms: startup?.sandbox_start_ms ?? null,
          startup_id: startup?.startup_id ?? null,
          model: sent.model ?? null,
          reasoning_level: sent.reasoningLevel ?? null,
          service_tier: sent.serviceTier ?? null,
          harness_version: sent.provider === "codex" ? startup?.versions?.codex ?? null : sent.provider === "claude-code" ? startup?.versions?.claude ?? null : null,
        },
      });
      return;
    }
    if (types?.includes("turn/completed")) current.pending.delete(message.id);
  });
  return () => {
    unsubscribe();
    if (tracker === current) tracker = null;
  };
}

export function noteMessageSent(
  threadId: string,
  message: Omit<SentMessage, "afterSequence" | "sentAt">,
  sentAt = Date.now(),
): void {
  if (!tracker) return;
  const latest = tracker.db
    .select({ sequence: events.sequence })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const lastTurn = tracker.db
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.threadId, threadId), inArray(events.type, TURN_TYPES)))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (lastTurn?.type === "turn/started") {
    tracker.pending.delete(threadId);
    return;
  }
  const local = tracker.db.select({ model: threads.modelOverride, reasoning: threads.reasoningLevelOverride }).from(threads).where(eq(threads.id, threadId)).get();
  const cloud = message.execution === "local" ? undefined : tracker.db.select({ model: cloudroomThreads.model, reasoning: cloudroomThreads.reasoning }).from(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).get();
  let serviceTier: string | null = null;
  if (cloud) {
    const initial = tracker.db.select({ input: cloudroomCommands.input }).from(cloudroomCommands).where(eq(cloudroomCommands.id, `first_${threadId}`)).get();
    try { serviceTier = initial ? JSON.parse(initial.input).service_tier ?? "default" : null; } catch { serviceTier = null; }
  }
  tracker.pending.set(threadId, { ...message, model: cloud?.model ?? local?.model ?? null, reasoningLevel: cloud?.reasoning ?? local?.reasoning ?? null,
    serviceTier, afterSequence: latest?.sequence ?? 0, sentAt });
}

function hasOutputAfter(db: DbConnection, threadId: string, afterSequence: number): boolean {
  return db
    .select({ sequence: events.sequence })
    .from(events)
    .where(and(
      eq(events.threadId, threadId),
      gt(events.sequence, afterSequence),
      inArray(events.type, OUTPUT_TYPES),
      or(isNull(events.itemKind), ne(events.itemKind, "userMessage")),
    ))
    .limit(1)
    .get() !== undefined;
}
