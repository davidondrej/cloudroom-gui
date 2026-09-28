import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createThread, getAppSettings, getProject, getThread, getThreadExecutionOverride, setThreadExecutionOverride, updateThread, cloudroomThreads, cloudroomCommands, events, type DbConnection, type DbQueryConnection } from "@bb/db";
import { PERSONAL_PROJECT_ID, encodeClientTurnRequestIdNumber, isStandaloneBuiltinCompactCommand, promptInputSchema, reasoningLevelSchema, threadQueuedMessageSchema, type Thread, type PromptInput, type ThreadEventType, type ThreadChangeKind, type ReasoningLevel } from "@bb/domain";
import type { CreateThreadRequest, SendMessageRequest, SendMessageResponse } from "@bb/server-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, authRequiredMessages, type CodexAuthStatus, type VmRun, type VmRunResult } from "./client.js";
import { CLOUD_HARNESSES, isCloudProvider, projectFollowUp, projectInitialPrompt, projectRecord, retractStillQueuedPrompts, type CloudProvider } from "./events.js";
import { mentionsOpenAISide401 } from "./codex-errors.js";
import { codexOutage } from "./openai-status.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { prepareCloudInstructionInput, resolveCustomInstructions } from "../threads/custom-instructions.js";
import { binding, bindings, command, commands, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, projectCopyProgress, teleportBlocked, unstartedTurn, type Binding, type Command } from "./store.js";
import { copyProject, githubRepository, planProjectCopy } from "./project-copy.js";
import { deriveTitleFallback, shouldGenerateThreadTitle } from "../threads/title-generation.js";
import { inferThreadMetadata } from "../threads/thread-metadata-inference.js";
import { copyLogins, importCodexLogin, importPiLogin, setupSync, stopSync, syncStatus } from "./sync.js";
import { setupPreviews, stopPreviews, previewStatus } from "./previews.js";
import { CloudSecrets } from "./secrets.js";
import { macCursorLogin, SANDBOX_PREFIX, SandboxAsleep, SandboxDirectory, sandboxThread, type SandboxProject } from "./sandboxes.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import type { EditMessageRequest, EditMessageResponse } from "@bb/server-contract";

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
  codex_auth: z.boolean().default(false),
  cursor_auth: z.boolean().default(false),
  claude_auth: z.boolean().default(false),
  codex_auth_import: z.boolean().default(false),
  sync: z.boolean().default(false),
  previews: z.boolean().default(false),
  structured_prompt: z.boolean().default(false),
  queue_edit: z.boolean().default(false),
  queue_cancel: z.boolean().default(false),
  queue_reorder: z.boolean().default(false),
  steer: z.boolean().default(false),
  rewind: z.boolean().default(false),
  attachments: z.boolean().default(false),
  compact: z.boolean().default(false),
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
  return `Cloud disk space is critically low${bytes === null ? "" : ` (${(bytes / 1e9).toFixed(1)} GB available)`}. Work resumes automatically when space recovers. Saved messages are kept.`;
}
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry"> & Partial<LoggedWorkSessionDeps> & Partial<Pick<AppDeps, "pendingInteractions">>;
const services = new WeakMap<DbConnection, CloudroomService>();
const workspaceId = (projectId: string) => `bb_${projectId}`;
const ROOT_WORKSPACE = "root";
const workspaceName = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 80) || "project";

export function cloudroom(deps: Deps): CloudroomService {
  let service = services.get(deps.db);
  if (!service) { service = new CloudroomService(deps); services.set(deps.db, service); }
  return service;
}

/** Where a cloud thread runs, for anonymous usage events: its own sandbox or the older shared VM. */
export function cloudExecution(deps: Pick<AppDeps, "db">, threadId: string): "cloud_sandbox" | "cloud_vm" {
  return sandboxThread(binding(deps.db, threadId)?.coreUrl ?? "") ? "cloud_sandbox" : "cloud_vm";
}

export function isCloudThread(thread: Pick<Thread, "executionTarget">): boolean {
  return thread.executionTarget === "cloud";
}

export function requireNativeThread(thread: Pick<Thread, "executionTarget">): void {
  if (isCloudThread(thread)) throw new ApiError(409, "cloudroom_unsupported", "This action is not supported for Cloud threads. Native execution is blocked.");
}

type PromptAttachment = { name: string; kind: "image" | "file"; localPath: string; id?: string; path?: string };

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
        if (resource.kind !== "command" || resource.source !== "skill") throw new ApiError(400, "cloudroom_unsupported", "Cloud supports skill tags, but other mentions and commands are not enabled.");
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
  if ((!text.trim() && attachments.length === 0) || Buffer.byteLength(text) > 32768) throw new ApiError(400, "invalid_request", "Prompt must contain 1–32768 bytes of text");
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
  if (harness === "acp-cursor" || harness === "acp-fx") throw new ApiError(409, "cloudroom_launch_settings", `${harness === "acp-fx" ? "fx" : "Cursor"} reasoning is fixed for this cloud session. Start a new thread to change it.`);
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

type ConnectionPhase = "delivery" | "stream" | "replay";
type ConnectionIssue = { message: string; reconnecting: boolean };

class CloudroomService {
  teleportRecovery?: () => void;
  archiveRequest?: (threadId: string) => void;
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
  async threadClient(threadId: string): Promise<CloudroomClient> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_thread_unstarted", "This cloud thread has not started yet.");
    return this.client(saved);
  }
  followTeleport(threadId: string): void { void this.deliver(threadId).catch(() => {}); }
  detach(threadId: string): void {
    this.streams.get(threadId)?.abort();
    this.streams.delete(threadId);
    this.connectionIssues.delete(threadId);
  }
  private readonly streams = new Map<string, AbortController>();
  private readonly connectionIssues = new Map<string, Partial<Record<ConnectionPhase, ConnectionIssue>>>();
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
  /** What sandboxes run, kept apart from a VM's: an account with both starts new threads in sandboxes. */
  private sandboxCapabilities: Capabilities | null = null;
  private readonly secrets: CloudSecrets;
  readonly sandboxes: SandboxDirectory;
  constructor(private readonly deps: Deps) {
    this.secrets = new CloudSecrets(deps);
    this.sandboxes = new SandboxDirectory(async () => {
      const saved = await this.savedConnection();
      return saved?.sandboxToken && saved.account ? { website: saved.websiteUrl ?? "https://www.cloudroom.dev", userId: saved.account.id, token: saved.sandboxToken } : null;
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
  private async client(saved?: Binding, wake = true): Promise<CloudroomClient> {
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    if (sandbox) {
      if (wake) {
        void this.uploadMacConfig();
        const logins = this.uploadMacLogins();
        if (!this.sandboxes.loginsCopied) await logins;
      }
      const found = await this.sandboxes.connection(sandbox, this.sandboxProject(getThread(this.deps.db, sandbox)?.projectId), wake);
      if (!found) throw new SandboxAsleep();
      return new CloudroomClient(found);
    }
    const connection = await this.connection();
    if (saved && connection.url !== saved.coreUrl) throw new ApiError(409, "cloudroom_connection_changed", "This thread belongs to a different core connection. Restore its connection before continuing.");
    return new CloudroomClient(connection);
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
      const allBindings = bindings(this.deps.db);
      const savedBindings = allBindings.filter((saved) => !sandboxThread(saved.coreUrl));
      if ((connection && savedBindings.some((saved) => saved.coreUrl !== connection.url)) || (allBindings.length && existing?.account && existing.account.id !== account?.id)) throw new ApiError(409, "cloudroom_connection_in_use", "Existing cloud threads belong to another account or core. Use a separate app profile; history has not been changed.");
      if (connection && savedBindings.length && existing?.projectId && connection.projectId && existing.projectId !== connection.projectId) throw new ApiError(409, "cloudroom_project_in_use", "Existing legacy cloud threads keep their current project binding.");
      if (connection && !account) {
        const client = new CloudroomClient(connection);
        this.lastCapabilities = await this.capabilities(client);
        await client.ready();
      }
      signal?.throwIfAborted();
      this.stop();
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
        const { token: _token, gateToken: _gateToken, sandboxToken: _sandboxToken, ...binding } = saved;
        await this.saveConnection(binding);
      }
      await stopSync(this.deps);
    });
  }

  private sandboxProject(projectId = PERSONAL_PROJECT_ID): SandboxProject {
    const project = getProject(this.deps.db, projectId);
    return { id: project?.id ?? PERSONAL_PROJECT_ID, repository: project && project.id !== PERSONAL_PROJECT_ID ? githubRepository(project.gitRemoteUrl) : null, folder: workspaceName(project?.name ?? "project") };
  }

  private async warmRecentProject(): Promise<void> {
    const recent = bindings(this.deps.db).filter(saved => sandboxThread(saved.coreUrl))
      .map(saved => getThread(this.deps.db, saved.threadId))
      .filter(thread => thread && !thread.archivedAt && !thread.deletedAt)
      .sort((a, b) => b!.createdAt - a!.createdAt)[0];
    if (recent && Date.now() - recent.createdAt < 7 * 86_400_000) await this.warmSandbox(recent.projectId);
  }

  async warmSandbox(projectId: string): Promise<void> {
    if (!await this.newThreadsInSandboxes()) return;
    await this.uploadMacLogins();
    void this.uploadMacConfig();
    await this.sandboxes.warm(this.sandboxProject(projectId));
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
    try {
      const saved = await this.savedConnection();
      account = saved?.token ? saved.account ?? null : null;
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
        ready: true, account, projectId, storage, harnesses: capabilities.harnesses,
        sync: capabilities.sync ? { ...await syncStatus(this.deps), issue: this.syncIssue } : null,
        previews: capabilities.previews ? { ...await previewStatus(this.deps), issue: this.previewIssue } : null,
        workspaces: capabilities.workspaces, teleport: capabilities.teleport, repository: capabilities.repository,
        model: capabilities.harnesses.find((h) => h.id === "codex")?.model ?? null,
        steer: capabilities.steer, rewind: capabilities.rewind, attachments: capabilities.attachments,
        compact: capabilities.compact, queue_edit: capabilities.queue_edit, queue_cancel: capabilities.queue_cancel,
        queue_reorder: capabilities.queue_reorder, error: null,
      };
    } catch (error) { return { ready: false, account, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) }; }
  }

  /** Mac → VM access (ADR 0113). Local agents reach this through `cloudroom vm`. */
  async runOnVm(input: VmRun, signal?: AbortSignal): Promise<VmRunResult> {
    try { return await new CloudroomClient(await this.connection()).runOnVm(input, signal); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_vm_run", publicError(error)); }
  }

  /** Sandbox accounts keep logins on the website, and every sandbox receives them when it wakes (ADR 0145).
   *  This includes accounts that still have a VM: their new threads run in sandboxes. */
  private async sandboxLogin(name: "claude" | "codex" | "cursor"): Promise<CodexAuthStatus | null> {
    if (!await this.newThreadsInSandboxes()) return null;
    const logins = await this.sandboxes.logins().catch((error: unknown) => { throw new ApiError(503, `${name}_auth_unavailable`, publicError(error)); });
    return { state: logins[name] ? "connected" : "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
  }

  private async uploadMacConfig(): Promise<void> {
    if (await this.sandboxMode()) await this.sandboxes.copyMacConfig().catch(error => this.warn("Skills could not be copied to cloud sandboxes", error));
  }

  private async uploadMacLogins(): Promise<void> {
    if (await this.sandboxMode() && await copyLogins(this.deps) === true) await this.sandboxes.copyMacLogins().catch(error => this.warn("Logins could not be copied to cloud sandboxes", error));
  }

  async claudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string) {
    const status = await this.claudeAuthStatus(action, requestId, code, state);
    const connected = status.state === "connected";
    // The code sign-in finishes in the background, so a status check that first sees Claude connected also resumes.
    if (connected && (action || !this.claudeConnected)) this.resumeClaudeStarts();
    this.claudeConnected = connected;
    return status;
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
      if ((action === "token" || action === "key") && code && (await this.savedConnection())?.token) await this.vmClaudeAuth(action, requestId, code, state).catch(error => this.warn("Claude could not be connected on the VM", error));
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
      if (action === "login") {
        if (await copyLogins(this.deps) !== true) throw new ApiError(409, "codex_auth_unsupported", "Cloud sandboxes use this Mac's Codex login. Allow copying logins in Cloudroom's setup, then try again.");
        await this.sandboxes.copyMacLogins();
      }
      return (await this.sandboxLogin("codex"))!;
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
    try { return (await this.client(saved, false)).sessionWorkspace(saved.sessionId, signal); }
    catch (error) { if (error instanceof SandboxAsleep) return null; throw error; }
  }

  async updateReasoningOverride(thread: Thread, reasoningLevel: ReasoningLevel | null): Promise<void> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    if (reasoningLevel !== null) {
      try {
        const capabilities = await this.capabilities(await this.client(saved));
        validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, capabilities);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, "model_catalog_unavailable", publicError(error));
      }
    }
    setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: reasoningLevel });
  }

  threadStatus(threadId: string) {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return null;
    const prompts = commands(this.deps.db, threadId).filter((item) => item.command === "prompt" && !JSON.parse(item.input).teleport_handoff);
    const latestPrompt = prompts.at(-1);
    const reasoning = getThreadExecutionOverride(this.deps.db, threadId)?.reasoningLevelOverride ?? commandReasoning(latestPrompt?.input ?? "") ?? saved.reasoning;
    const transfer = commands(this.deps.db, threadId).find(item => item.command === "teleport");
    const input = latestPrompt ? effectivePrompt(this.deps.db, threadId, latestPrompt.id) : transfer ? JSON.parse(transfer.input).manifest ?? {} : {};
    const serviceTier = input.service_tier === "fast" ? "fast" : "default";
    const initial = prompts.find(item => item.id === `first_${threadId}`);
    const issues = Object.values(this.connectionIssues.get(threadId) ?? {});
    return { authRequired: !saved.sessionId && authRequiredMessages.has(saved.error ?? ""), starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)), sessionId: saved.sessionId, paused: saved.queuePaused, failedStart: !saved.sessionId && initial?.state === "failed", model: saved.model, reasoning, serviceTier, error: saved.error ?? issues.find(issue => !issue.reconnecting)?.message ?? null, reconnecting: issues.some(issue => issue.reconnecting), pendingDelivery: commands(this.deps.db, threadId).filter((c) => c.state === "sending").length };
  }

  async create(request: CreateThreadRequest): Promise<Thread> {
    const sandbox = await this.newThreadsInSandboxes();
    const connection = sandbox ? null : await this.connection();
    const project = getProject(this.deps.db, request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (!isCloudProvider(request.providerId) || request.originKind || request.parentThreadId || request.sourceThreadId || request.sendAt || request.pluginSubmission || request.environment.type !== "project-default")
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, Cursor, fx and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
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
    const thread = this.deps.db.transaction((tx) => {
      const previous = existingThread(tx);
      if (previous) return previous;
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: request.projectId, providerId, status: "pending",
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
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      projectInitialPrompt(tx, thread.id);
      if (!request.title && shouldGenerateThreadTitle(request.input)) {
        tx.insert(cloudroomCommands).values({
          id: `title_${thread.id}`, threadId: thread.id, command: "title",
          input: JSON.stringify({ input: request.input }), createdAt: Date.now(),
        }).run();
      }
      return thread;
    });
    this.notify(thread.id, ["client/turn/requested"]);
    void this.selectOnboardingProject(project.id).catch(() => {});
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  async send(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    if (!saved.sessionId && command(this.deps.db, `first_${thread.id}`)?.state === "failed") throw new ApiError(409, "cloudroom_start_failed", "Retry the rejected cloud start before sending more messages. Your original prompt is saved.");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    if (payload.sendAt || payload.pluginSubmission) throw new ApiError(409, "cloudroom_unsupported", "Cloud follow-ups use the core queue. Scheduling is not enabled.");
    if (isStandaloneBuiltinCompactCommand(payload.input)) {
      await this.compact(thread);
      return { ok: true, delivery: "sent" };
    }
    if (payload.permissionMode && payload.permissionMode !== "full") throw new ApiError(409, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (payload.model && payload.model !== saved.model) throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
    const id = payload.requestId ?? randomUUID();
    const steer = (payload.mode === "steer" || payload.mode === "steer-if-active") && thread.status === "active" && saved.turnId && !unstartedTurn(this.deps.db, thread.id);
    const previous = command(this.deps.db, id);
    const reasoning = payload.reasoningLevel ?? (previous
      ? commandReasoning(previous.input) ?? saved.reasoning
      : getThreadExecutionOverride(this.deps.db, thread.id)?.reasoningLevelOverride ?? saved.reasoning);
    const live = async () => {
      try { return await this.capabilities(await this.client(saved)); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
      }
    };
    const fast = saved.sessionId && !saved.queuePaused && ["idle", "error", "active"].includes(thread.status);
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
      this.enqueue(thread.id, id, "prompt", stored);
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

  async control(threadId: string, action: "stop" | "resume", requestId: string = randomUUID()): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    await this.client(saved);
    this.enqueue(threadId, requestId, action, {});
    await this.deliver(threadId);
  }

  archive(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox) {
      // Archive always wins (ADR 0112): the website stops the sandbox even mid-task. Children share it.
      this.detach(threadId);
      if (sandbox === threadId) void this.sandboxes.archive(sandbox).catch(error => this.warn("The thread's sandbox could not be archived; it sleeps on its own", error, { threadId }));
      return;
    }
    this.enqueue(threadId, randomUUID(), "stop", {});
    this.enqueue(threadId, randomUUID(), "sleep", {});
    void this.deliver(threadId).catch(() => {});
  }

  /** Each sandbox works on its own branch, named after the thread: cloudroom/<name>-<id> (docs/scopes/sandboxes.md).
   *  `create` switches a fresh checkout to it; later calls only rename it to match a new title, before its first push. */
  private async ensureBranch(threadId: string, create: boolean): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return;
    const slug = (thread.title ?? thread.titleFallback ?? "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
    const name = `cloudroom/${slug}-${threadId.replace(/^thr_/, "").slice(-4)}`;
    try {
      const client = await this.client(saved, false);
      const workspace = await client.sessionWorkspace(saved.sessionId);
      if (!workspace.head) return;
      const quoted = `'${name}'`;
      const script = create
        ? `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in cloudroom/*) ;; *) git pull -q --ff-only 2>/dev/null; git checkout -q -b ${quoted} ;; esac`
        : `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in cloudroom/*) [ "$current" = ${quoted} ] || git rev-parse -q --verify "$current@{upstream}" >/dev/null || git branch -m ${quoted} ;; esac`;
      await client.runOnVm({ command: script, cwd: workspace.path });
    } catch { /* A missing branch never blocks the agent; the next title change retries. */ }
  }

  async restore(threadId: string): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    if (saved && sandboxThread(saved.coreUrl) === threadId) await this.sandboxes.restore(threadId);
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
    this.deps.db.insert(cloudroomCommands).values({ id, threadId, command: action, input: JSON.stringify(this.snapshotInstructions(thread, action, input)), createdAt: Date.now() }).run();
    this.notify(threadId);
  }

  private async uploadAttachments(
    client: CloudroomClient,
    sessionId: string,
    promptId: string,
    attachments: { name: string; kind: "image" | "file"; localPath?: string; path?: string; id?: string }[],
    projectId: string,
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
      const accepted = await client.attach(
        sessionId,
        attachmentId.length <= 64 ? attachmentId : createHash("sha256").update(attachmentId).digest("hex"),
        attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment",
        attachment.kind,
        { body: new Blob([bytes]).stream(), length: bytes.byteLength },
      );
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
    const stored = effectivePrompt(this.deps.db, saved.threadId, c.id) as { text?: string; content?: PromptInput[]; revision?: number; service_tier?: string };
    const revision = stored.revision ?? 1;
    return threadQueuedMessageSchema.parse({
      id: c.id, threadId: saved.threadId, initiator: "user", senderThreadId: null,
      content: Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }],
      model: saved.model, reasoningLevel: commandReasoning(c.input) ?? saved.reasoning, permissionMode: "full",
      serviceTier: stored.service_tier === "fast" ? "fast" : "default",
      groupWithNext: false, sendAt: null, waitingOn: null, failureReason: null, payload: { kind: "inline" }, editable: c.state === "accepted" && this.lastCapabilities?.queue_edit === true,
      createdAt: c.createdAt, updatedAt: c.createdAt + revision - 1,
    });
  }

  async editQueued(thread: Thread, queuedMessageId: string, payload: { input: PromptInput[]; expectedUpdatedAt: number }) {
    const saved = binding(this.deps.db, thread.id);
    if (command(this.deps.db, queuedMessageId)?.state === "sending") await this.deliver(thread.id).catch(() => {});
    const current = command(this.deps.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id || current.command !== "prompt" || current.state !== "accepted") {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "queue_edit")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue editing is not enabled.");
    const stored = effectivePrompt(this.deps.db, thread.id, current.id);
    const revision = Number(stored.revision ?? 1);
    const expectedRevision = payload.expectedUpdatedAt - current.createdAt + 1;
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true));
    const input = { target_request_id: queuedMessageId, expected_revision: expectedRevision, ...parsed,
      reasoning: stored.reasoning ?? saved.reasoning, service_tier: stored.service_tier ?? "default" };
    const id = `qe_${createHash("sha256").update(JSON.stringify([thread.id, input])).digest("hex").slice(0, 60)}`;
    const previous = command(this.deps.db, id);
    if (expectedRevision !== revision && !previous) throw new ApiError(409, "invalid_request", "Queued message changed since editing began");
    this.enqueue(thread.id, id, "edit", input);
    await this.deliver(thread.id);
    const outcome = command(this.deps.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed") throw new ApiError(409, "cloudroom_command_failed", "The queue edit was not confirmed. Refresh the queue before retrying.");
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
    });
    this.start();
    await this.deliver(threadId);
  }

  private failStart(threadId: string, message: string): void {
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "failed");
      saveBinding(tx, threadId, { error: message });
      saveStatus(tx, threadId, "error");
    });
    this.notify(threadId);
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
    void this.uploadMacLogins();
    void this.uploadMacConfig();
    void this.warmRecentProject().catch(() => {});
    this.timer = setInterval(() => {
      this.teleportRecovery?.();
      void this.uploadMacConfig(); // Rate-limited to once a minute; only changed skills are sent.
      void this.reportOnboarding();
      if (this.lastCapabilities) void this.ensurePreviews(this.lastCapabilities);
      for (const saved of bindings(this.deps.db)) {
        const thread = getThread(this.deps.db, saved.threadId);
        if (!thread || thread.deletedAt) continue;
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
    if (!saved || this.stopped) return;
    if (!saved.sessionId && commands(this.deps.db, threadId).some(item => item.command === "teleport")) return;
    if (!saved.sessionId && command(this.deps.db, `first_${threadId}`)?.state === "failed") return;
    const epoch = this.epoch;
    let deliveringCommand = false;
    let rejectedCommand = false;
    try {
      const work = !saved.sessionId || commands(this.deps.db, threadId).some(c => c.state === "sending");
      const client = await this.client(saved, work);
      if (epoch !== this.epoch) return;
      if (saved.sessionId) {
        this.follow(saved, client);
        if (!commands(this.deps.db, threadId).some(c => c.state === "sending")) { this.setConnectionIssue(threadId, "delivery"); return; }
      }
      const known = !saved.sessionId && sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : null;
      const firstStartCapabilities = known && harnessProfile(known, getThread(this.deps.db, threadId)?.providerId ?? "") ? known : null;
      const capabilities = firstStartCapabilities ?? await this.capabilities(client);
      if (epoch !== this.epoch) return;
      if (!firstStartCapabilities) await this.rememberCapabilities(capabilities, Boolean(sandboxThread(saved.coreUrl)));
      if (!saved.sessionId) {
        deliveringCommand = true;
        const harness = getThread(this.deps.db, threadId)?.providerId;
        if (!isCloudProvider(harness)) throw new ApiError(409, "cloudroom_harness", "Unsupported cloud harness; native execution is blocked.");
        const { model, provider } = coreModel(harness, saved.model, capabilities);
        const initial = command(this.deps.db, `first_${threadId}`);
        const options = initial ? z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), provider: z.string().optional(), command_guard_enabled: z.boolean().optional() }).parse(JSON.parse(initial.input)) : {};
        if (!capabilities.command_guard) delete options.command_guard_enabled;
        if (!capabilities.direct_workspaces) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents without copying files. Your message is saved.");
        if (options.workspace === ROOT_WORKSPACE && !capabilities.root_workspace) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents outside a project. Your message is saved.");
        if (harness === "codex" && capabilities.codex_auth_import) await importCodexLogin(this.deps);
        if (harness === "pi") await importPiLogin(this.deps);
        const sandbox = sandboxThread(saved.coreUrl);
        const copy = options.workspace && options.workspace !== ROOT_WORKSPACE ? await planProjectCopy(this.deps, client, threadId, options.workspace, undefined, sandbox ? `${sandbox}:${options.workspace}` : options.workspace) : null;
        if (epoch !== this.epoch) return;
        const accepted = await client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { model, reasoning: saved.reasoning, ...options, ...(provider ? { provider } : {}) });
        saveBinding(this.deps.db, threadId, { sessionId: accepted.session_id, error: null });
        saved = binding(this.deps.db, threadId)!;
        if (copy) copyProject(this.deps, client, copy, () => void this.ensureBranch(threadId, true));
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
                await inferThreadMetadata(this.deps as LoggedWorkSessionDeps, {
                  input: input.input as PromptInput[],
                  provisioningId: saved.startRequestId,
                  threadId,
                  writeTranscript: false,
                });
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
              ? await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)?.projectId ?? "")
              : [];
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions);
            let context = parsed.workspaceContext;
            if (context === undefined) {
              const copying = pending.id === `first_${threadId}` && ["cloning", "uploading"].includes(projectCopyProgress(this.deps.db, threadId)?.phase ?? "");
              const hint = copying ? "[Cloud workspace context]\nThis project is new on the VM. Cloudroom is copying its files into this folder right now: a GitHub clone or an upload from the user's Mac, plus uncommitted edits and .env files. If files or instructions such as AGENTS.md are missing, wait briefly and check again instead of recreating them." : null;
              context = hint && Buffer.byteLength(`${enriched.text}\n\n${hint}`, "utf8") <= 32768 ? hint : null;
              this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(pending.input), workspaceContext: context }) }).where(eq(cloudroomCommands.id, pending.id)).run();
            }
            const text = context ? `${enriched.text}\n\n${context}` : enriched.text;
            const content = context && Array.isArray(enriched.content) ? [...enriched.content, { type: "text", text: `\n${context}` }] : enriched.content;
            accepted = await client.prompt(sessionId, pending.id, text, parsed.reasoning, {
              ...(capabilities.structured_prompt && content !== undefined ? { content: content as never } : {}),
              ...(attachments.length ? { attachments: attachments as never } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            });
          } else if (pending.command === "edit") {
            const parsed = z.object({
              target_request_id: z.string(), expected_revision: z.number(), text: z.string(),
              reasoning: z.string().optional(), content: z.unknown().optional(),
              attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), service_tier: z.string().optional(),
              customInstructions: z.string().default(""),
            }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions);
            const attachments = await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)!.projectId);
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
          } else if (pending.command === "rewind") {
            const parsed = z.object({ before: z.string(), last_turn_id: z.string().optional(), customInstructions: z.string().default(""), replacement: z.object({ request_id: z.string(), text: z.string(), content: z.unknown().optional(), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), reasoning: z.string().optional(), service_tier: z.string().optional() }) }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.replacement.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.replacement.text, content: cloudTextContent(parsed.replacement.content) }, parsed.customInstructions);
            const attachments = await this.uploadAttachments(client, sessionId, parsed.replacement.request_id, parsed.replacement.attachments ?? [], getThread(this.deps.db, threadId)!.projectId);
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
    }
  }

  private async followChild(parent: Binding, client: CloudroomClient, childId: string): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread || parentThread.providerId !== "claude-code") return;
    const existing = this.deps.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
    if (existing) { this.follow(existing, client); return; }
    const session = await client.session(childId);
    const start = Object.values(session.receipts).find(receipt => receipt.command === "start");
    const input = z.object({ parent_session: z.literal(parent.sessionId!), reasoning: z.string().nullable().optional() }).parse(start?.input);
    if (session.harness !== "claude-code" || !start) throw new CloudroomError("Invalid Cloudroom child session");
    const child = this.deps.db.transaction(tx => {
      const saved = tx.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
      if (saved) return saved;
      const thread = createThread(tx, this.deps.hub, { executionTarget: "cloud", projectId: parentThread.projectId, providerId: "claude-code", parentThreadId: parent.threadId, title: "Claude child", status: "pending" });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: parent.coreUrl, sessionId: childId, startRequestId: start.request_id, model: start.model ?? parent.model, reasoning: input.reasoning ?? parent.reasoning }).run();
      for (const receipt of Object.values(session.receipts).filter(receipt => receipt.command === "prompt")) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId: thread.id, command: "prompt", input: JSON.stringify(receipt.input), state: "accepted", createdAt: Date.now() }).run();
      }
      return binding(tx, thread.id)!;
    });
    this.follow(child, client);
    this.notify(child.threadId);
  }

  private follow(saved: Binding, client: CloudroomClient): void {
    if (this.streams.has(saved.threadId) || !saved.sessionId || this.stopped) return;
    const controller = new AbortController();
    this.streams.set(saved.threadId, controller);
    void (async () => {
      let projecting = false;
      try {
        for await (const record of client.stream(saved.sessionId!, {
          after: saved.cursor, signal: controller.signal,
          onConnected: async () => {
            if (controller.signal.aborted) return;
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
          if (record.kind === "child" && record.data && typeof record.data === "object" && "id" in record.data && typeof record.data.id === "string") {
            await this.followChild(saved, client, record.data.id);
            if (controller.signal.aborted) return;
          }
          const outage = mentionsOpenAISide401(record) && await codexOutage();
          if (controller.signal.aborted) return;
          projecting = true;
          // The stream replays from the saved cursor, so renames made while the app was offline apply on reconnect.
          if (record.kind === "title") updateThread(this.deps.db, this.deps.hub, saved.threadId, { title: z.object({ title: z.string().min(1) }).parse(record.data).title });
          const eventTypes = projectRecord(this.deps.db, saved.threadId, record, outage);
          projecting = false;
          // Agents archive their own thread with `cloudroom thread archive --self`; like renames, this applies on reconnect.
          if (record.kind === "archive") this.archiveRequest?.(saved.threadId);
          if (record.kind === "secret_request") this.secrets.follow(client, saved.threadId, record);
          this.setConnectionIssue(saved.threadId, "replay");
          if (record.kind === "rewind") this.deps.hub.notifyThread(saved.threadId, ["history-rewritten"]);
          this.notify(saved.threadId, eventTypes, ["state", "receipt", "native_identity"].includes(record.kind));
        }
        if (!controller.signal.aborted) this.setConnectionIssue(saved.threadId, "stream", new CloudroomConnectionError("Cloudroom event stream ended"));
      } catch (error) {
        const sandbox = sandboxThread(saved.coreUrl);
        if (sandbox) this.sandboxes.forget(sandbox);
        if (!controller.signal.aborted) {
          const phase = !projecting && (connectionFailure(error) || (error instanceof CloudroomError && error.status !== null)) ? "stream" : "replay";
          this.setConnectionIssue(saved.threadId, phase, error);
        }
      } finally { if (this.streams.get(saved.threadId) === controller) this.streams.delete(saved.threadId); }
    })();
  }

  private setConnectionIssue(threadId: string, phase: ConnectionPhase, error?: unknown): void {
    const issues = this.connectionIssues.get(threadId) ?? {};
    const previous = issues[phase];
    const issue = error === undefined ? undefined : {
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
