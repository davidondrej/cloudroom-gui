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

export interface CloudroomArea {
  cursorAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cursorApiKey(requestId: string, apiKey: string): Promise<CloudroomCodexAuth>;
  codexAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  codexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCodexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  status(signal?: AbortSignal): Promise<CloudroomStatus>;
  signIn(input?: { projectId?: string; websiteUrl?: string }): Promise<{ url: string }>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  threadWorkspace(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadWorkspace | null>;
  retryStart(threadId: string): Promise<void>;
  teleport(threadId: string, action?: "start" | "cancel"): Promise<TeleportProgress>;
  teleportStatus(threadId: string, signal?: AbortSignal): Promise<TeleportProgress | null>;
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
    cursorAuth: (signal) => transport.readJson(request("/cursor", undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorLogin: (requestId) => transport.readJson(request("/cursor/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCursorLogin: (requestId) => transport.readJson(request("/cursor/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    cursorApiKey: (requestId, apiKey) => transport.readJson(request("/cursor/key", { requestId, apiKey })) as Promise<CloudroomCodexAuth>,
    codexAuth: (signal) => transport.readJson(request("/codex", undefined, signal)) as Promise<CloudroomCodexAuth>,
    codexLogin: (requestId) => transport.readJson(request("/codex/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCodexLogin: (requestId) => transport.readJson(request("/codex/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    status: (signal) => transport.readJson(request("", undefined, signal)) as Promise<CloudroomStatus>,
    signIn: (input = {}) => transport.readJson(request("/sign-in", input)) as Promise<{ url: string }>,
    cancel: () => transport.readVoid(request("/cancel", {})),
    logout: () => transport.readVoid(request("/logout", {})),
    threadWorkspace: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/workspace`, { signal })) as Promise<CloudroomThreadWorkspace | null>,
    teleport: (threadId, action = "start") => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) })) as Promise<TeleportProgress>,
    teleportStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { signal })) as Promise<TeleportProgress | null>,
    retryStart: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
  };
}
