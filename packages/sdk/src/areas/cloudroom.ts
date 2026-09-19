import type { CreateSdkAreaArgs } from "./common.js";

export interface CloudroomStatus {
  ready: boolean;
  account: { id: string; email: string } | null;
  projectId: string | null;
  repository: string | null;
  model: string | null;
  error: string | null;
  sync?: { state: "synced" | "syncing" | "offline" | "conflict"; conflicts: number; issue: string | null } | null;
  signingIn: boolean;
  signInError: string | null;
}

export interface CloudroomArea {
  status(signal?: AbortSignal): Promise<CloudroomStatus>;
  signIn(input?: { projectId?: string; websiteUrl?: string }): Promise<{ url: string }>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  threadWorkspace(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadWorkspace | null>;
  retryStart(threadId: string): Promise<void>;
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
    status: (signal) => transport.readJson(request("", undefined, signal)) as Promise<CloudroomStatus>,
    signIn: (input = {}) => transport.readJson(request("/sign-in", input)) as Promise<{ url: string }>,
    cancel: () => transport.readVoid(request("/cancel", {})),
    logout: () => transport.readVoid(request("/logout", {})),
    threadWorkspace: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/workspace`, { signal })) as Promise<CloudroomThreadWorkspace | null>,
    retryStart: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
  };
}
