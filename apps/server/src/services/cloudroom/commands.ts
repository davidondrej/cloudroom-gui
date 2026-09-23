import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createThread, getAppSettings, getProject, getThread, getThreadExecutionOverride, setThreadExecutionOverride, cloudroomThreads, cloudroomCommands, events, type DbConnection, type DbQueryConnection } from "@bb/db";
import { encodeClientTurnRequestIdNumber, isStandaloneBuiltinCompactCommand, reasoningLevelSchema, threadQueuedMessageSchema, type Thread, type PromptInput, type ThreadEventType, type ThreadChangeKind, type ReasoningLevel } from "@bb/domain";
import type { CreateThreadRequest, SendMessageRequest, SendMessageResponse } from "@bb/server-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError } from "./client.js";
import { projectInitialPrompt, projectRecord, retractStillQueuedPrompts } from "./events.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { binding, bindings, command, commands, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, teleportBlocked, type Binding, type Command } from "./store.js";
import { deriveTitleFallback, shouldGenerateThreadTitle } from "../threads/title-generation.js";
import { inferThreadMetadata } from "../threads/thread-metadata-inference.js";
import { importCodexLogin, setupSync, stopSync, syncStatus } from "./sync.js";
import { setupPreviews, stopPreviews, previewStatus } from "./previews.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import type { EditMessageRequest, EditMessageResponse } from "@bb/server-contract";

const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email() }).strict();
const connectionSchema = z.object({ url: z.string().url(), token: z.string().min(32), gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional(), projectId: z.string().min(1).optional() }).strict();
const websiteSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return value === url.origin && (value === "https://www.cloudroom.dev" || (url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)));
});
const savedConnectionSchema = connectionSchema.extend({
  token: connectionSchema.shape.token.optional(), account: accountSchema.optional(), websiteUrl: websiteSchema.optional(),
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
  teleport: z.boolean().default(false),
  command_guard: z.boolean().default(false),
  codex_auth: z.boolean().default(false),
  cursor_auth: z.boolean().default(false),
  codex_auth_import: z.boolean().default(false),
  sync: z.boolean().default(false),
  previews: z.boolean().default(false),
  structured_prompt: z.boolean().default(false),
  queue_edit: z.boolean().default(false),
  queue_cancel: z.boolean().default(false),
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
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry"> & Partial<LoggedWorkSessionDeps>;
const services = new WeakMap<DbConnection, CloudroomService>();
const workspaceId = (projectId: string) => `bb_${projectId}`;
const workspaceName = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 80) || "project";
function sourceRepository(remote: string | null): string | undefined {
  const repository = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/)?.[1];
  return repository ? `https://github.com/${repository}` : undefined;
}

export function cloudroom(deps: Deps): CloudroomService {
  let service = services.get(deps.db);
  if (!service) { service = new CloudroomService(deps); services.set(deps.db, service); }
  return service;
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

function coreModel(harness: "codex" | "pi" | "acp-cursor" | "claude-code", model: string, capabilities: z.infer<typeof capabilitiesSchema>): { model: string; provider?: string } {
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
  const levels = profile?.models ? profile.models.find((item) => item.model === model)?.reasoning_levels : profile?.reasoning_levels;
  if (profile?.models && !levels) throw new ApiError(400, "invalid_model", "This model is unavailable on Cloud. Refresh the model selection.");
  if (!levels?.includes(reasoning)) throw new ApiError(400, "invalid_reasoning_effort", "This reasoning level is unavailable for the cloud model. Select a supported level.");
}

function validateFollowUpReasoning(harness: string, saved: Binding, reasoning: string, capabilities: Capabilities): void {
  if (reasoning === saved.reasoning) return;
  if (harness === "acp-cursor") throw new ApiError(409, "cloudroom_launch_settings", "Cursor reasoning is fixed for this cloud session. Start a new thread to change it.");
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
  return capabilities.harnesses.find((item) => item.id === (harness === "acp-cursor" ? "cursor" : harness));
}

function commandReasoning(input: string): string | undefined {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : undefined;
  } catch {
    return undefined;
  }
}

function publicError(error: unknown): string {
  return error instanceof CloudroomError || error instanceof ApiError ? error.message : "Cloudroom connection or replay failed";
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
  teleportUrl = "";
  async teleportClient(threadId?: string): Promise<CloudroomClient> {
    const connection = await this.connection();
    const saved = threadId ? binding(this.deps.db, threadId) : null;
    if (saved && saved.coreUrl !== connection.url) throw new ApiError(409, "cloudroom_connection_changed", "Restore this transfer's original cloud connection before continuing.");
    this.teleportUrl = connection.url;
    return new CloudroomClient(connection);
  }
  followTeleport(threadId: string): void { void this.deliver(threadId).catch(() => {}); }
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
  constructor(private readonly deps: Deps) {}

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
    if (!saved?.token) throw new ApiError(503, "cloudroom_not_configured", "Sign in to Cloudroom to connect your existing VM.");
    const { account: _account, websiteUrl: _website, onboarding: _onboarding, ...connection } = saved;
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

  private async client(saved?: Binding): Promise<CloudroomClient> {
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

  configure(raw: unknown, account?: CloudroomAccount, signal?: AbortSignal, websiteUrl?: string): Promise<void> {
    return this.changeConnection(async () => {
      signal?.throwIfAborted();
      const connection = connectionSchema.parse(raw);
      connection.url = new URL(connection.url).href.replace(/\/$/, "");
      if (connection.projectId && !getProject(this.deps.db, connection.projectId)) throw new ApiError(404, "project_not_found", "Project not found");
      const existing = await this.savedConnection();
      const savedBindings = bindings(this.deps.db);
      if (savedBindings.some((saved) => saved.coreUrl !== connection.url) || (savedBindings.length && existing?.account && existing.account.id !== account?.id)) throw new ApiError(409, "cloudroom_connection_in_use", "Existing cloud threads belong to another account or core. Use a separate app profile; history has not been changed.");
      if (savedBindings.length && existing?.projectId && connection.projectId && existing.projectId !== connection.projectId) throw new ApiError(409, "cloudroom_project_in_use", "Existing legacy cloud threads keep their current project binding.");
      const client = new CloudroomClient(connection);
      if (!account) {
        this.lastCapabilities = await this.capabilities(client);
        await client.ready();
      }
      signal?.throwIfAborted();
      this.stop();
      await this.saveConnection({
        ...connection, ...(account ? { account: accountSchema.parse(account) } : {}),
        ...(websiteUrl ? { websiteUrl: websiteSchema.parse(websiteUrl) } : {}),
        ...(account && existing?.account?.id === account.id && existing.url === connection.url ? { onboarding: existing.onboarding } : {}),
      });
      if (signal?.aborted) {
        if (existing) await this.saveConnection(existing); else await rm(this.path, { force: true });
        if (existing?.token) this.start();
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
        const { token: _token, gateToken: _gateToken, ...binding } = saved;
        await this.saveConnection(binding);
      }
      await stopSync(this.deps);
    });
  }

  async selectOnboardingProject(projectId: string): Promise<void> {
    if (!getProject(this.deps.db, projectId)) throw new ApiError(404, "project_not_found", "Project not found");
    if (platform() !== "darwin") return;
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.projectSelected) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async rememberCloudMessage(sessionId: string, requestId: string, epoch: number): Promise<void> {
    if (platform() !== "darwin") return;
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.firstMessage || this.epoch !== epoch) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true, firstMessage: { sessionId, requestId } } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async reportOnboarding(): Promise<void> {
    if (platform() !== "darwin" || this.stopped || this.reportingOnboarding || Date.now() < this.onboardingDue) return;
    this.reportingOnboarding = true;
    this.onboardingDue = Date.now() + 30_000;
    const epoch = this.epoch;
    try {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token) return;
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
    if (!capabilities.previews || platform() !== "darwin" || this.stopped || this.previewSetupEpoch === this.epoch || Date.now() < this.previewRetryAt) return;
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
        error: null,
      };
    } catch (error) { return { ready: false, account, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) }; }
  }

  async cursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const client = await this.client();
    const capabilities = await this.capabilities(client);
    if (!capabilities.cursor_auth) throw new ApiError(409, "cursor_auth_unsupported", "Update the cloud core to connect Cursor from this app.");
    try { return await client.cursorAuth(action, requestId, apiKey); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "cursor_auth_unavailable" : "cursor_auth_unavailable", publicError(error)); }
  }

  async codexAuth(action?: "login" | "cancel", requestId?: string) {
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
    return (await this.client(saved)).sessionWorkspace(saved.sessionId, signal);
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
    return { authRequired: !saved.sessionId && ["Connect your ChatGPT subscription to use Codex in Cloud. Your prompt is saved.", "Connect your Cursor account to use Cursor in Cloud. Your prompt is saved."].includes(saved.error ?? ""), starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)), sessionId: saved.sessionId, paused: saved.queuePaused, failedStart: !saved.sessionId && initial?.state === "failed", model: saved.model, reasoning, serviceTier, error: saved.error ?? issues.find(issue => !issue.reconnecting)?.message ?? null, reconnecting: issues.some(issue => issue.reconnecting), pendingDelivery: commands(this.deps.db, threadId).filter((c) => c.state === "sending").length };
  }

  async create(request: CreateThreadRequest): Promise<Thread> {
    const connection = await this.connection();
    const project = getProject(this.deps.db, request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if ((request.providerId !== "codex" && request.providerId !== "pi" && request.providerId !== "acp-cursor" && request.providerId !== "claude-code") || request.originKind || request.parentThreadId || request.sourceThreadId || request.sendAt || request.pluginSubmission || request.environment.type !== "project-default")
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, Cursor and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
    if (request.permissionMode && request.permissionMode !== "full") throw new ApiError(400, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (request.startedOnBehalfOf || request.sourceSeqEnd !== undefined) throw new ApiError(400, "cloudroom_unsupported", "Cloud continuation and delegated starts are not enabled.");
    let capabilities = this.lastCapabilities;
    try { capabilities = await this.capabilities(await this.client()); this.lastCapabilities = capabilities; }
    catch (error) {
      if (error instanceof ApiError) throw error;
      if (!connectionFailure(error) || (error instanceof CloudroomError && error.code === "storage_blocked")) throw new ApiError(503, "cloudroom_unavailable", publicError(error));
      capabilities = null;
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
    if (capabilities && remoteModel) validateReasoning(request.providerId, remoteModel.model, reasoning, capabilities);
    const workspace = workspaceId(project.id);
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
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: connection.url, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${thread.id}`, threadId: thread.id, command: "prompt",
        input: JSON.stringify({
          ...payload, workspace, workspace_name: workspaceName(project.name), sourceRepository: sourceRepository(project.gitRemoteUrl), provider: remoteModel?.provider,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
        }),
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
    const client = await this.client(saved);
    if (!saved.sessionId && command(this.deps.db, `first_${thread.id}`)?.state === "failed") throw new ApiError(409, "cloudroom_start_failed", "Retry the rejected cloud start before sending more messages. Your original prompt is saved.");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    let capabilities: Capabilities;
    try {
      capabilities = await this.capabilities(client);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
    const profile = harnessProfile(capabilities, thread.providerId);
    if (payload.sendAt || payload.pluginSubmission) throw new ApiError(409, "cloudroom_unsupported", "Cloud follow-ups use the core queue. Scheduling is not enabled.");
    if (isStandaloneBuiltinCompactCommand(payload.input)) {
      await this.compact(thread);
      return { ok: true, delivery: "sent" };
    }
    if ((payload.mode === "steer" || payload.mode === "steer-if-active") && (!feature(capabilities, "steer") || profile?.steer === false)) throw new ApiError(409, "cloudroom_unsupported", "Cloud steering is not enabled. Use --mode queue.");
    if (payload.permissionMode && payload.permissionMode !== "full") throw new ApiError(409, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (payload.model && payload.model !== saved.model) throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
    if (payload.serviceTier === "fast" && !profile?.service_tier) throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (profile?.attachments ?? true));
    const id = payload.requestId ?? randomUUID();
    if ((payload.mode === "steer" || payload.mode === "steer-if-active") && thread.status === "active" && saved.turnId) {
      this.enqueue(thread.id, id, "steer", { target_request_id: saved.turnId, text: parsed.text });
      await this.deliver(thread.id);
      return { ok: true, delivery: "sent" };
    }
    const previous = command(this.deps.db, id);
    const reasoning = payload.reasoningLevel ?? (previous
      ? commandReasoning(previous.input) ?? saved.reasoning
      : getThreadExecutionOverride(this.deps.db, thread.id)?.reasoningLevelOverride ?? saved.reasoning);
    const stored = {
      ...parsed,
      ...(reasoning !== saved.reasoning ? { reasoning } : {}),
      ...(payload.serviceTier && payload.serviceTier !== "default" ? { service_tier: payload.serviceTier } : {}),
    };
    if (previous) {
      if (!sameStoredPrompt(previous, thread.id, stored, reasoning, saved.reasoning)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
    } else {
      validateFollowUpReasoning(thread.providerId, saved, reasoning, capabilities);
      this.enqueue(thread.id, id, "prompt", stored);
    }
    await this.deliver(thread.id);
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
    if (!binding(this.deps.db, threadId)) return;
    this.enqueue(threadId, randomUUID(), "stop", {});
    void this.deliver(threadId).catch(() => {});
  }

  private enqueue(threadId: string, id: string, action: Command["command"], input: object): void {
    const previous = command(this.deps.db, id);
    const serialized = JSON.stringify(input);
    if (previous) {
      if (previous.threadId !== threadId || previous.command !== action || previous.input !== serialized) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      return;
    }
    if (!binding(this.deps.db, threadId)) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    this.deps.db.insert(cloudroomCommands).values({ id, threadId, command: action, input: serialized, createdAt: Date.now() }).run();
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
    if (!saved || !thread || thread.archivedAt || thread.deletedAt || saved.sessionId || command(this.deps.db, `first_${threadId}`)?.state !== "failed") throw new ApiError(409, "cloudroom_retry", "Only a rejected cloud start can be retried here.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    const harness = thread.providerId;
    if (harness !== "codex" && harness !== "pi" && harness !== "acp-cursor" && harness !== "claude-code") throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
    validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, saved.reasoning, capabilities);
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
    if (saved && !saved.sessionId && !backgroundPreparation && saved.error === "Cloudroom rejected the request (HTTP 409)") {
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
    this.timer = setInterval(() => {
      this.teleportRecovery?.();
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
        capabilities.sync ? setupSync(this.deps).then(() => { if (epoch === this.epoch) this.syncIssue = null; }).catch(() => { if (epoch === this.epoch) this.syncIssue = "Skills and settings sync could not start. Cloud sessions are unaffected."; }) : Promise.resolve(),
        this.ensurePreviews(capabilities),
      ]);
    }).catch(() => { if (epoch === this.epoch) this.syncIssue = "Skills and settings sync could not start. Cloud sessions are unaffected."; });
  }

  stop(): void {
    this.epoch++;
    this.previewRetryAt = 0;
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
      const client = await this.client(saved);
      if (epoch !== this.epoch) return;
      if (saved.sessionId) {
        this.follow(saved, client);
        if (!commands(this.deps.db, threadId).some(c => c.state === "sending")) { this.setConnectionIssue(threadId, "delivery"); return; }
      }
      const capabilities = await this.capabilities(client);
      if (epoch !== this.epoch) return;
      this.lastCapabilities = capabilities;
      if (!saved.sessionId) {
        deliveringCommand = true;
        const harness = getThread(this.deps.db, threadId)?.providerId;
        if (harness !== "codex" && harness !== "pi" && harness !== "acp-cursor" && harness !== "claude-code") throw new ApiError(409, "cloudroom_harness", "Unsupported cloud harness; native execution is blocked.");
        const { model, provider } = coreModel(harness, saved.model, capabilities);
        const initial = command(this.deps.db, `first_${threadId}`);
        const options = initial ? z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), provider: z.string().optional(), command_guard_enabled: z.boolean().optional() }).parse(JSON.parse(initial.input)) : {};
        if (options.command_guard_enabled !== false && !capabilities.command_guard) throw new ApiError(503, "cloudroom_update", "Update the cloud core to enable Command Guard. Your message is saved.");
        if (!capabilities.command_guard) delete options.command_guard_enabled;
        if (!capabilities.direct_workspaces) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents without copying files. Your message is saved.");
        if (harness === "codex" && capabilities.codex_auth_import) await importCodexLogin(this.deps);
        if (epoch !== this.epoch) return;
        const accepted = await client.start(saved.startRequestId, harness === "acp-cursor" ? "cursor" : harness, { model, reasoning: saved.reasoning, ...options, ...(provider ? { provider } : {}) });
        saveBinding(this.deps.db, threadId, { sessionId: accepted.session_id, error: null });
        saved = binding(this.deps.db, threadId)!;
      }
      if (epoch !== this.epoch) return;
      const sessionId = saved.sessionId!;
      this.follow(saved, client);
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
            continue;
          }
          let accepted;
          if (pending.command === "prompt") {
            const parsed = z.object({
              text: z.string(),
              sourceRepository: z.string().optional(),
              reasoning: z.string().optional(),
              content: z.unknown().optional(),
              attachments: z.array(z.object({
                name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(),
                path: z.string().optional(), id: z.string().optional(),
              })).optional(),
              service_tier: z.string().optional(),
            }).parse(JSON.parse(pending.input));
            if (parsed.attachments?.length) {
              if (!capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
            }
            const attachments = capabilities.attachments
              ? await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)?.projectId ?? "")
              : [];
            const repository = parsed.sourceRepository ? sourceRepository(parsed.sourceRepository) : undefined;
            const hint = repository ? `[Cloud workspace context]\nSource repository: ${repository}\nThis VM folder may be empty. Project files are not copied from the Mac.` : null;
            const context = hint && Buffer.byteLength(`${parsed.text}\n\n${hint}`, "utf8") <= 32768 ? hint : null;
            const text = context ? `${parsed.text}\n\n${context}` : parsed.text;
            const originalContent = cloudTextContent(parsed.content);
            const content = context && Array.isArray(originalContent) ? [...originalContent, { type: "text", text: context }] : originalContent;
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
            }).parse(JSON.parse(pending.input));
            const attachments = await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)!.projectId);
            accepted = await client.edit(sessionId, pending.id, parsed.target_request_id, parsed.expected_revision, parsed.text, {
              ...(parsed.content === undefined ? {} : { content: cloudTextContent(parsed.content) as never }),
              attachments: attachments as never,
              ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            });
          } else if (pending.command === "cancel") {
            accepted = await client.cancel(sessionId, pending.id, JSON.parse(pending.input).target_request_id);
          } else if (pending.command === "steer") {
            const parsed = z.object({ target_request_id: z.string(), text: z.string() }).parse(JSON.parse(pending.input));
            accepted = await client.steer(sessionId, pending.id, parsed.target_request_id, parsed.text);
          } else if (pending.command === "compact") {
            accepted = await client.compact(sessionId, pending.id);
          } else if (pending.command === "rewind") {
            const parsed = z.object({ before: z.string(), last_turn_id: z.string().optional(), replacement: z.object({ request_id: z.string(), text: z.string(), content: z.unknown().optional(), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), reasoning: z.string().optional(), service_tier: z.string().optional() }) }).parse(JSON.parse(pending.input));
            const attachments = await this.uploadAttachments(client, sessionId, parsed.replacement.request_id, parsed.replacement.attachments ?? [], getThread(this.deps.db, threadId)!.projectId);
            accepted = await client.rewind(sessionId, pending.id, parsed.before, parsed.last_turn_id, { ...parsed.replacement, content: cloudTextContent(parsed.replacement.content) as never, attachments: attachments as never });
          } else if (pending.command === "stop" || pending.command === "resume") {
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
            if (saved.error === "Cloudroom connection or replay failed" && !commands(this.deps.db, saved.threadId).some(item => item.state === "sending")) {
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
          projecting = true;
          const eventTypes = projectRecord(this.deps.db, saved.threadId, record);
          projecting = false;
          this.setConnectionIssue(saved.threadId, "replay");
          if (record.kind === "rewind") this.deps.hub.notifyThread(saved.threadId, ["history-rewritten"]);
          this.notify(saved.threadId, eventTypes, ["state", "receipt", "native_identity"].includes(record.kind));
        }
        if (!controller.signal.aborted) this.setConnectionIssue(saved.threadId, "stream", new CloudroomConnectionError("Cloudroom event stream ended"));
      } catch (error) {
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
      message: phase === "replay" && !(error instanceof CloudroomError) ? "Cloudroom history could not be restored. Check the server logs for details." : publicError(error),
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
