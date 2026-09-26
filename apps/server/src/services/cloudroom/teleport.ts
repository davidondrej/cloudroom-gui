import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import {
  cloudroomThreads,
  cloudroomCommands,
  events,
  getAppSettings,
  getEnvironment,
  getProject,
  getThread,
  listNonDeletedChildThreads,
  listQueuedThreadMessages,
  queuedThreadMessages,
  threads,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import type { PromptInput } from "@bb/domain";
import { ApiError } from "../../errors.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { workspaceContextFromPath } from "../environments/workspace-command-target.js";
import {
  getLastExecutionOptions,
  getLastProviderThreadId,
} from "../threads/thread-events.js";
import { stopThreadForCurrentState } from "../threads/thread-lifecycle.js";
import { resolveThreadRuntimeCommandConfig } from "../threads/thread-runtime-config.js";
import { cloudroom, promptPayload } from "./commands.js";
import { copyProject, planProjectCopy } from "./project-copy.js";
import {
  CloudroomError,
  type TeleportManifest,
  type TeleportStatus,
} from "./client.js";
import {
  binding,
  pendingTeleports,
  saveBinding,
  saveTeleportProgress,
  teleportProgress,
  type TeleportProgress,
} from "./store.js";

interface State {
  id: string;
  threadId: string;
  hostId: string;
  environmentId: string;
  workspacePath: string;
  sessions: {
    threadId: string;
    nativeId: string;
    harness: Harness;
    environmentId: string;
  }[];
  attachments: string[];
  queuedIds: string[];
  queued: TeleportManifest["queued"];
  model: string;
  sourceModel?: string;
  reasoning: string;
  serviceTier: string;
  manifest?: TeleportManifest;
  queuedDisplay?: PromptInput[][];
  retryRequestId?: string;
  cancelRequested?: boolean;
  stopped?: boolean;
  activationRequested?: boolean;
}
// GUI provider ID → cloud core harness ID.
const HARNESSES = {
  codex: "codex",
  pi: "pi",
  "claude-code": "claude-code",
  "acp-cursor": "cursor",
} as const;
type Harness = (typeof HARNESSES)[keyof typeof HARNESSES];
function harnessOf(providerId: string): Harness | undefined {
  return HARNESSES[providerId as keyof typeof HARNESSES];
}
const services = new WeakMap<AppDeps["db"], Teleport>();
export function teleports(deps: AppDeps): Teleport {
  let service = services.get(deps.db);
  if (!service) {
    service = new Teleport(deps);
    services.set(deps.db, service);
  }
  return service;
}

class Teleport {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly deps: AppDeps) {}
  private save(state: State): void {
    this.deps.db
      .update(cloudroomCommands)
      .set({ input: JSON.stringify(state) })
      .where(eq(cloudroomCommands.id, state.id))
      .run();
  }
  private load(id: string): State {
    const row = this.deps.db
      .select({ input: cloudroomCommands.input })
      .from(cloudroomCommands)
      .where(eq(cloudroomCommands.id, id))
      .get();
    if (!row)
      throw new Error(
        "Saved transfer is unavailable; local execution remains blocked.",
      );
    return JSON.parse(row.input) as State;
  }
  private notify(threadId: string) {
    this.deps.hub.notifyThread(threadId, ["status-changed"]);
    const projectId = getThread(this.deps.db, threadId)?.projectId;
    if (projectId) this.deps.hub.notifyProject(projectId, ["threads-changed"]);
  }
  private progress(state: State, values: Partial<TeleportProgress>) {
    const previous = teleportProgress(this.deps.db, state.threadId);
    if (
      previous?.id !== state.id ||
      ["cancelled", "cancelling"].includes(previous.phase)
    )
      return;
    const progress: TeleportProgress = { ...previous, ...values };
    saveTeleportProgress(this.deps.db, state.threadId, progress);
    this.notify(state.threadId);
  }
  private async preflight(
    providerId: string,
    execution: { model: string; reasoning: string; serviceTier: string },
    retry = false,
  ) {
    const harness = harnessOf(providerId)!;
    const separator = execution.model.indexOf("/");
    const result = await (
      await cloudroom(this.deps).teleportClient()
    ).checkTeleport({
      harness,
      model:
        harness === "pi" && separator > 0
          ? execution.model.slice(separator + 1)
          : execution.model,
      reasoning: execution.reasoning,
      service_tier: execution.serviceTier,
    });
    if (!result.ok)
      throw new ApiError(
        409,
        result.code === "model_unavailable"
          ? "teleport_model_unavailable"
          : "teleport_check_failed",
        `${retry ? "Retry did not start." : "Teleport did not start; this thread stays local."} ${result.error}`,
      );
  }
  async begin(
    threadId: string,
    choice?: { model: string; reasoning: string },
  ): Promise<TeleportProgress> {
    const existing = teleportProgress(this.deps.db, threadId);
    if (existing && existing.phase !== "cancelled") {
      if (existing.owner !== threadId)
        throw new ApiError(
          409,
          "teleport_in_progress",
          "This child belongs to its parent's Teleport transfer.",
        );
      if (existing.phase === "complete") return existing;
      if (existing.phase === "error") {
        const saved = this.load(existing.id);
        await this.preflight(
          getThread(this.deps.db, threadId)!.providerId,
          saved,
          true,
        );
        if (existing.cloudStarted)
          this.save({ ...saved, retryRequestId: randomUUID() });
        saveTeleportProgress(this.deps.db, threadId, {
          ...existing,
          phase: existing.cloudStarted ? "running" : "stopping",
          error: undefined,
        });
      }
      this.launch(threadId, existing.id);
      return teleportProgress(this.deps.db, threadId)!;
    }
    if (this.active.has(threadId))
      throw new ApiError(
        409,
        "teleport_cancelling",
        "Cancellation is finishing. Retry Teleport once it settles.",
      );
    await cloudroom(this.deps).teleportClient();
    const thread = getThread(this.deps.db, threadId);
    const environment = thread?.environmentId
      ? getEnvironment(this.deps.db, thread.environmentId)
      : null;
    if (
      !thread ||
      thread.executionTarget === "cloud" ||
      thread.parentThreadId ||
      thread.archivedAt ||
      thread.deletedAt ||
      !environment?.path ||
      environment.isWorktree
    )
      throw new ApiError(
        409,
        "teleport_unavailable",
        "Teleport requires a local parent thread in its primary checkout.",
      );
    if (!harnessOf(thread.providerId))
      throw new ApiError(
        409,
        "teleport_unavailable",
        "Teleport supports Codex, Pi, Claude Code, and Cursor.",
      );
    const all = [thread];
    for (let i = 0; i < all.length; i++)
      all.push(
        ...listNonDeletedChildThreads(this.deps.db, {
          parentThreadId: all[i]!.id,
        }),
      );
    const sessions = all.map((source) => {
      const env = source.environmentId
        ? getEnvironment(this.deps.db, source.environmentId)
        : null;
      const nativeId = getLastProviderThreadId(this.deps, source.id);
      if (
        !env ||
        env.hostId !== environment.hostId ||
        env.isWorktree ||
        env.path !== environment.path ||
        !nativeId ||
        !harnessOf(source.providerId)
      )
        throw new ApiError(
          409,
          "teleport_unavailable",
          `Cannot capture the saved local conversation for ${source.title ?? source.id}.`,
        );
      return {
        threadId: source.id,
        nativeId,
        harness: harnessOf(source.providerId)!,
        environmentId: env.id,
      };
    });
    const last = getLastExecutionOptions(this.deps, threadId);
    if (!last?.model)
      throw new ApiError(
        409,
        "teleport_unavailable",
        "The thread has no saved model selection.",
      );
    const execution = {
      model: choice?.model ?? last.model,
      reasoning: choice?.reasoning ?? last.reasoningLevel ?? "none",
      serviceTier: last.serviceTier ?? "default",
    };
    const queuedRows = all.flatMap((source) =>
      listQueuedThreadMessages(this.deps.db, source.id),
    );
    if (queuedRows.some((row) => row.model !== last.model))
      throw new ApiError(
        409,
        "teleport_queue_model",
        "A queued message selects a different model. Align the queued models first; Cloud keeps one model per thread.",
      );
    await this.preflight(thread.providerId, execution);
    const queued = queuedRows.map((row) => {
      const content = JSON.parse(row.content) as {
        type: string;
        text?: string;
        path?: string;
      }[];
      return {
        text: content
          .map((part) =>
            part.type === "text"
              ? (part.text ?? "")
              : `[Attachment uploading separately: ${part.path ?? "file"}]`,
          )
          .join("\n"),
        reasoning: row.reasoningLevel,
        service_tier: row.serviceTier,
      };
    });
    const attachments = new Set<string>();
    for (const source of all) {
      const rows = this.deps.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, source.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(asc(events.sequence))
        .all();
      for (const input of [
        ...rows.map((row) => JSON.parse(row.data).input),
        ...queuedRows
          .filter((row) => row.threadId === source.id)
          .map((row) => JSON.parse(row.content)),
      ]) {
        if (!Array.isArray(input)) continue;
        for (const part of input)
          if (
            ["localImage", "localFile"].includes(part.type) &&
            typeof part.path === "string"
          )
            attachments.add(
              isAbsolute(part.path)
                ? part.path
                : join(
                    this.deps.config.dataDir,
                    "attachments",
                    source.projectId,
                    part.path,
                  ),
            );
      }
    }
    const state: State = {
      id: randomUUID(),
      threadId,
      hostId: environment.hostId,
      environmentId: environment.id,
      workspacePath: environment.path,
      sessions,
      attachments: [...attachments],
      queuedIds: queuedRows.map((row) => row.id),
      queued,
      ...execution,
      ...(execution.model !== last.model ? { sourceModel: last.model } : {}),
    };
    this.deps.db.transaction((tx) => {
      if (
        teleportProgress(tx, threadId)?.phase &&
        teleportProgress(tx, threadId)?.phase !== "cancelled"
      )
        throw new ApiError(
          409,
          "teleport_in_progress",
          "Teleport is already in progress.",
        );
      if (binding(tx, threadId))
        throw new ApiError(
          409,
          "teleport_in_progress",
          "This thread already has cloud ownership metadata.",
        );
      tx.insert(cloudroomThreads)
        .values({
          threadId,
          coreUrl: cloudroom(this.deps).teleportUrl,
          startRequestId: `teleport_${state.id}`,
          model: state.model,
          reasoning: state.reasoning,
        })
        .run();
      tx.insert(cloudroomCommands)
        .values({
          id: state.id,
          threadId,
          command: "teleport",
          input: JSON.stringify(state),
          state: "transferring",
          createdAt: Date.now(),
        })
        .run();
      for (const source of sessions)
        saveTeleportProgress(tx, source.threadId, {
          id: state.id,
          owner: threadId,
          phase: "stopping",
          completed: 0,
          total: 0,
        });
    });
    this.notify(threadId);
    this.launch(threadId, state.id);
    return teleportProgress(this.deps.db, threadId)!;
  }
  async cancel(threadId: string): Promise<void> {
    const progress = teleportProgress(this.deps.db, threadId);
    if (!progress || progress.owner !== threadId)
      throw new ApiError(
        409,
        "teleport_unavailable",
        "No parent transfer to cancel.",
      );
    if (progress.cloudStarted || progress.phase === "complete")
      throw new ApiError(
        409,
        "teleport_running",
        "The cloud agent has started. Use Stop.",
      );
    const state = this.load(progress.id);
    state.cancelRequested = true;
    this.save(state);
    this.progress(state, { phase: "cancelling" });
    if (
      state.stopped &&
      !state.activationRequested &&
      !this.active.has(threadId)
    ) {
      this.finishCancellation(state);
      return;
    }
    this.launch(threadId, state.id);
  }
  /** Stop and Archive always win: end the transfer and release the thread. */
  abandon(threadId: string): void {
    const progress = teleportProgress(this.deps.db, threadId);
    if (
      progress?.owner !== threadId ||
      ["complete", "cancelled"].includes(progress.phase)
    )
      return;
    try {
      const state = { ...this.load(progress.id), cancelRequested: true };
      this.save(state);
      // After activation is requested, cloud may own the session. Keep its
      // binding so the run can confirm ownership and stop the cloud agent.
      const cloudMayOwn = Boolean(
        progress.cloudStarted || state.activationRequested,
      );
      this.finishCancellation(state, cloudMayOwn);
      if (cloudMayOwn && !progress.cloudStarted)
        this.launch(threadId, state.id);
    } catch (error) {
      this.deps.logger.warn(
        { threadId, error },
        "Teleport state was unavailable during archive",
      );
      saveTeleportProgress(this.deps.db, threadId, {
        ...progress,
        phase: "cancelled",
      });
      this.notify(threadId);
    }
  }
  private finishCancellation(state: State, keepBinding = false) {
    this.deps.db.transaction((tx) => {
      for (const source of state.sessions) {
        if (teleportProgress(tx, source.threadId)?.id !== state.id) continue;
        saveTeleportProgress(tx, source.threadId, {
          id: state.id,
          owner: state.threadId,
          phase: "cancelled",
          completed: 0,
          total: 0,
        });
      }
      if (!keepBinding)
        tx.delete(cloudroomThreads)
          .where(
            and(
              eq(cloudroomThreads.threadId, state.threadId),
              eq(cloudroomThreads.startRequestId, `teleport_${state.id}`),
            ),
          )
          .run();
    });
    this.notify(state.threadId);
  }
  recover(): void {
    for (const { threadId, progress } of pendingTeleports(this.deps.db))
      this.launch(threadId, progress.id);
  }
  private launch(threadId: string, id: string) {
    if (this.active.has(threadId)) return;
    const work = this.run(id)
      .catch((error) => {
        const progress = teleportProgress(this.deps.db, threadId);
        if (!progress || progress.phase === "cancelled") return;
        const state = this.load(id);
        if (
          state.stopped &&
          state.cancelRequested &&
          !state.activationRequested
        ) {
          this.finishCancellation(state);
          return;
        }
        const transient =
          (error instanceof CloudroomError && error.retryable) ||
          (error instanceof ApiError &&
            [
              "host_unavailable",
              "command_timeout",
              "teleport_queue_settling",
              "teleport_source_busy",
            ].includes(error.body.code));
        const message =
          error instanceof Error
            ? error.message
            : "Transfer failed; source history is preserved.";
        saveTeleportProgress(this.deps.db, threadId, {
          ...progress,
          phase: transient ? progress.phase : "error",
          error: message.slice(0, 2000),
        });
        this.deps.logger.warn(
          { threadId, transferId: id, error: message },
          "Teleport paused",
        );
        this.notify(threadId);
      })
      .finally(() => this.active.delete(threadId));
    this.active.set(threadId, work);
  }
  private async run(id: string) {
    let state = this.load(id);
    if (!state.stopped) {
      await Promise.all(
        state.sessions.map((source) => {
          const thread = getThread(this.deps.db, source.threadId);
          const environment = getEnvironment(
            this.deps.db,
            source.environmentId,
          );
          if (!thread || !environment)
            throw new Error(
              "The local thread or environment disappeared before stopping.",
            );
          return stopThreadForCurrentState(this.deps, thread, environment, {
            requireStopped: true,
            immediate: true,
          });
        }),
      );
      state = { ...this.load(id), stopped: true };
      this.save(state);
    }
    if (state.cancelRequested && !state.activationRequested) {
      this.finishCancellation(state);
      return;
    }
    const client = await cloudroom(this.deps).teleportClient(state.threadId);
    const capability = await client.capabilities();
    if (capability.teleport !== true)
      throw new ApiError(
        409,
        "teleport_update",
        "Update the cloud core before using Teleport. The local task is stopped and preserved.",
      );
    if (!state.manifest) {
      const rows = state.sessions.flatMap((source) =>
        this.deps.db
          .select()
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.threadId, source.threadId))
          .orderBy(
            asc(queuedThreadMessages.sortKey),
            asc(queuedThreadMessages.id),
          )
          .all(),
      );
      if (rows.some((row) => row.claimedAt !== null || row.claimToken !== null))
        throw new ApiError(
          503,
          "teleport_queue_settling",
          "Waiting for the stopped local queue to settle. Teleport will retry automatically.",
        );
      if (rows.some((row) => row.model !== (state.sourceModel ?? state.model)))
        throw new ApiError(
          409,
          "teleport_queue_model",
          "A queued message selects a different model. Cancel Teleport and align the queued models first; Cloud keeps one model per thread.",
        );
      state.queuedIds = rows.map((row) => row.id);
      state.queuedDisplay = rows.map(
        (row) => JSON.parse(row.content) as PromptInput[],
      );
      state.queued = rows.map((row, index) => {
        const prompt = promptPayload(
          state.queuedDisplay![index]!,
          getThread(this.deps.db, state.threadId)!.providerId,
          true,
        );
        return {
          text: [
            prompt.text,
            ...prompt.attachments.map(
              (file) => `[Attachment uploading separately: ${file.localPath}]`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          reasoning: row.reasoningLevel,
          service_tier: row.serviceTier,
        };
      });
      state.sessions = state.sessions.map((source) => ({
        ...source,
        nativeId:
          getLastProviderThreadId(this.deps, source.threadId) ??
          source.nativeId,
      }));
      const goals = state.sessions.flatMap((source) => {
        const row = this.deps.db
          .select({ type: events.type, data: events.data })
          .from(events)
          .where(
            and(
              eq(events.threadId, source.threadId),
              inArray(events.type, [
                "thread/goal/updated",
                "thread/goal/cleared",
              ]),
            ),
          )
          .orderBy(desc(events.sequence))
          .limit(1)
          .get();
        const goal =
          row?.type === "thread/goal/updated" ? JSON.parse(row.data) : null;
        return goal?.status === "active"
          ? [`${source.threadId}: ${goal.objective}`]
          : [];
      });
      const nativeChildren = new Map<string, State["sessions"][number]>();
      const known = new Set(state.sessions.map((source) => source.nativeId));
      for (const source of state.sessions.filter(
        (source) => source.harness === "codex",
      )) {
        const records = this.deps.db
          .select({ data: events.data })
          .from(events)
          .where(
            and(
              eq(events.threadId, source.threadId),
              inArray(events.type, [
                "item/started",
                "item/completed",
                "item/delegation/progress",
                "item/delegation/completed",
              ]),
            ),
          )
          .all();
        for (const record of records) {
          const child = JSON.parse(record.data).item?.childRef;
          if (
            typeof child === "string" &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(child) &&
            !known.has(child)
          )
            nativeChildren.set(child, {
              ...source,
              threadId: child,
              nativeId: child,
            });
        }
      }
      this.save(state);
      const instructionSnapshots = await Promise.all(
        state.sessions.map(async (source) => {
          const thread = getThread(this.deps.db, source.threadId);
          const environment = getEnvironment(
            this.deps.db,
            source.environmentId,
          );
          if (!thread || !environment)
            throw new Error(
              "Source instructions are unavailable; nothing was transferred.",
            );
          const config = await resolveThreadRuntimeCommandConfig(this.deps, {
            thread,
            environment,
            model:
              getLastExecutionOptions(this.deps, source.threadId)?.model ??
              state.model,
          });
          return {
            threadId: source.threadId,
            mode: config.instructionMode,
            instructions: config.instructions,
          };
        }),
      );
      const extraText = JSON.stringify({
        instructionSnapshots,
        instructions:
          "This is reference history. Do not replay past tool actions. Queued follow-ups are delivered separately.",
        threads: state.sessions.map((source) => ({
          threadId: source.threadId,
          title: getThread(this.deps.db, source.threadId)?.title,
          harness: source.harness,
          events: this.deps.db
            .select({
              sequence: events.sequence,
              type: events.type,
              data: events.data,
            })
            .from(events)
            .where(eq(events.threadId, source.threadId))
            .orderBy(asc(events.sequence))
            .all()
            .map((row) => ({ ...row, data: JSON.parse(row.data) })),
        })),
        queued: state.queuedDisplay,
        goals,
      });
      if (Buffer.byteLength(extraText) > 32 * 1024 * 1024)
        throw new ApiError(
          409,
          "teleport_history_size",
          "GUI history exceeds the bounded capture size. Nothing was truncated; the local source is preserved.",
        );
      const capture = await runLiveHostCommand(this.deps, {
        hostId: state.hostId,
        timeoutMs: 120_000,
        command: {
          type: "thread.teleport",
          action: "capture",
          transferId: id,
          threadId: state.threadId,
          environmentId: state.environmentId,
          workspaceContext: workspaceContextFromPath({
            path: state.workspacePath,
          }),
          sessions: [...state.sessions, ...nativeChildren.values()],
          extraText,
          attachments: state.attachments,
        },
      });
      if (
        !capture.nativeId ||
        !capture.files ||
        !capture.files.some(
          (file) => file.kind === "context" && file.path === "gui-history.json",
        )
      )
        throw new Error(
          "Local capture returned no complete conversation. Update the local host before retrying.",
        );
      const thread = getThread(this.deps.db, state.threadId)!;
      const project = getProject(this.deps.db, thread.projectId)!;
      const separator = state.model.indexOf("/");
      const provider =
        thread.providerId === "pi" && separator > 0
          ? state.model.slice(0, separator)
          : null;
      if (thread.providerId === "pi" && !provider)
        throw new Error("Pi provider is missing from the saved model.");
      state = {
        ...this.load(id),
        manifest: {
          request_id: id,
          harness: harnessOf(thread.providerId)!,
          native_id: capture.nativeId,
          model: provider
            ? state.model.slice(provider.length + 1)
            : state.model,
          provider,
          reasoning: state.reasoning,
          service_tier: state.serviceTier,
          command_guard_enabled: getAppSettings(this.deps.db)
            .commandGuardEnabled,
          workspace: `bb_${thread.projectId}`,
          workspace_name:
            project.name
              .replace(/[^a-zA-Z0-9_.-]/g, "-")
              .replace(/^\.+/, "")
              .slice(0, 80) || "project",
          files: capture.files,
          queued: state.queued,
          handoff: `Continue unfinished work in this same conversation; if the task is already complete, confirm that instead of redoing it. Before working, read the preserved user and project instructions in gui-history.json and the instruction files in the index. If this project is new on the VM, Cloudroom is copying it into this folder now (a GitHub clone or an upload from the laptop, plus uncommitted edits and .env files); wait for missing files instead of recreating them. Otherwise, use Git to match the local branch and commit in git-state.txt, which also lists uncommitted tracked edits that stayed on the laptop. Untracked files mentioned in the conversation were also copied. Other GUI history and child traces are reference context; read them as needed. Queued follow-ups will run separately after this continuation; do not execute them from the history file. Existing goals remain instructions, not automatic loops.\nActive goals: ${goals.join("\n") || "none"}.\nOld local workspace: ${state.workspacePath}.\nChildren: ${[...state.sessions.slice(1).map((s) => s.threadId), ...nativeChildren.keys()].join(", ") || "none"}.\nKnown unavailable local paths: ${(capture.omitted ?? []).join(", ") || "none"}.`,
        },
      };
      this.save(state);
    }
    const copy = await planProjectCopy(this.deps, client, state.threadId, state.manifest!.workspace, state.workspacePath);
    let remote = await client.prepareTeleport(state.manifest!);
    if (copy) copyProject(this.deps, client, copy);
    const cancelled = async () => {
      if (
        teleportProgress(this.deps.db, state.threadId)?.phase === "cancelled" &&
        binding(this.deps.db, state.threadId)?.sessionId
      )
        return true;
      const latest = this.load(id);
      if (!latest.cancelRequested) return false;
      remote = await client.teleportStatus(id);
      if (remote.session_id) {
        await this.bind(state, remote);
        return false;
      }
      remote = await client.cancelTeleport(id);
      if (remote.phase !== "cancelled")
        throw new Error("Cloud cancellation is not confirmed.");
      this.finishCancellation(state);
      return true;
    };
    if (await cancelled()) return;
    if (remote.session_id) await this.bind(state, remote);
    const upload = async (index: number) => {
      let status = remote.files[index]!;
      while (!status.complete) {
        if (await cancelled()) return false;
        const chunk = await runLiveHostCommand(this.deps, {
          hostId: state.hostId,
          timeoutMs: 120_000,
          command: {
            type: "thread.teleport",
            action: "read",
            transferId: id,
            threadId: state.threadId,
            environmentId: state.environmentId,
            workspaceContext: workspaceContextFromPath({
              path: state.workspacePath,
            }),
            index,
            offset: status.offset,
          },
        });
        if (chunk.pending)
          throw new ApiError(
            503,
            "teleport_source_busy",
            `Waiting for ${state.manifest!.files[index]!.path} to stop changing. The upload will retry automatically.`,
          );
        if (
          chunk.data === undefined ||
          !chunk.sha256 ||
          chunk.size === undefined
        )
          throw new Error("Local transfer chunk is missing.");
        remote = await client.uploadTeleport(
          id,
          index,
          status.offset,
          chunk.sha256,
          Buffer.from(chunk.data, "base64"),
          chunk.size,
        );
        status = remote.files[index]!;
        this.progress(state, {
          phase: remote.session_id ? "running" : "uploading",
          completed: remote.files.filter((f) => f.complete).length,
          total: remote.files.length,
          error: undefined,
          cloudStarted: Boolean(remote.session_id),
        });
      }
      return true;
    };
    const files = state.manifest!.files;
    for (let i = 0; i < files.length; i++)
      if (["native", "context"].includes(files[i]!.kind) && !(await upload(i)))
        return;
    if (await cancelled()) return;
    state = { ...this.load(id), activationRequested: true };
    if (state.cancelRequested && !remote.session_id) {
      if (await cancelled()) return;
    }
    this.save(state);
    remote = await client.activateTeleport(id, state.retryRequestId);
    await this.bind(state, remote);
    for (let i = 0; i < files.length; i++)
      if (!["native", "context"].includes(files[i]!.kind) && !(await upload(i)))
        return;
    remote = await client.teleportStatus(id);
    const attempt = state.retryRequestId
      ? `teleport_retry_${state.retryRequestId}`
      : `teleport_${id}_0`;
    const handoff =
      remote.session_id && remote.phase !== "complete"
        ? (await client.session(remote.session_id)).receipts[attempt]
        : undefined;
    if (handoff?.state === "failed")
      throw new Error(
        `The cloud agent could not continue: ${handoff.error ?? remote.error_detail ?? "the handoff turn failed"}. Fix the cause, then retry this transfer. Source history is preserved.`,
      );
    // Safe to close once every file arrived and the cloud agent is working,
    // even if it has not written text yet.
    const complete =
      remote.phase === "complete" ||
      (remote.files.every((f) => f.complete) &&
        Boolean(
          this.deps.db
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.threadId, state.threadId),
                eq(events.type, "item/started"),
                like(events.data, `%"id":"teleport_${id}_%`),
              ),
            )
            .get(),
        ));
    if (remote.error && !complete)
      throw new Error(
        remote.error === "paused_before_output"
          ? "Cloud work stopped before its first reply. Retry transfer will resume it. Source history is preserved."
          : remote.error === "no_cloud_output"
            ? "Cloud produced no reply. Fix any provider error, then retry this transfer. Source history is preserved."
            : `Cloud conversation could not resume: ${remote.error_detail ?? remote.error}. Source history is preserved.`,
      );
    this.progress(state, {
      phase: complete ? "complete" : "running",
      completed: remote.files.filter((f) => f.complete).length,
      total: remote.files.length,
      cloudStarted: true,
      error: undefined,
    });
    if (complete) {
      for (const source of state.sessions.slice(1))
        saveTeleportProgress(this.deps.db, source.threadId, {
          id,
          owner: state.threadId,
          phase: "complete",
          completed: 0,
          total: 0,
        });
    }
  }
  private async bind(state: State, remote: TeleportStatus) {
    if (
      remote.request_id !== state.id ||
      remote.session_id !== `cr_teleport_${state.id}`
    )
      throw new Error("Cloud activation did not match the saved transfer.");
    const latest = this.load(state.id);
    if (latest.cancelRequested)
      this.save({ ...latest, cancelRequested: false });
    this.deps.db.transaction((tx) => {
      if (!binding(tx, state.threadId))
        tx.insert(cloudroomThreads)
          .values({
            threadId: state.threadId,
            coreUrl: cloudroom(this.deps).teleportUrl,
            startRequestId: `teleport_${state.id}`,
            sessionId: remote.session_id,
            model: state.model,
            reasoning: state.reasoning,
            nativeId: state.manifest!.native_id,
          })
          .run();
      else saveBinding(tx, state.threadId, { sessionId: remote.session_id });
      tx.update(threads)
        .set({
          executionTarget: "cloud",
          environmentId: null,
          updatedAt: Date.now(),
        })
        .where(eq(threads.id, state.threadId))
        .run();
      for (const [index, queued] of state.queued.entries()) {
        const input = typeof queued === "string" ? { text: queued } : queued;
        tx.insert(cloudroomCommands)
          .values({
            id: `teleport_${state.id}_${index + 1}`,
            threadId: state.threadId,
            command: "prompt",
            input: JSON.stringify({
              ...input,
              content: state.queuedDisplay?.[index],
            }),
            state: "accepted",
            createdAt: Date.now() + index,
          })
          .onConflictDoNothing()
          .run();
      }
      if (state.queuedIds.length)
        tx.delete(queuedThreadMessages)
          .where(inArray(queuedThreadMessages.id, state.queuedIds))
          .run();
      saveTeleportProgress(tx, state.threadId, {
        id: state.id,
        owner: state.threadId,
        phase: remote.phase === "complete" ? "complete" : "running",
        cloudStarted: true,
        completed: remote.files.filter((f) => f.complete).length,
        total: remote.files.length,
      });
    });
    this.notify(state.threadId);
    if (getThread(this.deps.db, state.threadId)?.archivedAt) {
      cloudroom(this.deps).archive(state.threadId);
      this.finishCancellation(state, true);
      throw new Error("The thread was archived; its cloud agent was stopped.");
    }
    cloudroom(this.deps).followTeleport(state.threadId);
  }
}
