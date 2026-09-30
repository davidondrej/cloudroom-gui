import type { CreateSdkAreaArgs } from "./common.js";
import type { TeleportProgress } from "@bb/domain";

export interface CloudroomStorage {
  enabled: boolean;
  level: "normal" | "low_space" | "blocked";
  reason: "disk_capacity" | "measurement_unavailable" | "unprotected_test_mode";
  workspace_available_bytes: number | null;
  history_available_bytes: number | null;
  workspace_total_bytes: number | null;
  history_total_bytes: number | null;
  sampled_at: number | null;
}

export interface CloudroomStatus {
  storage?: CloudroomStorage | null;
  ready: boolean;
  account: { id: string; email: string } | null;
  projectId: string | null;
  repository: string | null;
  model: string | null;
  error: string | null;
  sync?: { state: "synced" | "syncing" | "offline" | "conflict"; conflicts: number; issue: string | null } | null;
  previews?: { state: "connected" | "offline"; count: number; message: string | null; issue: string | null } | null;
  /** Cloud agents may run commands on this computer (ADR 0113); null until first-run setup asks. */
  macAccess?: boolean | null;
  /** Copy this computer's logins, API keys, and model providers to the VM (ADR 0130); null until first-run setup asks. */
  copyLogins?: boolean | null;
  /** Agent logins found on this computer. Claude's is checked through its provider plugin. */
  localLogins?: { codex: boolean };
  signingIn: boolean;
  signInError: string | null;
}

export interface CloudroomCodexAuth {
  state: "missing" | "waiting" | "connected" | "limited" | "unavailable" | "error" | "expired";
  email: string | null;
  plan: string | null;
  message: string | null;
  login_id: string | null;
  verification_url: string | null;
  user_code: string | null;
}

/** Every new cloud thread starts with these (synced with the website). Values are never returned; `hint` is the
 *  last 4 characters of long values. */
export interface CloudEnvironment {
  variables: { name: string; hint: string }[];
  setup: string;
}
export type CloudEnvironmentChange =
  | { action: "set"; variables: Record<string, string> }
  | { action: "remove"; name: string }
  | { action: "setup"; setup: string };

export interface ClaudeAccountInput { action?: "login" | "cancel" | "complete" | "setup-token" | "key"; requestId?: string; code?: string; state?: string; apiKey?: string }

export interface CloudroomArea {
  claudeAuth(input?: ClaudeAccountInput, signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cursorApiKey(requestId: string, apiKey: string): Promise<CloudroomCodexAuth>;
  piApiKey(provider: string, apiKey: string): Promise<{ providers: string[] }>;
  codexAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  codexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCodexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  status(signal?: AbortSignal): Promise<CloudroomStatus>;
  signIn(input?: { projectId?: string; websiteUrl?: string }): Promise<{ url: string }>;
  setMacAccess(enabled: boolean): Promise<void>;
  setCopyLogins(enabled: boolean): Promise<void>;
  environment(signal?: AbortSignal): Promise<CloudEnvironment>;
  updateEnvironment(change: CloudEnvironmentChange): Promise<CloudEnvironment>;
  /** Names of API keys and tokens set in this Mac's login shell, never their values. */
  macVariables(signal?: AbortSignal): Promise<{ names: string[] }>;
  /** Copies the named variables from this Mac's login shell into the Cloud environment. */
  importMacVariables(names: string[]): Promise<CloudEnvironment>;
  /** Mac → cloud: runs a shell command as the agent account of the VM, or of `threadId`'s sandbox. Input and output bytes are hex. */
  runOnVm(input: { command: string; stdin?: string; cwd?: string; threadId?: string }): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  threadWorkspace(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadWorkspace | null>;
  retryStart(threadId: string): Promise<void>;
  /** `choice` runs the cloud thread on another model when the cloud cannot offer the local one. */
  teleport(threadId: string, action?: "start" | "cancel", choice?: { model: string; reasoning: string }): Promise<TeleportProgress>;
  teleportStatus(threadId: string, signal?: AbortSignal): Promise<TeleportProgress | null>;
  /** Moves a Cloud thread back to this Mac. `conflicts` counts cloud files saved under `.cloudroom/teleport/` because the local copy also changed. */
  teleportLocal(threadId: string): Promise<{ conflicts: number }>;
  /** Copies a cloud thread's branch into the Mac project without stopping its agent. */
  copyToMac(threadId: string): Promise<{ branch: string }>;
  /** Downloads a file from a cloud thread's machine into ~/Downloads and opens it. */
  openCloudFile(threadId: string, path: string): Promise<{ path: string }>;
  /** Moves a thread from the cloud VM into its own sandbox (moving off the VM). Returns Teleport progress. */
  moveToSandbox(threadId: string): Promise<TeleportProgress>;
  /** Copies open BB threads into idle Local threads by forking their native sessions. Sends no prompts. */
  importBb(hostId: string): Promise<BbImportResult>;
  /** Sends a Local agent's Cloudroom bug report. `sent` is false while bug reports are off in Settings. */
  reportBug(input: { message: string; threadId?: string }): Promise<{ sent: boolean }>;
}

export interface BbImportResult {
  imported: { bbThreadId: string; threadId: string; title: string }[];
  skipped: { bbThreadId: string; title: string; reason: string }[];
}

export interface CloudroomThreadWorkspace {
  path: string;
  branch: string | null;
  head: string | null;
}

export function createCloudroomArea({ transport }: CreateSdkAreaArgs): CloudroomArea {
  const request = (path: string, body?: object, signal?: AbortSignal) => transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/account${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return {
    claudeAuth: (input, signal) => transport.readJson(request(`/claude${input?.action ? `/${input.action}` : ""}`, input?.action ? { requestId: input.requestId, ...(input.action === "complete" ? { code: input.code, state: input.state } : {}), ...(input.action === "key" ? { apiKey: input.apiKey } : {}) } : undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorAuth: (signal) => transport.readJson(request("/cursor", undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorLogin: (requestId) => transport.readJson(request("/cursor/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCursorLogin: (requestId) => transport.readJson(request("/cursor/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    cursorApiKey: (requestId, apiKey) => transport.readJson(request("/cursor/key", { requestId, apiKey })) as Promise<CloudroomCodexAuth>,
    piApiKey: (provider, apiKey) => transport.readJson(request("/pi/key", { provider, apiKey })) as Promise<{ providers: string[] }>,
    codexAuth: (signal) => transport.readJson(request("/codex", undefined, signal)) as Promise<CloudroomCodexAuth>,
    codexLogin: (requestId) => transport.readJson(request("/codex/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCodexLogin: (requestId) => transport.readJson(request("/codex/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    status: (signal) => transport.readJson(request("", undefined, signal)) as Promise<CloudroomStatus>,
    signIn: (input = {}) => transport.readJson(request("/sign-in", input)) as Promise<{ url: string }>,
    cancel: () => transport.readVoid(request("/cancel", {})),
    setMacAccess: (enabled) => transport.readVoid(request("/mac-access", { enabled })),
    setCopyLogins: (enabled) => transport.readVoid(request("/copy-logins", { enabled })),
    environment: (signal) => transport.readJson(request("/environment", undefined, signal)) as Promise<CloudEnvironment>,
    updateEnvironment: (change) => transport.readJson(request("/environment", change)) as Promise<CloudEnvironment>,
    macVariables: (signal) => transport.readJson(request("/environment/mac", undefined, signal)) as Promise<{ names: string[] }>,
    importMacVariables: (names) => transport.readJson(request("/environment/mac", { names })) as Promise<CloudEnvironment>,
    runOnVm: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/vm/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>,
    logout: () => transport.readVoid(request("/logout", {})),
    threadWorkspace: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/workspace`, { signal })) as Promise<CloudroomThreadWorkspace | null>,
    teleport: (threadId, action = "start", choice) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...choice }) })) as Promise<TeleportProgress>,
    teleportStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { signal })) as Promise<TeleportProgress | null>,
    teleportLocal: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "local" }) })) as Promise<{ conflicts: number }>,
    moveToSandbox: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move" }) })) as Promise<TeleportProgress>,
    copyToMac: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "copy" }) })) as Promise<{ branch: string }>,
    openCloudFile: (threadId, path) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/open-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })) as Promise<{ path: string }>,
    importBb: (hostId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/bb`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId }) })) as Promise<BbImportResult>,
    reportBug: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/bug-reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ sent: boolean }>,
    retryStart: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
  };
}
