import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createThread, getAppSettings, getProject, getThread, getThreadExecutionOverride, setThreadExecutionOverride, updateThread, cloudroomThreads, cloudroomCommands, events, type DbConnection, type DbQueryConnection, type DbTransaction } from "@cloudroom/db";
import { PERSONAL_PROJECT_ID, encodeClientTurnRequestIdNumber, isStandaloneBuiltinCompactCommand, promptInputSchema, reasoningLevelSchema, threadQueuedMessageSchema, type Thread, type PromptInput, type ThreadEventType, type ThreadEventTurnStatus, type ThreadChangeKind, type ReasoningLevel } from "@cloudroom/domain";
import type { CreateThreadRequest, ForkThreadRequest, SendMessageRequest, SendMessageResponse } from "@cloudroom/server-contract";
import { z } from "zod";
import { findCliExecutable } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, authRequiredMessages, type CodexAuthStatus, type VmRun, type VmRunResult } from "./client.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, appendStartProgress, endedTurn, isCloudProvider, projectFollowUp, projectInitialPrompt, projectRecord, retractStillQueuedPrompts, type CloudProvider, type StartStep } from "./events.js";
import { mentionsOpenAISide401 } from "./codex-errors.js";
import { codexOutage } from "./openai-status.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { cloudroomSystemPrompt, prepareCloudInstructionInput, resolveCustomInstructions } from "../threads/custom-instructions.js";
import { binding, bindings, command, commands, coreInUse, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, projectCopyProgress, stampBindings, teleportBlocked, unstartedTurn, type Binding, type Command } from "./store.js";
import { copyProject, githubRepository, localProjectNote, planProjectCopy, writeFilesState, type ProjectCopyJob } from "./project-copy.js";
import { cloudForkOf, cloudForkPoint, FORK_HARNESSES, FORK_HINT, landForkCode, startCloudFork } from "./fork.js";
import { copyForkSourceHistory } from "../threads/thread-fork-history.js";
import { appendClientTurnEvent } from "../threads/thread-events.js";
import { getLeadingAgentOnlyInput, resolveDeferredFirstTurnContext } from "../threads/deferred-first-turn-context.js";
import { deriveTitleFallback, shouldGenerateThreadTitle } from "../threads/title-generation.js";
import { buildSuggestedBranchName } from "../threads/thread-create-helpers.js";
import { assertValidParentThread, isParentNotifiableChildThread } from "../threads/thread-parent.js";
import { inferThreadMetadata, queueThreadTitle } from "../threads/thread-metadata-inference.js";
import { cliPlace, reportAgentConnect } from "./setup-telemetry.js";
import { cloudSkills, copyLogins, copyMacGithub, importCodexLogin, importPiLogin, setupSync, skillInCloud, stopSync, syncStatus } from "./sync.js";
import { setupPreviews, stopPreviews, previewStatus } from "./previews.js";
import { CloudSecrets } from "./secrets.js";
import { cancelMacCodexLogin, hasMacCodexLogin, macCodexLogin, macCodexLoginExpired, macCursorLogin, revokeDesktopToken, startMacCodexLogin, SANDBOX_PREFIX, SandboxAsleep, SandboxDirectory, sandboxThread, type SandboxProject, type SandboxTrigger, type SandboxWakeTrigger } from "./sandboxes.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { markMinutesSent, unsentMinutes } from "./time-in-app.js";
import type { EditMessageRequest, EditMessageResponse } from "@cloudroom/server-contract";

const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email() }).strict();
const connectionSchema = z.object({ url: z.string().url(), token: z.string().min(32), gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional(), projectId: z.string().min(1).optional() }).strict();
const websiteSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return value === url.origin && (value === "https://www.cloudroom.dev" || (url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)));
});
const savedConnectionSchema = connectionSchema.extend({
  url: connectionSchema.shape.url.optional(), token: connectionSchema.shape.token.optional(), account: accountSchema.optional(), websiteUrl: websiteSchema.optional(),
  sandboxToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  onboarding: z.object({
    projectSelected: z.boolean().default(false), reported: z.array(z.enum(["connected", "project", "message"])).default([]),
    firstMessage: z.object({ sessionId: z.string(), requestId: z.string() }).optional(),
  }).optional(),
});
export type CloudroomAccount = z.infer<typeof accountSchema>;
const capabilitiesSchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  stop: z.literal(true),
  resume: z.literal(true),
  launch_settings: z.literal(true),
  prompt_reasoning: z.boolean().default(false),
  workspaces: z.boolean().default(false),
  direct_workspaces: z.boolean().default(false),
  root_workspace: z.boolean().default(false),
  teleport: z.boolean().default(false),
  command_guard: z.boolean().default(false),
  strip_ai_co_authors: z.boolean().default(false),
  system_prompt: z.boolean().default(false),
  codex_auth: z.boolean().default(false),
  cursor_auth: z.boolean().default(false),
  claude_auth: z.boolean().default(false),
  codex_auth_import: z.boolean().default(false),
  sync: z.boolean().default(false),
  previews: z.boolean().default(false),
  structured_prompt: z.boolean().default(false),
  queue_edit: z.boolean().default(false),
  child_threads: z.boolean().default(false),
  queue_cancel: z.boolean().default(false),
  queue_reorder: z.boolean().default(false),
  steer: z.boolean().default(false),
  rewind: z.boolean().default(false),
  fork: z.boolean().default(false),
  side_chat: z.boolean().default(false),
  attachments: z.boolean().default(false),
  upload_parts: z.boolean().default(false),
  compact: z.boolean().default(false),
  goal: z.boolean().default(false),
  usage: z.boolean().default(false),
  subagents: z.boolean().default(false),
  harnesses: z.array(z.object({
    id: z.string(),
    model: z.string(),
    provider: z.string().nullable().optional(),
    provider_selection: z.boolean().default(false),
    reasoning_levels: z.array(z.string()).default(["none", "minimal", "low", "medium", "high", "xhigh"]),
    models: z.array(z.object({ model: z.string(), reasoning_levels: z.array(z.string()) })).nullable().optional(),
    steer: z.boolean().default(false),
    compact: z.boolean().default(false),
    goal: z.boolean().default(false),
    service_tier: z.boolean().default(false),
    skill_mentions: z.boolean().default(false),
    rewind: z.boolean().default(false),
    attachments: z.object({ images: z.boolean(), files: z.boolean() }).optional(),
    subagents: z.boolean().default(false),
    usage: z.boolean().default(false),
  })),
});
type Connection = z.infer<typeof connectionSchema>;
type Capabilities = z.infer<typeof capabilitiesSchema>;
const storageBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null);
const storageSchema = z.object({
  enabled: z.boolean(), level: z.enum(["normal", "low_space", "blocked"]),
  reason: z.enum(["disk_capacity", "measurement_unavailable", "unprotected_test_mode"]),
  workspace_available_bytes: storageBytes, history_available_bytes: storageBytes,
  workspace_total_bytes: storageBytes, history_total_bytes: storageBytes, sampled_at: storageBytes,
});
type Storage = z.infer<typeof storageSchema>;
function storageMessage(storage: Storage | null): string | null {
  if (!storage?.enabled || storage.level !== "blocked") return null;
  if (storage.reason === "measurement_unavailable") return "Cloud disk space could not be measured. Work is paused until storage can be verified.";
  const bytes = storage.workspace_available_bytes === null || storage.history_available_bytes === null ? null : Math.min(storage.workspace_available_bytes, storage.history_available_bytes);
  return `The cloud disk is almost full${bytes === null ? "" : ` (${(bytes / 1e9).toFixed(1)} GB free)`}. Within 30 seconds Cloudroom stops the command filling it, and work resumes. Saved messages are kept.`;
}
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry"> & Partial<LoggedWorkSessionDeps> & Partial<Pick<AppDeps, "pendingInteractions">>;
const services = new WeakMap<DbConnection, CloudroomService>();
const workspaceId = (projectId: string) => `bb_${projectId}`;
const ROOT_WORKSPACE = "root";
const workspaceName = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 80) || "project";
const cloudStep = (sandbox: boolean, status: StartStep["status"] = "started"): StartStep => ({ key: "cloud", text: sandbox ? "Starting cloud sandbox" : "Connecting to cloud VM", status });

export function cloudroom(deps: Deps): CloudroomService {
  let service = services.get(deps.db);
  if (!service) { service = new CloudroomService(deps); services.set(deps.db, service); }
  return service;
}

/** Where a cloud thread runs, for anonymous usage events: its own sandbox or the older shared VM. */
export function cloudExecution(deps: Pick<AppDeps, "db">, threadId: string): "cloud_sandbox" | "cloud_vm" {
  return sandboxThread(binding(deps.db, threadId)?.coreUrl ?? "") ? "cloud_sandbox" : "cloud_vm";
}

/** The branch a new cloud thread starts from, saved on its first prompt. Validated by the create request schema. */
function baseBranch(input: string | undefined): string | undefined {
  const branch: unknown = input ? JSON.parse(input).base_branch : undefined;
  return typeof branch === "string" && /^(?!-)[\w./-]{1,255}$/.test(branch) ? branch : undefined;
}

export function isCloudThread(thread: Pick<Thread, "executionTarget">): boolean {
  return thread.executionTarget === "cloud";
}

export function requireNativeThread(thread: Pick<Thread, "executionTarget">): void {
  if (isCloudThread(thread)) throw new ApiError(409, "cloudroom_unsupported", "This action is not supported for Cloud threads. Native execution is blocked.");
}

type PromptAttachment = { name: string; kind: "image" | "file"; localPath: string; id?: string; path?: string };
/** Runs when a project copy ends, with the client that ran it: a sandbox that slept mid-copy has a new address. */
type Landed = (error?: string, client?: CloudroomClient) => void;

function cloudTextContent(content: unknown): unknown {
  return Array.isArray(content) ? content.filter(part => part?.type === "text") : content;
}

function requireClaudeSkillSupport(content: unknown, capabilities: Capabilities, harness: string | undefined): void {
  if (harness !== "claude-code" || (capabilities.structured_prompt && harnessProfile(capabilities, harness)?.skill_mentions)) return;
  const input = z.array(promptInputSchema).parse(content ?? []);
  if (input.some(part => part.type === "text" && part.mentions.some(({ resource }) => resource.kind === "command" && resource.source === "skill"))) {
    throw new ApiError(409, "cloudroom_update", "Update the cloud core to load selected Claude skills. Your message is saved.");
  }
}

export function promptPayload(input: PromptInput[], harness: string, attachmentsEnabled: boolean | { images: boolean; files: boolean }): { text: string; content: PromptInput[]; attachments: PromptAttachment[] } {
  const skills: { name: string; chunk: number; start: number; end: number }[] = [];
  const attachments: PromptAttachment[] = [];
  const chunks: string[] = [];
  for (const part of input) {
    if (part.type === "text") {
      const chunk = chunks.push(part.text) - 1;
      for (const { resource, start, end } of part.mentions) {
        // Thread tags stay as plain `@thread:thr_...` text; the cloud agent reads that thread through Mac access.
        if (resource.kind === "thread") continue;
        // `/context` stays plain text; Claude Code runs it as its own command.
        if (harness === "claude-code" && resource.kind === "command" && resource.source === "command" && resource.origin === "builtin" && resource.name === "context") continue;
        if (resource.kind !== "command" || resource.source !== "skill") throw new ApiError(400, "cloudroom_unsupported", "Cloud supports skill and thread tags, but other mentions and commands are not enabled.");
        if (!resource.name || /\s/.test(resource.name) || start >= end || end > part.text.length || part.text.slice(start, end) !== `/${resource.name}`) throw new ApiError(400, "invalid_request", "The selected skill tag is invalid. Remove it and select the skill again.");
        skills.push({ name: resource.name, chunk, start, end });
      }
      continue;
    }
    if (!attachmentsEnabled) throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments are not enabled.");
    if (part.type !== "localImage" && part.type !== "localFile") throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments must be uploaded files.");
    if (typeof attachmentsEnabled === "object" && !(part.type === "localImage" ? attachmentsEnabled.images : attachmentsEnabled.files)) throw new ApiError(400, "cloudroom_unsupported", "This attachment type is not enabled for the cloud harness.");
    attachments.push({
      name: part.path.split("/").pop() || "attachment",
      kind: part.type === "localImage" ? "image" : "file",
      localPath: part.path,
    });
  }
  const texts = [...chunks];
  const skill = skills.length === 1 ? skills[0] : undefined;
  if (harness === "pi" && skill) texts[skill.chunk] = texts[skill.chunk]!.slice(0, skill.start) + texts[skill.chunk]!.slice(skill.end);
  let text = texts.join("\n");
  if (harness === "pi" && skill) text = `/skill:${skill.name}${text ? `${text.startsWith(" ") ? "" : " "}${text}` : ""}`;
  if (!text.trim() && attachments.length === 0) throw new ApiError(400, "invalid_request", "Message is empty.");
  const bytes = Buffer.byteLength(text);
  if (bytes > 32768) throw new ApiError(400, "invalid_request", `Message is too long (${Math.ceil(bytes / 1024)} KB). Cloud messages can be up to 32 KB. Shorten it or remove quoted messages.`);
  return { text, content: input, attachments };
}

function coreModel(harness: CloudProvider, model: string, capabilities: z.infer<typeof capabilitiesSchema>): { model: string; provider?: string } {
  const profile = harnessProfile(capabilities, harness);
  if (!profile) throw new ApiError(400, "cloudroom_harness", `Configure ${harness} on the cloud VM first.`);
  if (harness !== "pi") return { model };
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  if (separator <= 0 || separator === model.length - 1) throw new ApiError(400, "cloudroom_model", "Select a Pi provider and model.");
  if (!profile.provider_selection && provider !== profile.provider) throw new ApiError(400, "cloudroom_model", "Update the cloud core to use another Pi provider.");
  return { model: model.slice(separator + 1), ...(profile.provider_selection ? { provider } : {}) };
}

function validateReasoning(harness: string, model: string, reasoning: string, capabilities: z.infer<typeof capabilitiesSchema>): void {
  const profile = harnessProfile(capabilities, harness);
  if (profile?.models === null) throw new ApiError(503, "model_catalog_unavailable", "Cloud model discovery is unavailable. Try again when the cloud harness is ready.");
  // Claude runs exact models its catalog omits, such as claude-opus-5-5[1m]; core allows any VM level (ADR 0133).
  const anyLevel = harness === "claude-code" ? [...new Set(profile?.models?.flatMap((item) => item.reasoning_levels))] : undefined;
  const levels = profile?.models ? (profile.models.find((item) => item.model === model)?.reasoning_levels ?? anyLevel) : profile?.reasoning_levels;
  if (profile?.models && !levels) throw new ApiError(400, "invalid_model", "This model is unavailable on Cloud. Refresh the model selection.");
  if (!levels?.includes(reasoning)) throw new ApiError(400, "invalid_reasoning_effort", "This reasoning level is unavailable for the cloud model. Select a supported level.");
}

function followUpPayload(harness: string, saved: Binding, payload: SendMessageRequest, reasoning: string | null, capabilities: Capabilities) {
  const profile = harnessProfile(capabilities, harness);
  if ((payload.mode === "steer" || payload.mode === "steer-if-active") && (!feature(capabilities, "steer") || profile?.steer === false)) throw new ApiError(409, "cloudroom_unsupported", "Cloud steering is not enabled. Use --mode queue.");
  if (payload.serviceTier === "fast" && !profile?.service_tier) throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
  if (reasoning !== null) validateFollowUpReasoning(harness, saved, reasoning, capabilities);
  return promptPayload(payload.input, harness, capabilities.attachments && (profile?.attachments ?? true));
}

function validateFollowUpReasoning(harness: string, saved: Binding, reasoning: string, capabilities: Capabilities): void {
  if (reasoning === saved.reasoning) return;
  if (harness === "acp-cursor" || harness === "acp-fx" || harness === "acp-opencode") throw new ApiError(409, "cloudroom_launch_settings", `${HARNESS_NAMES[harness]} reasoning is fixed for this cloud session. Start a new thread to change it.`);
  if (harness !== "codex" && harness !== "pi" && harness !== "claude-code") throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
  if (!capabilities.prompt_reasoning) throw new ApiError(409, "cloudroom_update", "Update the cloud core before changing reasoning on a follow-up.");
  validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, reasoning, capabilities);
}

function sameStoredPrompt(previous: Command, threadId: string, payload: object, requested: string, launch: string): boolean {
  if (previous.threadId !== threadId || previous.command !== "prompt") return false;
  try {
    const stored = JSON.parse(previous.input);
    const storedReasoning = typeof stored.reasoning === "string" ? stored.reasoning : launch;
    const next = payload as { text?: string; service_tier?: string };
    return stored.text === next.text
      && storedReasoning === requested
      && (stored.service_tier ?? "default") === (next.service_tier ?? "default")
      && (stored.content === undefined || JSON.stringify(stored.content) === JSON.stringify((payload as { content?: unknown }).content ?? null));
  } catch {
    return false;
  }
}

function feature(capabilities: Capabilities | null | undefined, name: keyof Capabilities): boolean {
  return capabilities?.[name] === true;
}

function hashedRequestId(id: string): string {
  return encodeClientTurnRequestIdNumber({ value: createHash("sha256").update(id).digest().readUIntBE(0, 6) });
}

function nativeRewindBefore(db: DbQueryConnection, threadId: string, expectedRequestSequence?: number): string | undefined {
  const row = db.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"), expectedRequestSequence === undefined ? undefined : eq(events.sequence, expectedRequestSequence))).orderBy(desc(events.sequence)).get();
  if (!row) throw new ApiError(409, "invalid_request", "The selected message is no longer available");
  const requestId = JSON.parse(row.data).requestId;
  if (typeof requestId !== "string") throw new ApiError(409, "invalid_request", "The selected message is not an editable user turn");
  const checkpoints = db.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "system/operation"))).all();
  for (const checkpoint of checkpoints.reverse()) {
    try {
      const data = JSON.parse(checkpoint.data) as { operation?: string; metadata?: { id?: string; request_id?: string | null } };
      if (data.operation !== "checkpoint" || typeof data.metadata?.id !== "string" || typeof data.metadata.request_id !== "string") continue;
      if (hashedRequestId(data.metadata.request_id) === requestId) return data.metadata.id;
    } catch { /* ignore malformed checkpoint rows */ }
  }
  throw new ApiError(409, "invalid_request", "A native rewind checkpoint is not available for this message");
}

function harnessProfile(capabilities: Capabilities, harness: string) {
  const id = isCloudProvider(harness) ? CLOUD_HARNESSES[harness] : harness;
  return capabilities.harnesses.find((item) => item.id === id);
}

function commandReasoning(input: string): string | undefined {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : undefined;
  } catch {
    return undefined;
  }
}

const connectionOrReplayFailed = "Cloudroom connection or replay failed";

function publicError(error: unknown): string {
  if (error instanceof CloudroomError || error instanceof ApiError) return error.message;
  return error instanceof Error ? `${connectionOrReplayFailed}: ${error.message}` : connectionOrReplayFailed;
}

function connectionFailure(error: unknown): boolean {
  return error instanceof CloudroomConnectionError
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof CloudroomError && error.status !== null && (error.status >= 500 || error.status === 408 || error.status === 429));
}

const retiredVmMessage = "This thread ran on the old shared cloud VM, which was shut down on October 2. Start a new Cloud thread to keep going.";

type ConnectionPhase = "delivery" | "stream" | "replay";
type ConnectionIssue = { message: string; reconnecting: boolean };

class CloudroomService {
  teleportRecovery?: () => void;
  archiveRequest?: (threadId: string) => void;
  childTurnEnded?: (child: Thread & { parentThreadId: string }, status: ThreadEventTurnStatus) => void;
  teleportUrl = "";
  async teleportClient(threadId?: string): Promise<CloudroomClient> {
    const existing = threadId ? binding(this.deps.db, threadId) : null;
    const sandbox = existing ? sandboxThread(existing.coreUrl) : threadId && await this.newThreadsInSandboxes() ? threadId : null;
    if (sandbox) {
      // Teleported threads get their own sandbox too; this wakes it for the transfer.
      this.teleportUrl = SANDBOX_PREFIX + sandbox;
      return this.client({ coreUrl: this.teleportUrl } as Binding);
    }
    const connection = await this.connection();
    const saved = threadId ? binding(this.deps.db, threadId) : null;
    if (saved && saved.coreUrl !== connection.url) throw new ApiError(409, "cloudroom_connection_changed", "Restore this transfer's original cloud connection before continuing.");
    this.teleportUrl = connection.url;
    return new CloudroomClient(connection);
  }
  async threadClient(threadId: string, wake = true): Promise<CloudroomClient> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_thread_unstarted", "This cloud thread has not started yet.");
    return this.client(saved, wake);
  }
  followTeleport(threadId: string): void { void this.deliver(threadId).catch(() => {}); }
  private readonly leftParent = new Set<string>();
  /** A top-level thread in another thread's sandbox was a child there. Before its next work, Core stops reporting it
   *  to that former parent, which may be archived. Repeats are harmless, so a failure retries on the next delivery. */
  private async leaveFormerParent(saved: Binding, client: CloudroomClient): Promise<void> {
    const sandbox = sandboxThread(saved.coreUrl);
    if (!saved.sessionId || !sandbox || sandbox === saved.threadId || this.leftParent.has(saved.threadId) || getThread(this.deps.db, saved.threadId)?.parentThreadId) return;
    try { await client.detach(saved.sessionId); this.leftParent.add(saved.threadId); }
    catch (error) { this.warn("A Cloud thread could not leave its former parent", error, { threadId: saved.threadId }); }
  }
  detach(threadId: string): void {
    this.streams.get(threadId)?.abort();
    this.streams.delete(threadId);
    this.streamErrors.delete(threadId);
    this.connectionIssues.delete(threadId);
  }
  private readonly streams = new Map<string, AbortController>();
  private readonly streamErrors = new Map<string, string>();
  private readonly connectionIssues = new Map<string, Partial<Record<ConnectionPhase, ConnectionIssue>>>();
  private readonly diskFull = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private epoch = 0;
  private configurationWrite: Promise<void> = Promise.resolve();
  private syncIssue: string | null = null;
  private previewIssue: string | null = null;
  private previewSetupEpoch = -1;
  private previewRetryAt = 0;
  private onboardingDue = 0;
  private reportingOnboarding = false;
  private lastCapabilities: Capabilities | null = null;
  private claudeConnected: boolean | null = null;
  private readonly resumingStarts = new Set<string>();
  private readonly pausedCopies = new Map<string, { job: ProjectCopyJob; landed: Landed; tries: number }>();
  private readonly catchUps = new Map<string, number>();
  /** What sandboxes run, kept apart from a VM's: an account with both starts new threads in sandboxes. */
  private sandboxCapabilities: Capabilities | null = null;
  private readonly secrets: CloudSecrets;
  readonly sandboxes: SandboxDirectory;
  constructor(private readonly deps: Deps) {
    this.secrets = new CloudSecrets(deps);
    this.sandboxes = new SandboxDirectory(async () => {
      const saved = await this.savedConnection();
      return saved?.sandboxToken && saved.account ? { website: saved.websiteUrl ?? "https://www.cloudroom.dev", userId: saved.account.id, token: saved.sandboxToken } : null;
    }, () => void writeFile(join(deps.config.dataDir, "cloudroom-preview", "woke"), "").catch(() => {}));
    // Renames, generated titles, and agent renames all reach the website. Read after the change's transaction ends.
    deps.hub.onThreadChanged((threadId, changes) => { if (changes.includes("title-changed")) setImmediate(() => this.syncLabel(threadId)); });
  }

  private readonly labels = new Map<string, string>();
  /** Keeps the website's copy of a sandbox thread's title, project name, and Core session current, so the web can
   *  list it and read its history (ADR 0182). Subagents share their parent's sandbox and are found through its history. */
  private syncLabel(threadId: string): void {
    const saved = binding(this.deps.db, threadId), thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return;
    const label = { title: thread.title ?? thread.titleFallback ?? null, project_name: getProject(this.deps.db, thread.projectId)?.name ?? null, session: saved.sessionId };
    const key = JSON.stringify(label);
    if (this.labels.get(threadId) === key) return;
    this.labels.set(threadId, key);
    void this.sandboxes.label(threadId, label).catch((error: unknown) => {
      this.labels.delete(threadId);
      this.warn("Cloud thread label not saved", error, { threadId });
    });
  }

  /** New cloud threads get their own sandbox when the account has sandboxes (docs/scopes/sandboxes.md). */
  /** Background sandbox work never blocks the user, but its failures must reach the log. */
  private warn(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.deps.logger?.warn({ ...fields, error: error instanceof Error ? error.message : String(error) }, message);
  }

  private async sandboxMode(): Promise<boolean> {
    const saved = await this.savedConnection();
    return Boolean(saved?.sandboxToken && saved.account);
  }

  /** Where new cloud threads go. An account that moved back to its VM starts them there; its sandbox threads carry on. */
  async newThreadsInSandboxes(): Promise<boolean> {
    const saved = await this.savedConnection();
    if (!saved?.sandboxToken || !saved.account) return false;
    return !saved.token || await this.sandboxes.forNewThreads();
  }

  private get capabilitiesPath() { return join(this.deps.config.dataDir, "cloudroom-capability-cache.json"); }

  /** Sandboxes sleep, so remember the latest sandbox capabilities for the model picker. */
  private async rememberCapabilities(capabilities: Capabilities, sandbox: boolean): Promise<void> {
    this.lastCapabilities = capabilities;
    if (!sandbox) return;
    const changed = JSON.stringify(this.sandboxCapabilities) !== JSON.stringify(capabilities);
    this.sandboxCapabilities = capabilities;
    if (changed) await writeFile(this.capabilitiesPath, JSON.stringify(capabilities), { mode: 0o600 }).catch(() => {});
  }

  private nextCapabilitiesAsk = 0;
  /** Asks the website what the cloud offers, so a new account knows before its first sandbox runs. The saved copy is
   *  only a fallback: ask every minute, or every 15 s until a spare can answer. */
  private async learnSandboxCapabilities(): Promise<void> {
    if (Date.now() < this.nextCapabilitiesAsk) return;
    this.nextCapabilitiesAsk = Date.now() + 15_000;
    const raw = await this.sandboxes.capabilities();
    if (!raw) return;
    await this.rememberCapabilities(capabilitiesSchema.parse(raw), true);
    this.nextCapabilitiesAsk = Date.now() + 60_000;
  }

  private async savedCapabilities(): Promise<Capabilities | null> {
    if (this.sandboxCapabilities) return this.sandboxCapabilities;
    try { this.sandboxCapabilities = capabilitiesSchema.parse(JSON.parse(await readFile(this.capabilitiesPath, "utf8"))); }
    catch { return null; }
    return this.sandboxCapabilities;
  }

  private get path() { return join(this.deps.config.dataDir, "cloudroom.json"); }

  private async savedConnection() {
    try {
      const info = await stat(this.path);
      if ((info.mode & 0o077) !== 0) throw new Error("permissions");
      return savedConnectionSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ApiError(503, "cloudroom_config_invalid", "The private Cloudroom connection could not be read safely.");
    }
  }

  private async connection(): Promise<Connection> {
    const saved = await this.savedConnection();
    if (saved?.sandboxToken && (!saved.token || !saved.url)) throw new ApiError(409, "cloudroom_sandbox_only", "This action needs a cloud thread. Each cloud thread has its own sandbox, not one shared VM.");
    if (!saved?.token) throw new ApiError(503, "cloudroom_not_configured", "Cloud is an invite-only beta. Join the waitlist at cloudroom.dev, or sign in if you're invited.");
    const { account: _account, websiteUrl: _website, onboarding: _onboarding, sandboxToken: _sandboxToken, ...connection } = saved;
    return connectionSchema.parse(connection);
  }

  private changeConnection(action: () => Promise<void>): Promise<void> {
    const work = this.configurationWrite.then(action);
    this.configurationWrite = work.catch(() => {});
    return work;
  }

  private async saveConnection(value: unknown): Promise<void> {
    await mkdir(this.deps.config.dataDir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  /** A thread's Core. Sandbox threads wake only when `wake` is true, for work that must be sent. */
  private async client(saved?: Binding, wake = true, trigger?: SandboxWakeTrigger): Promise<CloudroomClient> {
    return new CloudroomClient(await this.coreConnection(saved, wake, trigger));
  }

  private async coreConnection(saved?: Binding, wake = true, trigger?: SandboxWakeTrigger): Promise<{ url: string; token: string; gateToken?: string }> {
    if (saved) await this.requireOwnThread(saved);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    if (sandbox) {
      if (wake) {
        void this.uploadMacConfig();
        const logins = this.syncLogins();
        if (!this.sandboxes.loginsCopied) await logins;
      }
      const project = this.sandboxProject(getThread(this.deps.db, sandbox)?.projectId);
      // A sandbox archived while one of its threads is active (a missed or racing restore) comes back for it.
      const found = await this.sandboxes.connection(sandbox, project, wake, trigger).catch(async (error: unknown) => {
        if (!(error instanceof CloudroomError && error.code === "sandbox_archived") || !coreInUse(this.deps.db, SANDBOX_PREFIX + sandbox)) throw error;
        await this.sandboxes.restore(sandbox);
        return this.sandboxes.connection(sandbox, project, wake, trigger);
      });
      if (!found) throw new SandboxAsleep();
      return found;
    }
    const connection = await this.connection();
    if (saved && connection.url !== saved.coreUrl) throw new ApiError(409, "cloudroom_connection_changed", "This thread belongs to a different core connection. Restore its connection before continuing.");
    return connection;
  }

  /** Where a cloud thread's terminal runs: its Core, woken first, and the session whose folder the shell opens in. */
  async terminalConnection(threadId: string): Promise<{ url: string; token: string; gateToken?: string; session: string | null }> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "This cloud thread has no cloud sandbox yet. Send it a message, then open the terminal.");
    const { url, token, gateToken } = await this.coreConnection(saved, true, "thread_view");
    return { url, token, ...(gateToken ? { gateToken } : {}), session: saved.sessionId ?? null };
  }

  /** Cloud threads stamped with another account stay locked until that account signs in again (docs/scopes/sandboxes.md). */
  private async otherAccountThread(saved: Binding): Promise<boolean> {
    return Boolean(saved.accountId) && saved.accountId !== (await this.savedConnection())?.account?.id;
  }

  private async requireOwnThread(saved: Binding): Promise<void> {
    if (await this.otherAccountThread(saved)) throw new ApiError(409, "cloudroom_other_account", "This cloud thread belongs to another Cloudroom account. Sign in with that account to use it.");
  }

  private async storage(client: CloudroomClient): Promise<Storage | null> {
    let health: Record<string, unknown>;
    try { health = await client.health(AbortSignal.timeout(5000)); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) return null;
      if (error instanceof DOMException && error.name === "AbortError") throw new CloudroomConnectionError("Cloud storage health request timed out. Available disk space is unknown.", error);
      throw error;
    }
    if (health.storage === undefined) return null;
    const parsed = storageSchema.safeParse(health.storage);
    if (!parsed.success) throw new ApiError(503, "cloudroom_storage_unknown", "Cloud storage status is invalid. Available disk space is unknown.");
    const storage = parsed.data;
    if (storage.enabled && (storage.reason === "measurement_unavailable" || (storage.sampled_at !== null && (Date.now() - storage.sampled_at > 30_000 || storage.sampled_at > Date.now() + 60_000)))) {
      return { ...storage, level: "blocked", reason: "measurement_unavailable", workspace_available_bytes: null, history_available_bytes: null, workspace_total_bytes: null, history_total_bytes: null };
    }
    return storage;
  }

  private async capabilities(client: CloudroomClient, storage?: Storage | null): Promise<Capabilities> {
    const message = storageMessage(storage === undefined ? await this.storage(client) : storage);
    if (message) throw new ApiError(503, "storage_blocked", message, { retryable: true });
    return capabilitiesSchema.parse(await client.capabilities());
  }

  /** Saves a VM connection, the desktop token for cloud sandboxes, or both (docs/scopes/sandboxes.md). */
  configure(raw: unknown, account?: CloudroomAccount, signal?: AbortSignal, websiteUrl?: string, sandboxToken?: string): Promise<void> {
    return this.changeConnection(async () => {
      signal?.throwIfAborted();
      const connection = raw === null ? null : connectionSchema.parse(raw);
      if (!connection && !(sandboxToken && account)) throw new ApiError(400, "invalid_request", "A VM connection or cloud sandboxes are required.");
      if (connection) connection.url = new URL(connection.url).href.replace(/\/$/, "");
      if (connection?.projectId && !getProject(this.deps.db, connection.projectId)) throw new ApiError(404, "project_not_found", "Project not found");
      const existing = await this.savedConnection();
      const previousAccount = existing?.account && existing.account.id !== account?.id ? existing.account.id : null;
      const savedBindings = bindings(this.deps.db).filter((saved) => !sandboxThread(saved.coreUrl) && (saved.accountId ? saved.accountId === account?.id : !previousAccount));
      if (connection && savedBindings.some((saved) => saved.coreUrl !== connection.url)) throw new ApiError(409, "cloudroom_connection_in_use", "Existing cloud threads belong to another core. Use a separate app profile; history has not been changed.");
      if (connection && savedBindings.length && existing?.projectId && connection.projectId && existing.projectId !== connection.projectId) throw new ApiError(409, "cloudroom_project_in_use", "Existing legacy cloud threads keep their current project binding.");
      if (connection && !account) {
        const client = new CloudroomClient(connection);
        this.lastCapabilities = await this.capabilities(client);
        await client.ready();
      }
      signal?.throwIfAborted();
      this.stop();
      if (previousAccount) {
        stampBindings(this.deps.db, previousAccount);
        this.sandboxes.reset();
      }
      await this.saveConnection({
        ...(connection ?? {}), ...(account ? { account: accountSchema.parse(account) } : {}),
        ...(websiteUrl ? { websiteUrl: websiteSchema.parse(websiteUrl) } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
        ...(account && existing?.account?.id === account.id && existing.url === connection?.url ? { onboarding: existing.onboarding } : {}),
      });
      if (signal?.aborted) {
        if (existing) await this.saveConnection(existing); else await rm(this.path, { force: true });
        if (existing?.token || existing?.sandboxToken) this.start();
        signal.throwIfAborted();
      }
      this.start();
    });
  }

  disconnect(): Promise<void> {
    this.stop();
    return this.changeConnection(async () => {
      this.stop();
      const saved = await this.savedConnection();
      await stopPreviews(this.deps);
      if (saved) {
        const { token: _token, gateToken: _gateToken, sandboxToken, ...binding } = saved;
        await this.saveConnection(binding);
        if (sandboxToken && saved.account) revokeDesktopToken({ website: saved.websiteUrl ?? "https://www.cloudroom.dev", userId: saved.account.id, token: sandboxToken });
      }
      this.sandboxes.reset();
      await stopSync(this.deps);
    });
  }

  private sandboxProject(projectId = PERSONAL_PROJECT_ID): SandboxProject {
    const project = getProject(this.deps.db, projectId);
    return { id: project?.id ?? PERSONAL_PROJECT_ID, repository: project && project.id !== PERSONAL_PROJECT_ID ? githubRepository(project.gitRemoteUrl) : null, folder: workspaceName(project?.name ?? "project") };
  }

  /** The project of the newest cloud thread from the last 7 days, if any. */
  private recentCloudProject(): string | undefined {
    const recent = bindings(this.deps.db).filter(saved => sandboxThread(saved.coreUrl))
      .map(saved => getThread(this.deps.db, saved.threadId))
      .filter(thread => thread && !thread.archivedAt && !thread.deletedAt)
      .sort((a, b) => b!.createdAt - a!.createdAt)[0];
    return recent && Date.now() - recent.createdAt < 7 * 86_400_000 ? recent.projectId : undefined;
  }

  private async warmRecentProject(): Promise<void> {
    const project = this.recentCloudProject();
    if (project) await this.warmSandbox(project, "app_launch");
  }

  async warmSandbox(projectId: string, trigger: SandboxTrigger = "composer"): Promise<void> {
    if (!await this.newThreadsInSandboxes()) return;
    await this.syncLogins();
    void this.uploadMacConfig();
    await this.sandboxes.warm(this.sandboxProject(projectId), trigger);
  }

  private activityAt = 0;
  /** Any app use, Local threads included, keeps the spares warm, so no cloud thread boots (ADRs 0159, 0164). */
  async noteActivity(): Promise<void> {
    if (Date.now() - this.activityAt < 30_000) return;
    this.activityAt = Date.now();
    await this.warmSandbox(this.recentCloudProject() ?? PERSONAL_PROJECT_ID, "app_activity");
  }

  private active = { day: "", at: 0 };
  /** Reports once per UTC day that this account sent a message, Local or Cloud, with past days' active minutes. Failures retry after 10 minutes. */
  noteActiveDay(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.active.day === day || Date.now() - this.active.at < 600_000) return;
    this.active.at = Date.now();
    void (async () => {
      const minutes = await unsentMinutes(this.deps);
      const saved = await this.sandboxes.active(minutes);
      this.active.day = day;
      await markMinutesSent(this.deps, saved ? minutes : {});
    })().catch(() => {});
  }

  async selectOnboardingProject(projectId: string): Promise<void> {
    if (!getProject(this.deps.db, projectId)) throw new ApiError(404, "project_not_found", "Project not found");
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.projectSelected) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async rememberCloudMessage(sessionId: string, requestId: string, epoch: number): Promise<void> {
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.firstMessage || this.epoch !== epoch) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true, firstMessage: { sessionId, requestId } } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async reportOnboarding(): Promise<void> {
    if (this.stopped || this.reportingOnboarding || Date.now() < this.onboardingDue) return;
    this.reportingOnboarding = true;
    this.onboardingDue = Date.now() + 30_000;
    const epoch = this.epoch;
    try {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || !saved.url) return;
      const reported = saved.onboarding?.reported ?? [];
      if (reported.length === 3) return;
      const website = saved.websiteUrl ?? (saved.url.startsWith("https:") ? "https://www.cloudroom.dev" : null);
      if (!website) return;
      const projectSelected = saved.onboarding?.projectSelected || bindings(this.deps.db).some(item => item.coreUrl === saved.url);
      const first = saved.onboarding?.firstMessage ?? this.deps.db.select({ sessionId: cloudroomThreads.sessionId, requestId: cloudroomCommands.id })
        .from(cloudroomCommands).innerJoin(cloudroomThreads, eq(cloudroomThreads.threadId, cloudroomCommands.threadId))
        .where(and(eq(cloudroomThreads.coreUrl, saved.url), eq(cloudroomCommands.command, "prompt"), inArray(cloudroomCommands.state, ["accepted", "completed"]))).limit(1).get();
      const milestones = ["connected", ...(projectSelected ? ["project"] : []), ...(first?.sessionId ? ["message"] : [])] as ("connected" | "project" | "message")[];
      if (milestones.every(item => reported.includes(item))) return;
      if (!reported.includes("connected")) await (await this.client()).ready();
      if (this.stopped || epoch !== this.epoch) return;
      const response = await fetch(`${website}/api/desktop/onboarding`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${saved.account.id}:${saved.token}`).toString("base64")}` },
        body: JSON.stringify({ connected: true, projectSelected: Boolean(projectSelected), ...(first?.sessionId ? { firstMessage: first } : {}) }),
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const confirmed = z.object({ macConnectedAt: z.string().datetime({ offset: true }), projectSelectedAt: z.string().datetime({ offset: true }).nullable(), firstMessageAt: z.string().datetime({ offset: true }).nullable() }).parse(await response.json());
      if (this.stopped || epoch !== this.epoch) return;
      await this.changeConnection(async () => {
        const current = await this.savedConnection();
        if (!current?.token || current.token !== saved.token || current.account?.id !== saved.account!.id || epoch !== this.epoch) return;
        await this.saveConnection({ ...current, onboarding: { ...current.onboarding, reported: ["connected", ...(confirmed.projectSelectedAt ? ["project"] : []), ...(confirmed.firstMessageAt ? ["message"] : [])] } });
      });
    } catch {
    } finally { this.reportingOnboarding = false; }
  }

  private ensurePreviews(capabilities: Capabilities): Promise<void> | undefined {
    if (!capabilities.previews || this.stopped || this.previewSetupEpoch === this.epoch || Date.now() < this.previewRetryAt) return;
    const epoch = this.epoch;
    this.previewSetupEpoch = epoch;
    this.previewRetryAt = Date.now() + 30_000;
    return this.changeConnection(async () => {
      if (this.stopped || epoch !== this.epoch) return;
      await setupPreviews(this.deps);
      if (epoch === this.epoch) this.previewIssue = null;
    }).catch(() => {
      if (epoch !== this.epoch) return;
      this.previewIssue = "Cloud previews could not start. Cloud sessions are unaffected.";
    }).finally(() => { if (this.previewSetupEpoch === epoch) this.previewSetupEpoch = -1; });
  }

  async status() {
    let account: CloudroomAccount | null = null;
    let projectId: string | null = null;
    let storage: Storage | null = null;
    // A core connected by URL and token, with no Cloudroom account: the user hosts it (docs/cloudroom.md).
    let selfHosted = false;
    try {
      const saved = await this.savedConnection();
      account = saved?.token ? saved.account ?? null : null;
      selfHosted = Boolean(saved?.token && !saved.account);
      projectId = saved?.projectId ?? null;
      if (saved?.sandboxToken && saved.account && await this.newThreadsInSandboxes()) {
        // New threads start in sandboxes, which sleep between tasks; report their latest capabilities, never a VM's.
        // Null harnesses mean unknown: the composer then lets the sandbox decide instead of blocking.
        void this.learnSandboxCapabilities().catch(() => {});
        const capabilities = await this.savedCapabilities();
        // The preview helper reaches every awake sandbox through the website (docs/scopes/sandboxes.md).
        if (capabilities) void this.ensurePreviews(capabilities);
        return {
          ready: true, account: saved.account, projectId, storage: null, harnesses: capabilities?.harnesses ?? null, sync: null,
          previews: capabilities?.previews ? { ...await previewStatus(this.deps), issue: this.previewIssue } : null,
          workspaces: true, teleport: capabilities?.teleport ?? false, repository: null,
          model: capabilities?.harnesses.find((h) => h.id === "codex")?.model ?? null,
          steer: capabilities?.steer ?? false, rewind: capabilities?.rewind ?? false, attachments: capabilities?.attachments ?? false,
          compact: capabilities?.compact ?? false, queue_edit: capabilities?.queue_edit ?? false, queue_cancel: capabilities?.queue_cancel ?? false,
          queue_reorder: capabilities?.queue_reorder ?? false, error: null,
        };
      }
      const connection = await this.connection();
      const client = new CloudroomClient({ ...connection, timeoutMs: 5000 });
      storage = await this.storage(client);
      const capabilities = await this.capabilities(client, storage);
      this.lastCapabilities = capabilities;
      await client.ready();
      void this.ensurePreviews(capabilities);
      return {
        ready: true, account, selfHosted, projectId, storage, harnesses: capabilities.harnesses,
        sync: capabilities.sync ? { ...await syncStatus(this.deps), issue: this.syncIssue } : null,
        previews: capabilities.previews ? { ...await previewStatus(this.deps), issue: this.previewIssue } : null,
        workspaces: capabilities.workspaces, teleport: capabilities.teleport, repository: capabilities.repository,
        model: capabilities.harnesses.find((h) => h.id === "codex")?.model ?? null,
        steer: capabilities.steer, rewind: capabilities.rewind, attachments: capabilities.attachments,
        compact: capabilities.compact, queue_edit: capabilities.queue_edit, queue_cancel: capabilities.queue_cancel,
        queue_reorder: capabilities.queue_reorder, error: null,
      };
    } catch (error) { return { ready: false, account, selfHosted, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) }; }
  }

  /** Mac → cloud access (ADR 0113). Local agents reach this through `room-cli vm`.
   *  `threadId` picks a Cloud thread's sandbox and wakes it; without one, only the account's VM can run it. */
  async runOnVm(input: VmRun, threadId?: string, signal?: AbortSignal): Promise<VmRunResult> {
    const saved = threadId ? binding(this.deps.db, threadId) ?? undefined : undefined;
    if (threadId && !saved) throw new ApiError(404, "cloudroom_vm_run", "This is not a Cloud thread. Pass the ID of a Cloud thread.");
    try { return await (await this.client(saved)).runOnVm(input, signal); }
    catch (error) {
      if (error instanceof ApiError && error.body.code === "cloudroom_sandbox_only") throw new ApiError(409, "cloudroom_vm_run", "Pass --thread <id> to pick which Cloud thread's sandbox runs this.");
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_vm_run", publicError(error));
    }
  }

  /** Sandbox accounts keep logins on the website, and every sandbox receives them when it wakes (ADR 0145).
   *  This includes accounts that still have a VM: their new threads run in sandboxes. */
  private async sandboxLogin(name: "claude" | "codex" | "cursor"): Promise<CodexAuthStatus | null> {
    if (!await this.newThreadsInSandboxes()) return null;
    const logins = await this.sandboxes.logins().catch((error: unknown) => { throw new ApiError(503, `${name}_auth_unavailable`, publicError(error)); });
    return { state: logins[name] ? "connected" : "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
  }

  private async uploadMacConfig(): Promise<void> {
    if (!await this.sandboxMode()) return;
    await Promise.all([
      this.sandboxes.copyMacConfig(skillInCloud(await cloudSkills(this.deps))).catch(error => this.warn("Skills could not be copied to cloud sandboxes", error)),
      this.sandboxes.refreshMacMcp().catch(error => this.warn("MCP servers could not be copied to cloud sandboxes", error)),
    ]);
  }

  /** Copies logins both ways when the user allowed it (ADRs 0130, 0175). Only the Mac → cloud copy is awaited. */
  private async syncLogins(cloudChanged = false): Promise<void> {
    if (!await this.sandboxMode() || await copyLogins(this.deps) !== true) return;
    void this.sandboxes.copyCloudLogins(cloudChanged).catch(error => this.warn("Cloud logins could not be copied to this Mac", error));
    await this.sandboxes.copyMacLogins(false, await copyMacGithub(this.deps)).catch(error => this.warn("Logins could not be copied to cloud sandboxes", error));
  }

  async claudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string) {
    const status = await this.claudeAuthStatus(action, requestId, code, state);
    const connected = status.state === "connected";
    // The code sign-in finishes in the background, so a status check that first sees Claude connected also resumes.
    if (connected && (action || !this.claudeConnected)) this.resumeClaudeStarts();
    this.claudeConnected = connected;
    return status;
  }

  /** After an Accounts switch, awake Claude sessions restart once idle, so their next message uses the new login (ADR 0197).
   *  Asleep sandboxes stay asleep; they read the new login when they wake. */
  restartAwakeClaude(): void {
    for (const saved of bindings(this.deps.db)) {
      const thread = getThread(this.deps.db, saved.threadId);
      const sessionId = saved.sessionId;
      if (!sessionId || thread?.providerId !== "claude-code" || thread.archivedAt || thread.deletedAt) continue;
      void this.client(saved, false).then(client => client.sleep(sessionId, randomUUID())).catch(() => {});
    }
  }

  /** Starts that waited for a Claude sign-in continue on their own. Later tries cover a login still reaching an awake sandbox. */
  private resumeClaudeStarts(): void {
    const waiting = (threadId: string) => {
      const saved = binding(this.deps.db, threadId);
      const thread = getThread(this.deps.db, threadId);
      return Boolean(saved && !saved.sessionId && authRequiredMessages.has(saved.error ?? "") && thread?.providerId === "claude-code" && !thread.archivedAt && !thread.deletedAt);
    };
    for (const { threadId } of bindings(this.deps.db)) {
      if (this.resumingStarts.has(threadId) || !waiting(threadId)) continue;
      this.resumingStarts.add(threadId);
      void (async () => {
        for (const wait of [0, 3_000, 10_000]) {
          await new Promise(resolve => setTimeout(resolve, wait).unref());
          if (this.stopped || !waiting(threadId)) return;
          await this.retryStart(threadId).catch(error => this.warn("Cloud start could not continue after Claude sign-in", error, { threadId }));
        }
      })().finally(() => this.resumingStarts.delete(threadId));
    }
  }

  private async claudeAuthStatus(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string) {
    const sandbox = await this.sandboxLogin("claude");
    if (sandbox) {
      if (action === "token" && code) await this.sandboxes.saveLogin("claude", JSON.stringify({ token: code, ...(state ? { plan: state } : {}) }));
      else if (action === "key" && code) await this.sandboxes.saveLogin("claude", JSON.stringify({ apiKey: code }));
      else if (action === "login" || action === "complete") throw new ApiError(409, "claude_auth_unsupported", "Cloud sandboxes connect Claude with a one-year token from this Mac. Use Connect Claude.");
      if ((action === "token" || action === "key") && code) {
        void this.syncLogins(true);
        if ((await this.savedConnection())?.token) await this.vmClaudeAuth(action, requestId, code, state).catch(error => this.warn("Claude could not be connected on the VM", error));
      }
      return action === "token" || action === "key" ? { ...sandbox, state: "connected" as const } : sandbox;
    }
    return this.vmClaudeAuth(action, requestId, code, state);
  }

  private async vmClaudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string) {
    const client = await this.client();
    const capabilities = await this.capabilities(client);
    if (!capabilities.claude_auth) throw new ApiError(409, "claude_auth_unsupported", "Update the cloud core to connect Claude from this app.");
    try { return await client.claudeAuth(action, requestId, code, state); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "claude_auth_unavailable", `Could not reach Claude sign-in on your VM: ${publicError(error)}`); }
  }

  async cursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const sandbox = await this.sandboxLogin("cursor");
    if (sandbox) {
      // Signing in copies this Mac's Cursor login; clicking is the consent, even when automatic copying is off.
      if (action === "login") {
        const login = await macCursorLogin();
        if (!login) throw new ApiError(409, "cursor_auth_required", "Cursor is not signed in on this Mac. Run `cursor-agent login` in your terminal, then click Sign in with Cursor again, or use a Cursor API key.");
        await this.sandboxes.saveLogin("cursor", login);
        return { ...sandbox, state: "connected" as const };
      }
      if (action !== "key") return sandbox.state === "connected" ? sandbox : { ...sandbox, message: "Cloud threads use this Mac's Cursor login, or a Cursor user API key." };
      const key = apiKey?.trim() ?? "";
      if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new ApiError(400, "invalid_request", "Enter a valid Cursor API key.");
      await this.sandboxes.saveLogin("cursor", JSON.stringify({ apiKey: key }));
      if ((await this.savedConnection())?.token) await this.vmCursorAuth(action, requestId, key).catch(error => this.warn("Cursor could not be connected on the VM", error));
      return { ...sandbox, state: "connected" as const };
    }
    return this.vmCursorAuth(action, requestId, apiKey);
  }

  private async vmCursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const client = await this.client();
    const capabilities = await this.capabilities(client);
    if (!capabilities.cursor_auth) throw new ApiError(409, "cursor_auth_unsupported", "Update the cloud core to connect Cursor from this app.");
    try { return await client.cursorAuth(action, requestId, apiKey); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "cursor_auth_unavailable" : "cursor_auth_unavailable", publicError(error)); }
  }

  async piApiKey(provider: string, apiKey: string) {
    const client = await this.client();
    try { return await client.piApiKey(provider, apiKey); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) throw new ApiError(409, "pi_auth_unsupported", "Update the cloud core to set Pi keys from this app.");
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "pi_auth_unavailable" : "pi_auth_unavailable", publicError(error));
    }
  }

  async codexAuth(action?: "login" | "cancel", requestId?: string) {
    if (await this.sandboxLogin("codex")) {
      if (action === "cancel") cancelMacCodexLogin();
      if (action === "login") {
        if (await copyLogins(this.deps) !== true) {
          reportAgentConnect("codex", "failed", { code: "copy_logins_off" });
          throw new ApiError(409, "codex_auth_unsupported", "Cloud sandboxes use this Mac's Codex login. Turn on \"Auth my agents in the cloud automatically\" in Settings → Cloud, then try again.");
        }
        // Signed out or expired here: sign in on this Mac first, then the next status check copies the new login.
        if (await hasMacCodexLogin() && !await macCodexLoginExpired()) await this.sandboxes.copyMacLogins(true, await copyMacGithub(this.deps));
        else startMacCodexLogin();
      }
      const run = macCodexLogin();
      if (run?.done && !run.error) await this.sandboxes.copyMacLogins(true, await copyMacGithub(this.deps));
      const status = (await this.sandboxLogin("codex"))!;
      if (status.state === "connected" && (action === "login" || run?.done)) reportAgentConnect("codex", "ok", { cliPlace: cliPlace(findCliExecutable("codex")) });
      if (status.state === "connected" || !run) return status;
      if (run.error) {
        reportAgentConnect("codex", "failed", { code: "login_failed", message: run.error, cliPlace: cliPlace(findCliExecutable("codex")) });
        return { ...status, state: "error" as const, message: run.error };
      }
      return run.done ? status : { ...status, state: "waiting" as const, login_id: "mac", verification_url: run.url, message: "Finish signing in to ChatGPT in your browser." };
    }
    try {
      const client = await this.client();
      const capabilities = await this.capabilities(client);
      if (!capabilities.codex_auth) throw new ApiError(409, "codex_auth_unsupported", "Update the cloud core to connect Codex from this app.");
      if (capabilities.codex_auth_import && action !== "cancel") await importCodexLogin(this.deps);
      return await client.codexAuth(action, requestId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "codex_auth_unavailable" : "codex_auth_unavailable", publicError(error));
    }
  }

  async threadWorkspace(threadId: string, signal?: AbortSignal) {
    const saved = binding(this.deps.db, threadId);
    if (!saved?.sessionId) return null;
    try {
      const workspace = await (await this.client(saved, false)).sessionWorkspace(saved.sessionId, signal);
      const lastWorkspace = JSON.stringify(workspace);
      if (lastWorkspace !== saved.lastWorkspace) saveBinding(this.deps.db, threadId, { lastWorkspace });
      return workspace;
    } catch (error) {
      // A sleeping sandbox can't change its checkout, so the last one read is still right.
      if (error instanceof SandboxAsleep) return saved.lastWorkspace ? JSON.parse(saved.lastWorkspace) as unknown : null;
      throw error;
    }
  }

  /** Wakes a sleeping cloud thread before work is sent, when the user opens it or starts typing (ADR 0176). */
  async wakeAhead(threadId: string, trigger: SandboxWakeTrigger): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !sandboxThread(saved.coreUrl) || !thread || thread.archivedAt || thread.deletedAt) return;
    await this.client(saved, true, trigger);
  }

  async updateReasoningOverride(thread: Thread, reasoningLevel: ReasoningLevel | null): Promise<void> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    await this.requireOwnThread(saved);
    if (reasoningLevel !== null) {
      const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
      try { validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, known ?? await this.liveCapabilities(saved)); }
      catch (error) {
        if (!known || !(error instanceof ApiError)) throw error;
        validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, await this.liveCapabilities(saved));
      }
    }
    setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: reasoningLevel });
  }

  private async liveCapabilities(saved: Binding): Promise<Capabilities> {
    try { return await this.capabilities(await this.client(saved)); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
  }

  private prompts(threadId: string) {
    return commands(this.deps.db, threadId).filter((item) => item.command === "prompt" && !JSON.parse(item.input).teleport_handoff);
  }

  private currentReasoning(threadId: string, saved: Binding): string {
    return getThreadExecutionOverride(this.deps.db, threadId)?.reasoningLevelOverride ?? commandReasoning(this.prompts(threadId).at(-1)?.input ?? "") ?? saved.reasoning;
  }

  threadStatus(threadId: string) {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return null;
    const prompts = this.prompts(threadId);
    const latestPrompt = prompts.at(-1);
    const reasoning = this.currentReasoning(threadId, saved);
    const transfer = commands(this.deps.db, threadId).find(item => item.command === "teleport");
    const input = latestPrompt ? effectivePrompt(this.deps.db, threadId, latestPrompt.id) : transfer ? JSON.parse(transfer.input).manifest ?? {} : {};
    const serviceTier = input.service_tier === "fast" ? "fast" : "default";
    const initial = prompts.find(item => item.id === `first_${threadId}`);
    const issues = Object.values(this.connectionIssues.get(threadId) ?? {});
    return { authRequired: !saved.sessionId && authRequiredMessages.has(saved.error ?? ""), starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)), sessionId: saved.sessionId, paused: saved.queuePaused, failedStart: !saved.sessionId && initial?.state === "failed", model: saved.model, reasoning, serviceTier, error: saved.error ?? issues.find(issue => !issue.reconnecting)?.message ?? null, reconnecting: issues.some(issue => issue.reconnecting), usageLimit: Boolean(sandboxThread(saved.coreUrl)) && this.sandboxes.usageLimited(), diskFull: this.diskFull.has(threadId) && Boolean(sandboxThread(saved.coreUrl)) && this.sandboxes.smallDisk(), pendingDelivery: commands(this.deps.db, threadId).filter((c) => c.state === "sending").length };
  }

  async create(request: CreateThreadRequest): Promise<Thread> {
    if (request.originKind === "fork" && request.sourceThreadId) return this.createFork(request, request.sourceThreadId);
    const parentId = request.originKind || request.sourceThreadId ? undefined : request.parentThreadId;
    const parent = parentId ? getThread(this.deps.db, parentId) : null;
    if (parent && isCloudThread(parent)) return this.createChild(request, parent.id);
    if (parentId) assertValidParentThread(this.deps, { parentThreadId: parentId });
    const sandbox = await this.newThreadsInSandboxes();
    const connection = sandbox ? null : await this.connection();
    const project = getProject(this.deps.db, request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (!isCloudProvider(request.providerId) || request.originKind || request.sourceThreadId || request.sendAt || request.pluginSubmission || request.environment.type !== "project-default")
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, fx, opencode and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
    if (request.providerId === "acp-cursor") throw new ApiError(400, "cloudroom_unsupported", "Cursor isn't available in Cloud. Use Codex or Claude Code.");
    if (request.permissionMode && request.permissionMode !== "full") throw new ApiError(400, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (request.startedOnBehalfOf || request.sourceSeqEnd !== undefined) throw new ApiError(400, "cloudroom_unsupported", "Cloud continuation and delegated starts are not enabled.");
    // A new sandbox starts on first delivery, so check against the last known capabilities.
    let capabilities = sandbox ? await this.savedCapabilities() : this.lastCapabilities;
    if (!sandbox) {
      try { capabilities = await this.capabilities(await this.client()); this.lastCapabilities = capabilities; }
      catch (error) {
        if (error instanceof ApiError) throw error;
        if (!connectionFailure(error) || (error instanceof CloudroomError && error.code === "storage_blocked")) throw new ApiError(503, "cloudroom_unavailable", publicError(error));
        capabilities = null;
      }
    }
    const profile = capabilities ? harnessProfile(capabilities, request.providerId) : null;
    if (capabilities && request.serviceTier === "fast" && !profile?.service_tier) throw new ApiError(400, "cloudroom_unsupported", "Cloud fast service tier is not enabled");
    const payload = promptPayload(request.input, request.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true);
    const model = request.model;
    const reasoning = request.reasoningLevel ?? "medium";
    if (!model) throw new ApiError(400, "model_required", "Select a Codex model");
    const startRequestId = request.requestId ?? randomUUID();
    const existingThread = (db: DbQueryConnection) => {
      const previous = db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
      if (!previous) return null;
      const initial = command(db, `first_${previous.threadId}`);
      const thread = getThread(db, previous.threadId);
      if (thread?.projectId !== request.projectId || thread?.providerId !== request.providerId || previous.model !== model || previous.reasoning !== reasoning || (initial ? JSON.parse(initial.input).text : null) !== payload.text) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      return thread;
    };
    const previous = existingThread(this.deps.db);
    if (previous) {
      this.holdRejectedStart(previous.id);
      if (command(this.deps.db, `first_${previous.id}`)?.state === "failed" && !binding(this.deps.db, previous.id)?.sessionId) await this.retryStart(previous.id);
      else await this.deliver(previous.id);
      return getThread(this.deps.db, previous.id)!;
    }
    const remoteModel = capabilities ? coreModel(request.providerId, model, capabilities) : null;
    // A sleeping sandbox's saved catalog may predate a login (say, Cursor's key); its Core checks the model at start.
    if (capabilities && remoteModel && !(sandbox && profile?.models === null)) validateReasoning(request.providerId, remoteModel.model, reasoning, capabilities);
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const providerId = request.providerId;
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.deps, project.id);
    const thread = this.deps.db.transaction((tx) => {
      const previous = existingThread(tx);
      if (previous) return previous;
      if (parentId) assertValidParentThread(this.deps, { parentThreadId: parentId });
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: request.projectId, providerId, status: "pending", parentThreadId: parentId ?? null,
        title: request.title, titleFallback: deriveTitleFallback(request.input), sectionId: request.sectionId, visibility: request.visibility,
        originPluginId: request.originPluginId,
        pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
      });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: connection ? connection.url : SANDBOX_PREFIX + thread.id, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${thread.id}`, threadId: thread.id, command: "prompt",
        input: JSON.stringify(this.snapshotInstructions(thread, "prompt", {
          ...payload, ...workspace, provider: remoteModel?.provider,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db), projectNote].filter(Boolean).join("\n\n") || undefined,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(request.baseBranch ? { base_branch: request.baseBranch } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      projectInitialPrompt(tx, thread.id);
      appendStartProgress(tx, thread.id, [cloudStep(Boolean(sandbox))], "active", true);
      queueThreadTitle(tx, thread.id, request.input);
      if (!request.title && shouldGenerateThreadTitle(request.input)) {
        tx.insert(cloudroomCommands).values({
          id: `title_${thread.id}`, threadId: thread.id, command: "title",
          input: JSON.stringify({ input: request.input }), createdAt: Date.now(),
        }).run();
      }
      return thread;
    });
    this.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    void this.selectOnboardingProject(project.id).catch(() => {});
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  /** A Cloud fork (fork.ts): the source's harness and model in a new sandbox, with the history up to the fork point. */
  private async createFork(request: CreateThreadRequest, sourceId: string): Promise<Thread> {
    const source = getThread(this.deps.db, sourceId);
    const saved = binding(this.deps.db, sourceId);
    if (!source || !isCloudThread(source) || !saved?.sessionId || source.archivedAt || source.deletedAt) throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived Cloud thread can be forked.");
    if (!FORK_HARNESSES.includes(source.providerId)) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks support Claude Code and Codex.");
    if ((request.providerId && request.providerId !== source.providerId) || (request.model && request.model !== saved.model)) throw new ApiError(400, "cloudroom_unsupported", "A Cloud fork keeps its source's harness and model.");
    if (request.sendAt || request.pluginSubmission) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks can't be scheduled.");
    const startRequestId = request.requestId ?? randomUUID();
    const previous = this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
    if (previous) return getThread(this.deps.db, previous.threadId)!;
    if (!(await this.newThreadsInSandboxes())) throw new ApiError(409, "cloudroom_unsupported", "Cloud forks need cloud sandboxes.");
    const capabilities = await this.savedCapabilities();
    if (capabilities && !capabilities.fork) throw new ApiError(409, "cloudroom_update", "Update the cloud core to fork Cloud threads.");
    const fork = cloudForkPoint(this.deps.db, source, request.sourceSeqEnd);
    const project = getProject(this.deps.db, source.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    const profile = capabilities ? harnessProfile(capabilities, source.providerId) : null;
    const payload = promptPayload(request.input, source.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true);
    const reasoning = request.reasoningLevel ?? this.currentReasoning(source.id, saved);
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.deps, project.id);
    const thread = this.deps.db.transaction((tx) => {
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: source.projectId, providerId: source.providerId, status: "pending", originKind: "fork", sourceThreadId: source.id,
        title: request.title, titleFallback: deriveTitleFallback(request.input), sectionId: request.sectionId, visibility: request.visibility,
      });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: SANDBOX_PREFIX + thread.id, startRequestId, model: saved.model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${thread.id}`, threadId: thread.id, command: "prompt",
        input: JSON.stringify(this.snapshotInstructions(thread, "prompt", {
          ...payload, ...workspace, fork,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db), projectNote].filter(Boolean).join("\n\n") || undefined,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      queueThreadTitle(tx, thread.id, request.input);
      if (!request.title && shouldGenerateThreadTitle(request.input)) {
        tx.insert(cloudroomCommands).values({ id: `title_${thread.id}`, threadId: thread.id, command: "title", input: JSON.stringify({ input: request.input }), createdAt: Date.now() }).run();
      }
      return thread;
    });
    // The inherited history goes first, so the fork's first message shows after it.
    copyForkSourceHistory(this.deps, { fork: thread, history: { kind: "thread", sourceThreadId: source.id, endSequence: fork.end_sequence } });
    this.deps.db.transaction((tx) => {
      projectInitialPrompt(tx, thread.id);
      appendStartProgress(tx, thread.id, [cloudStep(true)], "active", true);
    });
    this.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  /** A side chat (ADR 0189): a hidden copy of a Cloud thread's conversation in the same sandbox and folder, like
   *  a Local one. Its quoted message waits as hidden context for its first message. */
  async sideChat(source: Thread, request: ForkThreadRequest): Promise<Thread> {
    const saved = binding(this.deps.db, source.id);
    const providerId = source.providerId;
    if (!saved?.sessionId || source.archivedAt || source.deletedAt) throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived Cloud thread can have a side chat.");
    if (!isCloudProvider(providerId) || !FORK_HARNESSES.includes(providerId)) throw new ApiError(400, "cloudroom_unsupported", "Cloud side chats support Claude Code and Codex.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    if (!capabilities.side_chat) throw new ApiError(409, "cloudroom_update", "This Cloud thread's sandbox runs an older Cloudroom version. Side chats work after its next restart.");
    const { end_sequence, before, last_turn_id } = cloudForkPoint(this.deps.db, source, request.sourceSeqEnd);
    const startRequestId = randomUUID();
    let sessionId: string;
    try {
      sessionId = (await client.start(startRequestId, CLOUD_HARNESSES[providerId], { fork: { session: saved.sessionId, before, last_turn_id } })).session_id;
    } catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_fork_rejected", publicError(error));
    }
    const thread = this.deps.db.transaction((tx) => {
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: source.projectId, providerId, status: "starting", originKind: "fork", sourceThreadId: source.id,
        title: request.title ?? null, titleFallback: source.title ?? source.titleFallback, visibility: request.visibility, originPluginId: request.originPluginId,
        pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
      });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: saved.coreUrl, sessionId, startRequestId, model: saved.model, reasoning: saved.reasoning }).run();
      return thread;
    });
    copyForkSourceHistory(this.deps, { fork: thread, history: { kind: "thread", sourceThreadId: source.id, endSequence: end_sequence } });
    if (request.agentContextSeed) appendClientTurnEvent(this.deps, {
      type: "client/turn/requested", threadId: thread.id, environmentId: null, input: request.agentContextSeed, initiator: "agent", senderThreadId: source.id,
      requestMethod: "thread/start", source: "spawn", target: { kind: "thread-start" },
      execution: { source: "client/turn/requested", model: saved.model, reasoningLevel: reasoningLevelSchema.parse(saved.reasoning), permissionMode: "full", serviceTier: "default" },
    });
    this.follow(binding(this.deps.db, thread.id)!, client);
    return getThread(this.deps.db, thread.id)!;
  }

  private async createChild(request: CreateThreadRequest, parentId: string): Promise<Thread> {
    const parent = binding(this.deps.db, parentId);
    const parentThread = getThread(this.deps.db, parentId);
    if (!parent?.sessionId || !parentThread || parentThread.archivedAt || parentThread.deletedAt) throw new ApiError(409, "cloudroom_parent_unavailable", "The parent Cloud thread is archived or has not started yet.");
    if (request.projectId !== parentThread.projectId) throw new ApiError(400, "cloudroom_unsupported", "A child thread belongs to its parent's project.");
    const providerId = request.providerId ?? parentThread.providerId;
    if (!isCloudProvider(providerId) || providerId === "acp-cursor" || providerId === "acp-fx") throw new ApiError(400, "cloudroom_unsupported", "Cloud child threads use Codex, Claude Code, Pi or OpenCode.");
    if (request.sendAt || request.pluginSubmission) throw new ApiError(400, "cloudroom_unsupported", "Cloud child threads can't be scheduled.");
    if (request.baseBranch) throw new ApiError(400, "cloudroom_unsupported", "A Cloud parent's child works in the parent's folder and branch, so a base branch doesn't apply.");
    const { text } = promptPayload(request.input, providerId, false);
    const client = await this.client(parent);
    if (!(await this.capabilities(client)).child_threads) throw new ApiError(409, "cloudroom_unsupported", "This Cloud thread's sandbox runs an older Cloudroom version without child threads.");
    let sessionId: string;
    try {
      sessionId = (await client.start(request.requestId ?? randomUUID(), CLOUD_HARNESSES[providerId], {
        parent_session: parent.sessionId, prompt: text,
        ...(request.model ? { model: request.model } : {}), ...(request.reasoningLevel ? { reasoning: request.reasoningLevel } : {}), ...(request.title ? { title: request.title } : {}),
      })).session_id;
    } catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_child_rejected", publicError(error));
    }
    await this.followChild(parent, client, sessionId);
    const child = this.deps.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, sessionId))).get();
    return getThread(this.deps.db, child!.threadId)!;
  }

  /** Moves a Cloud thread to another harness or model (ADR 0211): a new Core session in the same sandbox and folder.
   *  `record` saves the switch together with the new binding, so the next turn carries the earlier conversation. */
  async switchHarness(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }, record: (tx: DbTransaction) => void): Promise<void> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_not_started", "Wait for the cloud agent to start, then switch.");
    await this.requireOwnThread(saved);
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Wait for Teleport to finish, then switch.");
    if (!isCloudProvider(target.providerId) || target.providerId === "acp-cursor") throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
    if (commands(this.deps.db, thread.id).some((c) => c.state === "sending") || queuedPrompts(this.deps.db, thread.id).length) throw new ApiError(409, "thread_busy", "Wait until queued messages are sent, then switch.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    if (!harnessProfile(capabilities, target.providerId)) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[target.providerId]} isn't set up in Cloud yet.`);
    const reasoning = target.reasoningLevel ?? saved.reasoning;
    const { model, provider } = coreModel(target.providerId, target.model, capabilities);
    validateReasoning(target.providerId, model, reasoning, capabilities);
    if (target.providerId === "codex" && capabilities.codex_auth_import && !sandboxThread(saved.coreUrl)) await importCodexLogin(this.deps);
    if (target.providerId === "pi") await importPiLogin(this.deps);
    // The same folder and settings as the thread's first start, without its project copy or fork.
    const initial = command(this.deps.db, `first_${thread.id}`);
    const options = z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), command_guard_enabled: z.boolean().optional(), strip_ai_co_authors: z.boolean().optional(), system_prompt: z.string().optional() }).parse(initial ? JSON.parse(initial.input) : {});
    if (!capabilities.command_guard) delete options.command_guard_enabled;
    if (!capabilities.strip_ai_co_authors) delete options.strip_ai_co_authors;
    if (!capabilities.system_prompt) delete options.system_prompt;
    const startRequestId = randomUUID();
    const started = await client.start(startRequestId, CLOUD_HARNESSES[target.providerId], { model, reasoning, ...options, ...(provider ? { provider } : {}) });
    if (!["idle", "error"].includes(getThread(this.deps.db, thread.id)?.status ?? "")) {
      void client.close(started.session_id, randomUUID()).catch(() => {});
      throw new ApiError(409, "thread_busy", "The agent started working. Wait until it finishes, then switch.");
    }
    this.detach(thread.id);
    this.deps.db.transaction((tx) => {
      updateThread(tx, this.deps.hub, thread.id, { providerId: target.providerId });
      saveBinding(tx, thread.id, { sessionId: started.session_id, startRequestId, model: target.model, reasoning, cursor: 0, nativeId: null, turnId: null, error: null });
      setThreadExecutionOverride(tx, { threadId: thread.id, modelOverride: null, reasoningLevelOverride: target.reasoningLevel });
      record(tx);
    });
    void client.close(saved.sessionId, randomUUID()).catch((error: unknown) => this.warn("The previous Cloud session could not be closed", error, { threadId: thread.id }));
    this.notify(thread.id);
    void this.deliver(thread.id).catch(() => {});
  }

  async send(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    await this.requireOwnThread(saved);
    if (!saved.sessionId && command(this.deps.db, `first_${thread.id}`)?.state === "failed") throw new ApiError(409, "cloudroom_start_failed", "Retry the rejected cloud start before sending more messages. Your original prompt is saved.");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    if (payload.sendAt || payload.pluginSubmission) throw new ApiError(409, "cloudroom_unsupported", "Cloud follow-ups use the core queue. Scheduling is not enabled.");
    if (isStandaloneBuiltinCompactCommand(payload.input)) {
      await this.compact(thread);
      return { ok: true, delivery: "sent" };
    }
    if (payload.model && payload.model !== saved.model) throw new ApiError(409, "cloudroom_launch_settings", "This thread's model just changed. Send your message again.");
    const id = payload.requestId ?? randomUUID();
    const steer = (payload.mode === "steer" || payload.mode === "steer-if-active") && thread.status === "active" && saved.turnId && !unstartedTurn(this.deps.db, thread.id);
    const previous = command(this.deps.db, id);
    // A side chat's first message carries its quoted message, as on Local; a retry repeats what was sent.
    const seed = steer ? [] : previous?.command === "prompt"
      ? getLeadingAgentOnlyInput(z.array(promptInputSchema).catch([]).parse(JSON.parse(previous.input).content))
      : resolveDeferredFirstTurnContext(this.deps.db, thread.id)?.input ?? [];
    if (seed.length && payload.input[0]?.visibility !== "agent-only") payload = { ...payload, input: [...seed, ...payload.input] };
    const reasoning = payload.reasoningLevel ?? (previous
      ? commandReasoning(previous.input) ?? saved.reasoning
      : this.currentReasoning(thread.id, saved));
    const live = () => this.liveCapabilities(saved);
    const starting = !saved.sessionId && ["pending", "starting"].includes(thread.status);
    const fast = starting || (saved.sessionId && !saved.queuePaused && ["idle", "error", "active"].includes(thread.status));
    const known = fast ? sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities : null;
    const validated = steer || previous ? null : reasoning;
    let parsed: ReturnType<typeof promptPayload>;
    try { parsed = followUpPayload(thread.providerId, saved, payload, validated, known ?? await live()); }
    catch (error) {
      if (!known || !(error instanceof ApiError)) throw error;
      parsed = followUpPayload(thread.providerId, saved, payload, validated, await live());
    }
    if (steer) {
      this.enqueue(thread.id, id, "steer", { target_request_id: saved.turnId, text: parsed.text, content: parsed.content });
      await this.deliver(thread.id);
      return { ok: true, delivery: "sent" };
    }
    const stored = {
      ...parsed,
      ...(reasoning !== saved.reasoning ? { reasoning } : {}),
      ...(payload.serviceTier && payload.serviceTier !== "default" ? { service_tier: payload.serviceTier } : {}),
    };
    if (previous) {
      if (!sameStoredPrompt(previous, thread.id, stored, reasoning, saved.reasoning)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
    } else {
      const jumpQueue = saved.queuePaused && this.queue(thread.id).length > 0 && feature(await live(), "queue_reorder");
      this.enqueue(thread.id, id, "prompt", stored);
      if (jumpQueue) this.enqueue(thread.id, randomUUID(), "reorder", { order: [id] });
      if (saved.queuePaused) this.enqueue(thread.id, randomUUID(), "resume", {});
      const sticky = getThreadExecutionOverride(this.deps.db, thread.id)?.reasoningLevelOverride;
      if (payload.reasoningLevel && sticky && sticky !== payload.reasoningLevel) setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: payload.reasoningLevel });
      if (this.deps.db.transaction(tx => projectFollowUp(tx, thread.id, id))) this.notify(thread.id, ["client/turn/requested"]);
    }
    const delivery = this.deliver(thread.id);
    const shown = this.queue(thread.id).find((item) => item.id === id);
    if (shown || binding(this.deps.db, thread.id)?.turnId === id) {
      void delivery.catch(() => {});
      return shown ? { ok: true, delivery: "queued", queuedMessage: shown } : { ok: true, delivery: "sent" };
    }
    await delivery;
    const state = command(this.deps.db, id)?.state;
    if (state && ["failed", "unknown", "unknown_after_restart"].includes(state)) throw new ApiError(409, "cloudroom_command_failed", "The core reports failed or uncertain execution. Check the conversation before submitting again.");
    const queued = this.queue(thread.id).find((item) => item.id === id);
    return queued ? { ok: true, delivery: "queued", queuedMessage: queued } : { ok: true, delivery: "sent" };
  }

  async control(threadId: string, action: "stop" | "resume"): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    await this.client(saved);
    this.enqueue(threadId, randomUUID(), action, {});
    await this.deliver(threadId);
  }

  archive(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox) {
      // Archive always wins (ADR 0112): the website stops the sandbox even mid-task, once no other thread runs in it.
      this.detach(threadId);
      if (!coreInUse(this.deps.db, saved.coreUrl)) void this.sandboxes.archive(sandbox).catch(error => this.warn("The thread's sandbox could not be archived; it sleeps on its own", error, { threadId }));
      return;
    }
    this.enqueue(threadId, randomUUID(), "stop", {});
    this.enqueue(threadId, randomUUID(), "sleep", {});
    void this.deliver(threadId).catch(() => {});
  }

  /** Each sandbox works on its own branch, named after the thread: room/<name>-<id> (docs/scopes/sandboxes.md).
   *  `create` switches a fresh checkout to it; later calls only rename it to match a new title, before its first push. */
  private async ensureBranch(threadId: string, create: boolean): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return;
    const name = buildSuggestedBranchName({ branchPrefix: "room/", title: thread.title ?? thread.titleFallback ?? null, threadId });
    try {
      const client = await this.client(saved, false);
      const workspace = await client.sessionWorkspace(saved.sessionId);
      if (create) this.progress(threadId, [{ key: "workspace", text: `Using workspace: ${workspace.path}`, status: "completed" }]);
      if (!workspace.head) return;
      const quoted = `'${name}'`;
      // A warm project snapshot skips the clone, so switch to the chosen base branch here.
      const base = baseBranch(command(this.deps.db, `first_${threadId}`)?.input);
      const switchBase = base ? `[ "$current" = '${base}' ] || { git fetch -q origin '${base}' && git checkout -q -B '${base}' 'origin/${base}'; } 2>/dev/null; ` : "";
      const script = create
        ? `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) ;; *) ${switchBase}git pull -q --ff-only 2>/dev/null; git checkout -q -b ${quoted} ;; esac`
        : `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) [ "$current" = ${quoted} ] || git rev-parse -q --verify "$current@{upstream}" >/dev/null || git branch -m ${quoted} ;; esac`;
      const result = await client.runOnVm({ command: `${script}\ngit symbolic-ref --quiet --short HEAD`, cwd: workspace.path });
      const branch = Buffer.from(result.stdout, "hex").toString().trim().split("\n").at(-1);
      if (branch) this.progress(threadId, [{ key: "branch", text: `Using branch: ${branch}`, status: "completed" }]);
    } catch { /* A missing branch never blocks the agent; the next title change retries. */ }
  }

  /** Restores the sandbox the thread runs in, which may be another thread's: an unarchived child keeps its parent's. */
  async restore(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    if (sandbox) await this.sandboxes.restore(sandbox);
  }

  private snapshotInstructions(thread: Pick<Thread, "id" | "projectId">, action: Command["command"], input: object): object {
    if (!["prompt", "edit", "steer", "rewind"].includes(action)) return input;
    const prompt = z.object({ text: z.string(), content: z.unknown().optional() }).parse(
      action === "rewind" && "replacement" in input ? input.replacement : input,
    );
    const customInstructions = resolveCustomInstructions({ threadId: thread.id, projectId: thread.projectId });
    prepareCloudInstructionInput(prompt, customInstructions);
    return { ...input, customInstructions };
  }

  private enqueue(threadId: string, id: string, action: Command["command"], input: object): void {
    const previous = command(this.deps.db, id);
    if (previous) {
      const { customInstructions: _instructions, workspaceContext: _workspace, ...original } = JSON.parse(previous.input);
      if (previous.threadId !== threadId || previous.command !== action || JSON.stringify(original) !== JSON.stringify(input)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      return;
    }
    const thread = getThread(this.deps.db, threadId);
    if (!thread || !binding(this.deps.db, threadId)) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const createdAt = Math.max(Date.now(), (commands(this.deps.db, threadId).at(-1)?.createdAt ?? 0) + 1);
    this.deps.db.insert(cloudroomCommands).values({ id, threadId, command: action, input: JSON.stringify(this.snapshotInstructions(thread, action, input)), createdAt }).run();
    this.notify(threadId);
  }

  private async uploadAttachments(
    client: CloudroomClient,
    sessionId: string,
    promptId: string,
    attachments: { name: string; kind: "image" | "file"; localPath?: string; path?: string; id?: string }[],
    projectId: string,
    parts: boolean,
  ) {
    const uploaded = [];
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.path) {
        uploaded.push({ id: attachment.id, name: attachment.name, kind: attachment.kind, path: attachment.path });
        continue;
      }
      if (!attachment.localPath) continue;
      const root = join(this.deps.config.dataDir, "attachments", projectId);
      const candidate = attachment.localPath.startsWith("/") ? attachment.localPath : join(root, attachment.localPath);
      const bytes = await readFile(candidate);
      const attachmentId = `${promptId}a${index}`;
      const id = attachmentId.length <= 64 ? attachmentId : createHash("sha256").update(attachmentId).digest("hex");
      const name = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment";
      // Cores with upload_parts take files in pieces small enough for every sandbox proxy.
      const accepted = parts
        ? await client.attachInParts(sessionId, id, name, attachment.kind, bytes)
        : await client.attach(sessionId, id, name, attachment.kind, { body: new Blob([bytes]).stream(), length: bytes.byteLength });
      const input = accepted.receipt.input as { id?: string; path?: string };
      uploaded.push({
        id: input.id ?? accepted.receipt.request_id,
        name: attachment.name,
        kind: attachment.kind,
        path: String(input.path ?? ""),
      });
    }
    return uploaded;
  }

  async queueMessage(thread: Thread, payload: SendMessageRequest) {
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const id = payload.requestId ?? randomUUID();
    await this.send(thread, { ...payload, requestId: id });
    return this.queuedMessage(binding(this.deps.db, thread.id)!, command(this.deps.db, id)!);
  }

  queue(threadId: string) {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return [];
    return queuedPrompts(this.deps.db, threadId).map((c) => this.queuedMessage(saved, c));
  }

  private queuedMessage(saved: Binding, c: Command) {
    const stored = effectivePrompt(this.deps.db, saved.threadId, c.id, true) as { text?: string; content?: PromptInput[]; revision?: number; service_tier?: string };
    const revision = stored.revision ?? 1;
    const capabilities = sandboxThread(saved.coreUrl) ? this.sandboxCapabilities : this.lastCapabilities;
    return threadQueuedMessageSchema.parse({
      id: c.id, threadId: saved.threadId, initiator: "user", senderThreadId: null,
      content: Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }],
      model: saved.model, reasoningLevel: commandReasoning(c.input) ?? saved.reasoning, permissionMode: "full",
      serviceTier: stored.service_tier === "fast" ? "fast" : "default",
      sendAt: null, waitingOn: null, failureReason: null, payload: { kind: "inline" }, editable: (c.state === "sending" || c.state === "accepted") && capabilities?.queue_edit === true,
      createdAt: c.createdAt, updatedAt: c.createdAt + revision - 1,
    });
  }

  async editQueued(thread: Thread, queuedMessageId: string, payload: { input: PromptInput[]; expectedUpdatedAt: number }) {
    const saved = binding(this.deps.db, thread.id);
    const current = command(this.deps.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id || current.command !== "prompt" || (current.state !== "sending" && current.state !== "accepted")) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
    const capabilities = known ?? await this.liveCapabilities(saved);
    if (!feature(capabilities, "queue_edit")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue editing is not enabled.");
    const stored = effectivePrompt(this.deps.db, thread.id, current.id, true);
    const revision = Number(stored.revision ?? 1);
    const expectedRevision = payload.expectedUpdatedAt - current.createdAt + 1;
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true));
    const input = { target_request_id: queuedMessageId, expected_revision: expectedRevision, ...parsed,
      reasoning: stored.reasoning ?? saved.reasoning, service_tier: stored.service_tier ?? "default" };
    const id = `qe_${createHash("sha256").update(JSON.stringify([thread.id, input])).digest("hex").slice(0, 60)}`;
    const previous = command(this.deps.db, id);
    if (expectedRevision !== revision && !previous) throw new ApiError(409, "invalid_request", "Queued message changed since editing began");
    this.enqueue(thread.id, id, "edit", input);
    const delivery = this.deliver(thread.id);
    if (current.state === "accepted") await delivery;
    else void delivery.catch(() => {});
    const outcome = command(this.deps.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed" && !(outcome === "sending" && current.state === "sending")) throw new ApiError(409, "cloudroom_command_failed", "The queue edit was not confirmed. Refresh the queue before retrying.");
    return this.queuedMessage(binding(this.deps.db, thread.id)!, command(this.deps.db, queuedMessageId)!);
  }

  async cancelQueued(thread: Thread, queuedMessageId: string) {
    const saved = binding(this.deps.db, thread.id);
    const current = command(this.deps.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id) throw new ApiError(404, "invalid_request", "Queued message not found");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "queue_cancel")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue cancellation is not enabled.");
    this.enqueue(thread.id, randomUUID(), "cancel", { target_request_id: queuedMessageId });
    await this.deliver(thread.id);
  }

  async reorderQueued(thread: Thread, request: { queuedMessageId: string; previousQueuedMessageId: string | null; nextQueuedMessageId: string | null }) {
    const saved = binding(this.deps.db, thread.id);
    const queue = this.queue(thread.id);
    if (!saved || !queue.some((item) => item.id === request.queuedMessageId)) throw new ApiError(404, "invalid_request", "Queued message not found");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "queue_reorder")) throw new ApiError(409, "cloudroom_unsupported", "Update the cloud core to reorder queued messages.");
    const order = queue.map((item) => item.id).filter((id) => id !== request.queuedMessageId);
    const neighbor = request.previousQueuedMessageId ?? request.nextQueuedMessageId;
    if (neighbor !== null && !order.includes(neighbor)) throw new ApiError(409, "invalid_request", "Queued message order changed");
    order.splice(request.previousQueuedMessageId !== null ? order.indexOf(request.previousQueuedMessageId) + 1 : request.nextQueuedMessageId !== null ? order.indexOf(request.nextQueuedMessageId) : 0, 0, request.queuedMessageId);
    if (order.every((id, index) => id === queue[index]!.id)) return queue;
    const id = randomUUID();
    this.enqueue(thread.id, id, "reorder", { order });
    await this.deliver(thread.id);
    const outcome = command(this.deps.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed") throw new ApiError(409, "cloudroom_command_failed", "The queue reorder was not confirmed. Refresh the queue before retrying.");
    return this.queue(thread.id);
  }

  async sendQueued(thread: Thread, queuedMessageId: string): Promise<SendMessageResponse> {
    const saved = binding(this.deps.db, thread.id);
    const queue = this.queue(thread.id);
    const queued = queue.find((item) => item.id === queuedMessageId);
    if (!saved || !queued) throw new ApiError(404, "invalid_request", "Queued message not found");
    const active = thread.status === "active" && saved.turnId !== null && !unstartedTurn(this.deps.db, thread.id);
    if (active && queued.content.every((part) => part.type === "text")) {
      const capabilities = await this.capabilities(await this.client(saved));
      if (feature(capabilities, "steer") && feature(capabilities, "queue_cancel") && harnessProfile(capabilities, thread.providerId)?.steer !== false) {
        await this.send(thread, { mode: "steer", input: queued.content });
        await this.cancelQueued(thread, queuedMessageId).catch(() => {});
        return { ok: true, delivery: "sent" };
      }
    }
    if (queue[0]!.id !== queuedMessageId) throw new ApiError(409, "invalid_request", "This Cloud agent sends queued messages in order. Send or delete the earlier messages first.");
    if (active) await this.control(thread.id, "stop");
    await this.control(thread.id, "resume");
    return { ok: true, delivery: "queued", queuedMessage: queued };
  }

  async compact(thread: Thread) {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "compact") || harnessProfile(capabilities, thread.providerId)?.compact === false) throw new ApiError(409, "cloudroom_unsupported", "Cloud compaction is not enabled for this harness.");
    if (thread.status !== "idle" && thread.status !== "error") throw new ApiError(409, "invalid_request", "Context can only be compacted while the thread is idle or errored");
    this.enqueue(thread.id, randomUUID(), "compact", {});
    await this.deliver(thread.id);
  }

  /** Goal controls work the same as Local (ADR 0137): pause, resume, replace the objective, or clear. */
  async goal(thread: Thread, goal: { status?: "active" | "paused"; objective?: string; clear?: boolean }) {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "goal") || harnessProfile(capabilities, thread.providerId)?.goal !== true) {
      throw new ApiError(409, "cloudroom_unsupported", `Cloud Goal controls need a Codex thread and an updated cloud core (this thread runs ${thread.providerId}).`);
    }
    this.enqueue(thread.id, randomUUID(), "goal", goal);
    await this.deliver(thread.id);
  }

  async editMessage(thread: Thread, payload: EditMessageRequest): Promise<EditMessageResponse> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "rewind") || harnessProfile(capabilities, thread.providerId)?.rewind === false) throw new ApiError(409, "cloudroom_unsupported", "Cloud message editing is not enabled for this harness.");
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true));
    const rewindId = `rewind_${payload.operationId}`;
    const promptId = `edit_${payload.operationId}`;
    const replacement = { request_id: promptId, ...parsed, reasoning: payload.reasoningLevel ?? saved.reasoning, service_tier: payload.serviceTier ?? "default" };
    const previous = command(this.deps.db, rewindId);
    if (previous) {
      const original = JSON.parse(previous.input);
      if (previous.threadId !== thread.id || original.expected_request_sequence !== payload.expectedRequestSequence || JSON.stringify(original.replacement) !== JSON.stringify(replacement)) throw new ApiError(409, "request_conflict", "This edit operation ID belongs to another edit");
    } else {
      if (this.queue(thread.id).length) throw new ApiError(409, "invalid_request", "Send or remove queued messages before editing a message");
      if (thread.status !== "idle" && thread.status !== "error") throw new ApiError(409, "invalid_request", "Wait for the active turn to finish before editing a sent message");
      const before = nativeRewindBefore(this.deps.db, thread.id, payload.expectedRequestSequence);
      // An edit is an explicit send, so it lifts the pause left by Stop. Core rejects resume mid-rewind, so it goes first.
      if (saved.queuePaused) this.enqueue(thread.id, `resume_${payload.operationId}`, "resume", {});
      this.enqueue(thread.id, rewindId, "rewind", { before, expected_request_sequence: payload.expectedRequestSequence, replacement });
    }
    await this.deliver(thread.id);
    if (["failed", "unknown", "unknown_after_restart"].includes(command(this.deps.db, rewindId)?.state ?? "")) throw new ApiError(409, "cloudroom_command_failed", "The rewind failed or its outcome is uncertain. Your original history is preserved.");
    return { ok: true, operationId: payload.operationId, requestSequence: payload.expectedRequestSequence ?? 0 };
  }

  async retryStart(threadId: string): Promise<void> {
    await this.deliveries.get(threadId)?.catch(() => {});
    this.holdRejectedStart(threadId);
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    const first = command(this.deps.db, `first_${threadId}`)?.state;
    if (saved && !saved.sessionId && (first === "sending" || first === "accepted")) return;
    if (!saved || !thread || thread.archivedAt || thread.deletedAt || saved.sessionId || first !== "failed") throw new ApiError(409, "cloudroom_retry", "Only a rejected cloud start can be retried here.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    const harness = thread.providerId;
    if (!isCloudProvider(harness)) throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
    validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, saved.reasoning, capabilities);
    // A retry can start from the sign-in resume and a click at once; only the first one past the awaits sends.
    if (command(this.deps.db, `first_${threadId}`)?.state !== "failed") return;
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "sending");
      saveBinding(tx, threadId, { error: null });
      saveStatus(tx, threadId, "pending");
      appendStartProgress(tx, threadId, [cloudStep(Boolean(sandboxThread(saved.coreUrl)))], "active", true);
    });
    this.notify(threadId, ["system/thread-provisioning"]);
    this.start();
    await this.deliver(threadId);
  }

  private failStart(threadId: string, message: string): void {
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "failed");
      saveBinding(tx, threadId, { error: message });
      saveStatus(tx, threadId, "error");
      appendStartProgress(tx, threadId, [{ key: "error", text: message, status: "failed" }], "failed");
    });
    this.notify(threadId, ["system/thread-provisioning"]);
  }

  private progress(threadId: string, steps: StartStep[], block?: "completed"): void {
    if (this.deps.db.transaction((tx) => appendStartProgress(tx, threadId, steps, block))) this.notify(threadId, ["system/thread-provisioning"], false);
  }

  private retractQueuedHistory(threadId: string): void {
    const queued = queuedPrompts(this.deps.db, threadId).map((c) => c.id);
    if (retractStillQueuedPrompts(this.deps.db, threadId, queued)) this.deps.hub.notifyThread(threadId, ["history-rewritten"]);
  }

  private holdRejectedStart(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    const initial = command(this.deps.db, `first_${threadId}`);
    const backgroundPreparation = initial && z.object({ backgroundPreparation: z.boolean().optional() }).parse(JSON.parse(initial.input)).backgroundPreparation;
    if (saved && !saved.sessionId && !backgroundPreparation && saved.error?.startsWith("Cloudroom rejected the request (HTTP 409)")) {
      this.failStart(threadId, "This cloud start was rejected before the app update. Your prompt is saved. Retry explicitly when ready.");
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    for (const saved of bindings(this.deps.db)) {
      this.holdRejectedStart(saved.threadId);
      if (this.deps.db.transaction(tx => projectInitialPrompt(tx, saved.threadId))) this.notify(saved.threadId, ["client/turn/requested"]);
      this.retractQueuedHistory(saved.threadId);
    }
    this.onboardingDue = 0;
    void this.reportOnboarding();
    void this.syncLogins();
    void this.uploadMacConfig();
    void this.warmRecentProject().catch(() => {});
    this.timer = setInterval(() => {
      this.teleportRecovery?.();
      void this.uploadMacConfig(); // Rate-limited to once a minute; only changed skills are sent.
      void this.reportOnboarding();
      if (this.lastCapabilities) void this.ensurePreviews(this.lastCapabilities);
      for (const saved of bindings(this.deps.db)) {
        const thread = getThread(this.deps.db, saved.threadId);
        // Archived threads take no work, and each check of an asleep sandbox costs a website call.
        if (!thread || thread.archivedAt || thread.deletedAt) continue;
        void this.deliver(saved.threadId).catch(() => {});
      }
    }, 1500);
    this.timer.unref();
    const epoch = this.epoch;
    void this.savedConnection().then(async (saved) => {
      if (!saved?.token || this.stopped || epoch !== this.epoch) return;
      const capabilities = capabilitiesSchema.parse(await (await this.client()).capabilities());
      if (this.stopped || epoch !== this.epoch) return;
      this.lastCapabilities = capabilities;
      await Promise.all([
        capabilities.sync ? setupSync(this.deps).then(() => { if (epoch === this.epoch) this.syncIssue = null; }).catch((error) => { if (epoch === this.epoch) this.syncIssue = publicError(error); }) : Promise.resolve(),
        this.ensurePreviews(capabilities),
      ]);
    }).catch((error) => { if (epoch === this.epoch) this.syncIssue = `Skills and settings sync could not start. Cloud sessions are unaffected. Cause: ${error instanceof Error ? error.message : String(error)}`; });
  }

  stop(): void {
    this.epoch++;
    this.previewRetryAt = 0;
    this.claudeConnected = null;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.streams.values()) controller.abort();
    this.streams.clear();
    this.connectionIssues.clear();
  }

  private deliver(threadId: string): Promise<void> {
    const pending = this.deliveries.get(threadId);
    if (pending) return pending.then(() => this.deliver(threadId));
    const work = this.deliverPending(threadId).finally(() => this.deliveries.delete(threadId));
    this.deliveries.set(threadId, work);
    return work;
  }

  private async deliverPending(threadId: string): Promise<void> {
    this.holdRejectedStart(threadId);
    let saved = binding(this.deps.db, threadId);
    if (!saved || this.stopped || await this.otherAccountThread(saved)) return;
    if (!saved.sessionId && commands(this.deps.db, threadId).some(item => item.command === "teleport")) return;
    if (!saved.sessionId && command(this.deps.db, `first_${threadId}`)?.state === "failed") return;
    const epoch = this.epoch;
    let deliveringCommand = false;
    let rejectedCommand = false;
    // A new thread's project copy waits until its first message is sent or fails (ADR 0160).
    let releaseCopy: (() => void) | undefined;
    try {
      const work = !saved.sessionId || commands(this.deps.db, threadId).some(c => c.state === "sending") || this.catchUpForLocalParent(saved);
      const client = await this.client(saved, work);
      if (epoch !== this.epoch) return;
      if (saved.sessionId) {
        this.follow(saved, client);
        if (!commands(this.deps.db, threadId).some(c => c.state === "sending")) { this.setConnectionIssue(threadId, "delivery"); return; }
        await this.leaveFormerParent(saved, client);
      }
      const sandbox = sandboxThread(saved.coreUrl);
      const known = sandbox ? await this.savedCapabilities() : null;
      const cached = known && harnessProfile(known, getThread(this.deps.db, threadId)?.providerId ?? "") ? known : null;
      const capabilities = cached ?? await this.capabilities(client);
      if (epoch !== this.epoch) return;
      if (!cached) await this.rememberCapabilities(capabilities, Boolean(sandbox));
      if (!saved.sessionId) {
        deliveringCommand = true;
        const harness = getThread(this.deps.db, threadId)?.providerId;
        if (!isCloudProvider(harness)) throw new ApiError(409, "cloudroom_harness", "Unsupported cloud harness; native execution is blocked.");
        this.progress(threadId, [cloudStep(Boolean(sandbox), "completed"), { key: "agent", text: `Starting ${HARNESS_NAMES[harness]}`, status: "started" }]);
        const { model, provider } = coreModel(harness, saved.model, capabilities);
        const initial = command(this.deps.db, `first_${threadId}`);
        const options = initial ? z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), provider: z.string().optional(), command_guard_enabled: z.boolean().optional(), strip_ai_co_authors: z.boolean().optional(), system_prompt: z.string().optional() }).parse(JSON.parse(initial.input)) : {};
        if (!capabilities.command_guard) delete options.command_guard_enabled;
        if (!capabilities.strip_ai_co_authors) delete options.strip_ai_co_authors;
        if (!capabilities.system_prompt) delete options.system_prompt;
        if (!capabilities.direct_workspaces) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents without copying files. Your message is saved.");
        if (options.workspace === ROOT_WORKSPACE && !capabilities.root_workspace) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents outside a project. Your message is saved.");
        if (harness === "codex" && capabilities.codex_auth_import && !sandbox) await importCodexLogin(this.deps);
        if (harness === "pi") await importPiLogin(this.deps);
        const fork = cloudForkOf(initial?.input);
        if (fork && !capabilities.fork) throw new ApiError(503, "cloudroom_update", "Update the cloud core to fork Cloud threads. Your message is saved.");
        const [copy, started] = await Promise.all([
          options.workspace && options.workspace !== ROOT_WORKSPACE ? planProjectCopy(this.deps, client, threadId, options.workspace, { key: sandbox ? `${sandbox}:${options.workspace}` : options.workspace, branch: baseBranch(initial?.input) }) : null,
          fork
            ? startCloudFork(this.deps, client, threadId, fork, {
              model, provider: provider ?? null, reasoning: saved.reasoning, service_tier: z.object({ service_tier: z.string().optional() }).parse(JSON.parse(initial!.input)).service_tier ?? null,
              workspace: options.workspace ?? ROOT_WORKSPACE, workspace_name: options.workspace_name ?? ROOT_WORKSPACE,
              ...(options.command_guard_enabled === undefined ? {} : { command_guard_enabled: options.command_guard_enabled }),
              ...(options.strip_ai_co_authors === undefined ? {} : { strip_ai_co_authors: options.strip_ai_co_authors }),
              ...(options.system_prompt ? { system_prompt: options.system_prompt } : {}),
            }, (transfer) => {
              const latest = command(this.deps.db, `first_${threadId}`)!;
              this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(latest.input), fork: { ...fork, transfer } }) }).where(eq(cloudroomCommands.id, latest.id)).run();
            })
            : client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { model, reasoning: saved.reasoning, ...options, ...(provider ? { provider } : {}) }).then((accepted) => ({ sessionId: accepted.session_id, transfer: "", code: null })),
        ]);
        saveBinding(this.deps.db, threadId, { sessionId: started.sessionId, error: null });
        saved = binding(this.deps.db, threadId)!;
        const copying = copy?.clone && copy.repository ? `Cloning ${copy.repository.replace("https://github.com/", "")}` : copy?.copyAll ? "Copying project from your Mac" : null;
        const files: StartStep[] = copying ? [{ key: "files", text: copying, status: "started" }] : [];
        const forkCode: StartStep[] = started.code ? [{ key: "fork", text: "Copying the source thread's code", status: "started" }] : [];
        this.progress(threadId, [{ key: "agent", status: "completed" }, ...files, ...forkCode], "completed");
        const firstSent = new Promise<void>(resolve => { releaseCopy = resolve; });
        // `cloudroom files wait` holds the agent until the files, and a fork's code, have landed (ADR 0209).
        const workspace = options.workspace && options.workspace !== ROOT_WORKSPACE && (files.length || started.code) ? options.workspace : null;
        const marked = workspace ? firstSent.then(() => this.filesState(client, threadId, workspace, "copying")) : null;
        const landed: Landed = (error, current = client) => {
          if (files.length) this.progress(threadId, [{ key: "files", status: error ? "failed" : "completed" }]);
          const finish = (failure?: string | null) => {
            if (marked && workspace) void marked.then(() => this.filesState(current, threadId, workspace, failure ? `failed: ${failure}` : "ready"));
          };
          if (!started.code) {
            void this.ensureBranch(threadId, true);
            finish(error);
            return;
          }
          // A fork's branch then moves to its source's code, so the agent sees what the source saw.
          void this.ensureBranch(threadId, true).then(() => landForkCode(client, started)).then((failure) => {
            this.progress(threadId, [{ key: "fork", status: failure ? "failed" : "completed" }]);
            finish(failure ?? error);
          });
        };
        if (copy) this.copy(client, copy, landed, firstSent);
        else if (started.code) landed();
        else if (sandbox) void this.ensureBranch(threadId, true);
      }
      if (epoch !== this.epoch) return;
      const sessionId = saved.sessionId!;
      this.follow(saved, client);
      const harness = getThread(this.deps.db, threadId)?.providerId;
      const pendingCommands = commands(this.deps.db, threadId).filter((c) => c.state === "sending");
      for (const pending of pendingCommands) {
        if (epoch !== this.epoch) return;
        deliveringCommand = true;
        try {
          if (pending.command === "title") {
            const thread = getThread(this.deps.db, threadId);
            if (!thread?.title && this.deps.logger && this.deps.aiServices) {
              try {
                const input = z.object({ input: z.array(z.unknown()) }).parse(JSON.parse(pending.input));
                void inferThreadMetadata(this.deps as LoggedWorkSessionDeps, {
                  input: input.input as PromptInput[],
                  provisioningId: saved.startRequestId,
                  threadId,
                  writeTranscript: false,
                }).then(() => this.ensureBranch(threadId, false)).catch(() => {});
              } catch { /* keep the existing fallback title */ }
            }
            if (command(this.deps.db, pending.id)?.state === "sending") saveCommandState(this.deps.db, threadId, pending.id, "completed");
            void this.ensureBranch(threadId, false);
            continue;
          }
          let accepted;
          if (pending.command === "prompt") {
            const parsed = z.object({
              text: z.string(),
              reasoning: z.string().optional(),
              content: z.unknown().optional(),
              attachments: z.array(z.object({
                name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(),
                path: z.string().optional(), id: z.string().optional(),
              })).optional(),
              service_tier: z.string().optional(),
              customInstructions: z.string().default(""),
              workspaceContext: z.string().nullable().optional(),
            }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.content, capabilities, harness);
            if (parsed.attachments?.length) {
              if (!capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
            }
            const attachments = capabilities.attachments
              ? await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)?.projectId ?? "", capabilities.upload_parts)
              : [];
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions);
            // A fork's first message is a native fork of the copied conversation (fork.ts).
            const fork = pending.id === `first_${threadId}` ? cloudForkOf(pending.input) : null;
            let context = parsed.workspaceContext;
            if (context === undefined) {
              const copying = pending.id === `first_${threadId}` && ["cloning", "uploading", "waiting"].includes(projectCopyProgress(this.deps.db, threadId)?.phase ?? "");
              const hint = fork ? FORK_HINT : copying ? "[Cloud workspace context]\nThis project is new on the VM. Cloudroom is copying its files into this folder right now: a GitHub clone or an upload from the user's Mac, plus uncommitted edits and .env files. Run `cloudroom files wait` before you rely on them; it returns once they land, or says why they won't. Never recreate missing files or instructions such as AGENTS.md." : null;
              context = hint && Buffer.byteLength(`${enriched.text}\n\n${hint}`, "utf8") <= 32768 ? hint : null;
              this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(pending.input), workspaceContext: context }) }).where(eq(cloudroomCommands.id, pending.id)).run();
            }
            const text = context ? `${enriched.text}\n\n${context}` : enriched.text;
            const content = context && Array.isArray(enriched.content) ? [...enriched.content, { type: "text", text: `\n${context}` }] : enriched.content;
            const options = {
              ...(capabilities.structured_prompt && content !== undefined ? { content: content as never } : {}),
              ...(attachments.length ? { attachments: attachments as never } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            };
            accepted = fork
              ? await client.rewind(sessionId, `fork_${threadId}`, fork.before, fork.last_turn_id, { request_id: pending.id, text, ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}), ...options }, true)
              : await client.prompt(sessionId, pending.id, text, parsed.reasoning, options);
          } else if (pending.command === "edit") {
            const parsed = z.object({
              target_request_id: z.string(), expected_revision: z.number(), text: z.string(),
              reasoning: z.string().optional(), content: z.unknown().optional(),
              attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), service_tier: z.string().optional(),
              customInstructions: z.string().default(""),
            }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions);
            const attachments = await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)!.projectId, capabilities.upload_parts);
            accepted = await client.edit(sessionId, pending.id, parsed.target_request_id, parsed.expected_revision, enriched.text, {
              ...(enriched.content === undefined ? {} : { content: enriched.content as never }),
              attachments: attachments as never,
              ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            });
          } else if (pending.command === "cancel") {
            accepted = await client.cancel(sessionId, pending.id, JSON.parse(pending.input).target_request_id);
          } else if (pending.command === "reorder") {
            accepted = await client.reorder(sessionId, pending.id, z.object({ order: z.array(z.string()) }).parse(JSON.parse(pending.input)).order);
          } else if (pending.command === "steer") {
            const parsed = z.object({ target_request_id: z.string(), text: z.string(), customInstructions: z.string().default("") }).parse(JSON.parse(pending.input));
            accepted = await client.steer(sessionId, pending.id, parsed.target_request_id, prepareCloudInstructionInput(parsed, parsed.customInstructions).text);
          } else if (pending.command === "compact") {
            accepted = await client.compact(sessionId, pending.id);
          } else if (pending.command === "goal") {
            accepted = await client.goal(sessionId, pending.id, JSON.parse(pending.input));
          } else if (pending.command === "rewind") {
            const parsed = z.object({ before: z.string(), last_turn_id: z.string().optional(), customInstructions: z.string().default(""), replacement: z.object({ request_id: z.string(), text: z.string(), content: z.unknown().optional(), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), reasoning: z.string().optional(), service_tier: z.string().optional() }) }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.replacement.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.replacement.text, content: cloudTextContent(parsed.replacement.content) }, parsed.customInstructions);
            const attachments = await this.uploadAttachments(client, sessionId, parsed.replacement.request_id, parsed.replacement.attachments ?? [], getThread(this.deps.db, threadId)!.projectId, capabilities.upload_parts);
            accepted = await client.rewind(sessionId, pending.id, parsed.before, parsed.last_turn_id, { ...parsed.replacement, ...enriched, content: enriched.content as never, attachments: attachments as never });
          } else if (pending.command === "stop" || pending.command === "resume" || pending.command === "sleep") {
            accepted = await client[pending.command](sessionId, pending.id);
          } else {
            throw new CloudroomError(`Unsupported cloud command ${pending.command}`);
          }
          if (command(this.deps.db, pending.id)?.state === "sending") saveCommandState(this.deps.db, threadId, pending.id, accepted.receipt.state);
          if (pending.command === "prompt") void this.rememberCloudMessage(sessionId, pending.id, epoch).catch(() => {});
        } catch (error) {
          if (error instanceof CloudroomError && error.status !== null && error.status >= 400 && error.status < 500 && !(error.code && error.retryable)) {
            saveCommandState(this.deps.db, threadId, pending.id, "failed");
            rejectedCommand = true;
          }
          throw error;
        }
      }
      if (epoch !== this.epoch) return;
      this.setConnectionIssue(threadId, "delivery");
      if (pendingCommands.length > 0) this.notify(threadId);
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof SandboxAsleep) {
        this.detach(threadId);
        const status = getThread(this.deps.db, threadId)?.status;
        if (status && status !== "idle" && status !== "error" && !commands(this.deps.db, threadId).some(c => c.state === "sending")) {
          saveStatus(this.deps.db, threadId, "idle");
          this.notify(threadId);
        }
        return;
      }
      const message = publicError(error);
      const permanent = error instanceof CloudroomError ? !error.retryable : error instanceof ApiError && error.status === 400;
      if (!binding(this.deps.db, threadId)?.sessionId && permanent) this.failStart(threadId, message);
      else if ((connectionFailure(error) && !rejectedCommand) || !deliveringCommand) this.setConnectionIssue(threadId, "delivery", error);
      else {
        saveBinding(this.deps.db, threadId, { error: message });
        this.setConnectionIssue(threadId, "delivery");
        this.notify(threadId);
      }
      throw new ApiError(permanent ? 400 : 503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", message);
    } finally { releaseCopy?.(); }
  }

  private async followChild(parent: Binding, client: CloudroomClient, childId: string): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread) return;
    const existing = this.deps.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
    if (existing) { this.follow(existing, client); return; }
    const session = await client.session(childId);
    const start = Object.values(session.receipts).find(receipt => receipt.command === "start");
    const input = z.object({ parent_session: z.literal(parent.sessionId!), reasoning: z.string().nullable().optional(), title: z.string().optional(), prompt: z.string().optional() }).parse(start?.input);
    const providerId = (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find(id => CLOUD_HARNESSES[id] === session.harness);
    if (!providerId || !start) throw new CloudroomError("Invalid Cloudroom child session");
    const child = this.deps.db.transaction(tx => {
      const saved = tx.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
      if (saved) return saved;
      const prompt: PromptInput[] = [{ type: "text", text: input.prompt ?? "", mentions: [] }];
      const thread = createThread(tx, this.deps.hub, { executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parent.threadId, title: input.title ?? null, titleFallback: deriveTitleFallback(prompt) ?? `${HARNESS_NAMES[providerId]} child`, status: "pending" });
      if (!input.title) queueThreadTitle(tx, thread.id, prompt);
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: parent.coreUrl, sessionId: childId, startRequestId: start.request_id, model: start.model ?? parent.model, reasoning: input.reasoning ?? parent.reasoning }).run();
      for (const receipt of Object.values(session.receipts).filter(receipt => receipt.command === "prompt")) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId: thread.id, command: "prompt", input: JSON.stringify(receipt.input), state: "accepted", createdAt: Date.now() }).run();
      }
      return binding(tx, thread.id)!;
    });
    this.follow(child, client);
    this.notify(child.threadId);
  }

  private localParentChild(thread: Thread | null): thread is Thread & { parentThreadId: string } {
    const parent = thread && isParentNotifiableChildThread(thread) ? getThread(this.deps.db, thread.parentThreadId) : null;
    return parent !== null && !isCloudThread(parent);
  }

  private tellLocalParent(threadId: string, status: ThreadEventTurnStatus): void {
    const thread = getThread(this.deps.db, threadId);
    if (this.localParentChild(thread)) this.childTurnEnded?.(thread, status);
  }

  private catchUpForLocalParent(saved: Binding): boolean {
    const thread = getThread(this.deps.db, saved.threadId);
    const busy = thread !== null && ["pending", "starting", "active", "stopping"].includes(thread.status);
    const tries = this.catchUps.get(saved.threadId) ?? 0;
    if (!busy || tries >= 5 || this.streams.has(saved.threadId) || !this.localParentChild(thread)) return false;
    if (!this.sandboxes.coolingDown(sandboxThread(saved.coreUrl))) this.catchUps.set(saved.threadId, tries + 1);
    return true;
  }

  private follow(saved: Binding, client: CloudroomClient): void {
    if (this.streams.has(saved.threadId) || !saved.sessionId || this.stopped) return;
    // Once per app run and thread: backfills older threads and saves a new thread's session.
    this.syncLabel(saved.threadId);
    const controller = new AbortController();
    this.streams.set(saved.threadId, controller);
    void (async () => {
      let projecting = false;
      let connected = false;
      try {
        for await (const record of client.stream(saved.sessionId!, {
          after: saved.cursor, signal: controller.signal,
          onConnected: async () => {
            connected = true;
            if (controller.signal.aborted) return;
            this.resumeCopy(saved.threadId, client);
            this.setConnectionIssue(saved.threadId, "stream");
            if (saved.error?.startsWith(connectionOrReplayFailed) && !commands(this.deps.db, saved.threadId).some(item => item.state === "sending")) {
              const snapshot = await client.session(saved.sessionId!, controller.signal);
              if (!controller.signal.aborted && snapshot.last_sequence === saved.cursor && binding(this.deps.db, saved.threadId)?.error === saved.error && !commands(this.deps.db, saved.threadId).some(item => item.state === "sending")) {
                saveBinding(this.deps.db, saved.threadId, { error: null });
                this.notify(saved.threadId);
              }
            }
          },
        })) {
          if (controller.signal.aborted) return;
          if ((record.kind === "child" || record.kind === "child_thread") && record.data && typeof record.data === "object" && "id" in record.data && typeof record.data.id === "string") {
            await this.followChild(saved, client, record.data.id).catch((error: unknown) => this.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          const outage = mentionsOpenAISide401(record) && await codexOutage();
          if (controller.signal.aborted) return;
          projecting = true;
          // The stream replays from the saved cursor, so renames made while the app was offline apply on reconnect.
          if (record.kind === "title") updateThread(this.deps.db, this.deps.hub, saved.threadId, { title: z.object({ title: z.string().min(1) }).parse(record.data).title });
          const effort = record.kind === "reasoning" && z.object({ reasoning: reasoningLevelSchema }).safeParse(record.data);
          if (effort && effort.success) {
            saveBinding(this.deps.db, saved.threadId, { reasoning: effort.data.reasoning });
            setThreadExecutionOverride(this.deps.db, { threadId: saved.threadId, reasoningLevelOverride: effort.data.reasoning });
          }
          const fresh = record.sequence > (binding(this.deps.db, saved.threadId)?.cursor ?? 0);
          const eventTypes = projectRecord(this.deps.db, saved.threadId, record, outage);
          projecting = false;
          this.catchUps.delete(saved.threadId);
          const ended = fresh ? endedTurn(record) : null;
          if (ended) this.tellLocalParent(saved.threadId, ended);
          // Agents archive their own thread with `cloudroom thread archive --self`; like renames, this applies on reconnect.
          if (record.kind === "archive") this.archiveRequest?.(saved.threadId);
          if (record.kind === "secret_request") this.secrets.follow(client, saved.threadId, record);
          this.setConnectionIssue(saved.threadId, "replay");
          if (record.kind === "rewind") this.deps.hub.notifyThread(saved.threadId, ["history-rewritten"]);
          // A full disk shows Free accounts the upgrade notice until space recovers (ADR 0206).
          const data = record.data as Record<string, unknown> | undefined;
          if (record.kind === "storage_pause" && data?.paused === true && data.reason === "disk_capacity") this.diskFull.add(saved.threadId);
          if (record.kind === "storage_recovered") this.diskFull.delete(saved.threadId);
          this.notify(saved.threadId, eventTypes, ["state", "receipt", "native_identity", "storage_pause", "storage_recovered"].includes(record.kind));
        }
        if (!controller.signal.aborted) {
          const ended = new CloudroomConnectionError("Cloudroom event stream ended");
          this.streamBroke(saved.threadId, ended);
          this.setConnectionIssue(saved.threadId, "stream", ended);
        }
      } catch (error) {
        const sandbox = sandboxThread(saved.coreUrl);
        // Only a stream that could not connect may mean the sandbox slept. A drop after connecting keeps its address,
        // so a sandbox's many agents don't all look it up again (each lookup costs the website several queries).
        if (sandbox && !connected) this.sandboxes.forget(sandbox);
        if (!controller.signal.aborted) {
          this.streamBroke(saved.threadId, error);
          const phase = !projecting && (connectionFailure(error) || (error instanceof CloudroomError && error.status !== null)) ? "stream" : "replay";
          this.setConnectionIssue(saved.threadId, phase, error);
        }
      } finally { if (this.streams.get(saved.threadId) === controller) this.streams.delete(saved.threadId); }
    })();
  }

  /** Logs why a Cloud thread's stream broke, once per distinct reason, since it reopens every delivery tick. */
  private streamBroke(threadId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.streamErrors.get(threadId) === reason) return;
    this.streamErrors.set(threadId, reason);
    this.warn("Cloud thread stream broke", error, { threadId });
  }

  /** Copies a new thread's project. If its sandbox sleeps or drops mid-copy (say, the usage cap paused it), the copy waits
   *  and restarts on the thread's next connection, up to 3 times, instead of failing. */
  private copy(client: CloudroomClient, job: ProjectCopyJob, landed: Landed, after?: Promise<void>, tries = 0): void {
    copyProject(this.deps, client, job, error => landed(error, client), after, tries < 3 ? () => {
      this.pausedCopies.set(job.threadId, { job, landed, tries: tries + 1 });
      // Reconnecting finds the sandbox's new address, or that it sleeps; the copy resumes once a stream connects.
      this.detach(job.threadId);
    } : undefined);
  }

  /** "Try again" on a failed project copy: plans it again from the thread's first message, so it also works after a restart. */
  async retryCopy(threadId: string): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const input = command(this.deps.db, `first_${threadId}`)?.input;
    const workspace = input && z.object({ workspace: z.string().optional() }).parse(JSON.parse(input)).workspace;
    if (!saved?.sessionId || !workspace || workspace === ROOT_WORKSPACE) throw new ApiError(409, "cloudroom_no_project_copy", "This thread has no project to copy.");
    const client = await this.client(saved);
    const sandbox = sandboxThread(saved.coreUrl);
    const job = await planProjectCopy(this.deps, client, threadId, workspace, { key: sandbox ? `${sandbox}:${workspace}` : workspace, branch: baseBranch(input) });
    if (!job) throw new ApiError(409, "cloudroom_no_project_copy", "Nothing is left to copy, or a copy is already running.");
    // A folder that already has files gets only its `.env` files again, so a copy cut short stays failed, never ready.
    const full = job.clone || job.copyAll;
    const marked = full ? this.filesState(client, threadId, workspace, "copying") : Promise.resolve();
    this.copy(client, job, (error, current = client) => void marked.then(() => this.filesState(current, threadId, workspace,
      error ? `failed: ${error}` : full ? "ready" : "failed: The project copy was cut short, so some files may be missing.", !full)));
  }

  private filesState(client: CloudroomClient, threadId: string, workspace: string, state: string, onlyIfCopying = false): Promise<void> {
    return writeFilesState(client, workspace, state, onlyIfCopying)
      .catch(error => this.warn("Could not save the project copy state for `cloudroom files wait`", error, { threadId }));
  }

  private resumeCopy(threadId: string, client: CloudroomClient): void {
    const paused = this.pausedCopies.get(threadId);
    // After an app restart only the saved phase is left, so the copy is planned again.
    if (!paused) {
      if (projectCopyProgress(this.deps.db, threadId)?.phase === "waiting") void this.retryCopy(threadId).catch(() => {});
      return;
    }
    this.pausedCopies.delete(threadId);
    this.copy(client, paused.job, paused.landed, undefined, paused.tries);
  }

  private setConnectionIssue(threadId: string, phase: ConnectionPhase, error?: unknown): void {
    const issues = this.connectionIssues.get(threadId) ?? {};
    const previous = issues[phase];
    const vmShutDown = error instanceof CloudroomConnectionError && error.message.includes("unexpected redirect") && !sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    const issue = error === undefined ? undefined : vmShutDown ? { message: retiredVmMessage, reconnecting: false } : {
      message: phase === "replay" && !(error instanceof CloudroomError) ? `Cloudroom history could not be restored: ${error instanceof Error ? error.message : String(error)}` : publicError(error),
      reconnecting: phase !== "replay" && connectionFailure(error),
    };
    if (previous && !previous.reconnecting && issue?.reconnecting) return;
    if (previous?.message === issue?.message && previous?.reconnecting === issue?.reconnecting) return;
    if (issue) issues[phase] = issue;
    else delete issues[phase];
    if (Object.keys(issues).length) this.connectionIssues.set(threadId, issues);
    else this.connectionIssues.delete(threadId);
    if (issue) {
      const saved = binding(this.deps.db, threadId);
      this.deps.logger?.warn({
        threadId, sessionId: saved?.sessionId, cursor: saved?.cursor, phase, ...issue,
        errorType: error instanceof CloudroomError ? error.name : error instanceof z.ZodError ? "ZodError" : error instanceof ApiError ? "ApiError" : error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Error",
        status: error instanceof CloudroomError ? error.status : null,
        code: error instanceof CloudroomError ? error.code : null,
        networkCode: error instanceof CloudroomConnectionError ? error.networkCode : null,
      }, "Cloudroom connection state changed");
    }
    this.notify(threadId);
  }

  private notify(threadId: string, eventTypes: ThreadEventType[] = [], stateChanged = true): void {
    const thread = getThread(this.deps.db, threadId);
    if (!thread) return;
    const changes: ThreadChangeKind[] = [
      ...(eventTypes.length ? ["events-appended" as const] : []),
      ...(stateChanged ? ["status-changed" as const, "queue-changed" as const] : []),
    ];
    if (!changes.length) return;
    this.deps.hub.notifyThread(threadId, changes, {
      ...(stateChanged ? buildThreadStatusChangeMetadata(this.deps, thread) : {}),
      ...(eventTypes.length ? { eventTypes } : {}),
    });
    if (stateChanged) this.deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
  }
}
