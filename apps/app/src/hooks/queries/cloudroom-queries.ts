import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { reasoningLevelSchema, serviceTierSchema, type Thread } from "@bb/domain";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { appToast } from "@/components/ui/app-toast";
import { getMutationErrorMessage, showMutationErrorToast } from "@/lib/mutation-errors";

export const cloudroomStatusSchema = z.object({
  ready: z.boolean(),
  storage: z.object({
    enabled: z.boolean(), level: z.enum(["normal", "low_space", "blocked"]),
    reason: z.enum(["disk_capacity", "measurement_unavailable", "unprotected_test_mode"]),
    workspace_available_bytes: z.number().nullable(), history_available_bytes: z.number().nullable(),
    workspace_total_bytes: z.number().nullable(), history_total_bytes: z.number().nullable(), sampled_at: z.number().nullable(),
  }).nullable().optional(),
  projectId: z.string().nullable(),
  repository: z.string().nullable(),
  model: z.string().nullable(),
  workspaces: z.boolean().default(false),
  teleport: z.boolean().default(false),
  error: z.string().nullable(),
  steer: z.boolean().default(false),
  rewind: z.boolean().default(false),
  attachments: z.boolean().default(false),
  compact: z.boolean().default(false),
  queue_edit: z.boolean().default(false),
  queue_cancel: z.boolean().default(false),
  queue_reorder: z.boolean().default(false),
  harnesses: z.array(z.object({
    id: z.string(),
    provider: z.string().nullable().optional(),
    reasoning_levels: z.array(z.string()),
    models: z.array(z.object({ model: z.string(), reasoning_levels: z.array(z.string()) })).nullable().optional(),
    service_tier: z.boolean().default(false),
    steer: z.boolean().optional(),
    compact: z.boolean().optional(),
    rewind: z.boolean().optional(),
  })).nullable().default([]),
});

const CORE_HARNESS_IDS: Record<string, string> = { "acp-cursor": "cursor", "acp-fx": "fx" };

export function cloudHarness(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined) {
  const id = harness === undefined ? undefined : (CORE_HARNESS_IDS[harness] ?? harness);
  return status?.harnesses?.find((item) => item.id === id);
}

/** Whether Cloud has told us what it offers. Unknown (a new account before its first sandbox) must not block sends. */
export function cloudCatalogKnown(status: z.infer<typeof cloudroomStatusSchema> | undefined): boolean {
  return status?.ready === true && status.harnesses !== null;
}

const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", cursor: "Cursor", fx: "fx" };
export function cloudHarnessNames(status: z.infer<typeof cloudroomStatusSchema> | undefined): string {
  return (status?.harnesses ?? []).map((item) => HARNESS_NAMES[item.id] ?? item.id).join(", ") || "none";
}

export function cloudServiceTierSupported(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined): boolean {
  return cloudHarness(status, harness)?.service_tier === true;
}

export function cloudReasoningLevels(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined, model: string | undefined): string[] {
  const profile = cloudHarness(status, harness);
  if (profile?.models === null) return [];
  const remoteModel = harness === "pi" && model ? model.slice(model.indexOf("/") + 1) : model;
  if (!profile?.models) return profile?.reasoning_levels ?? [];
  const levels = profile.models.find((item) => item.model === remoteModel)?.reasoning_levels;
  // Claude runs exact models its catalog omits, such as claude-opus-5-5[1m]; core allows any VM level (ADR 0133).
  return levels ?? (harness === "claude-code" && remoteModel ? [...new Set(profile.models.flatMap((item) => item.reasoning_levels))] : []);
}
export function cloudFeatureSupported(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string, feature: "steer" | "compact" | "rewind"): boolean {
  const profile = cloudHarness(status, harness);
  return status?.[feature] === true && profile?.[feature] !== false;
}
const threadStatusSchema = z.object({ authRequired: z.boolean().default(false), starting: z.boolean().default(false), sessionId: z.string().nullable(), paused: z.boolean(), failedStart: z.boolean().default(false), model: z.string(), reasoning: reasoningLevelSchema, serviceTier: serviceTierSchema.default("default"), error: z.string().nullable(), reconnecting: z.boolean().default(false), usageLimit: z.boolean().default(false), pendingDelivery: z.number() }).nullable();

export function useCloudroomAccount() {
  return useQuery({ queryKey: ["cloudroom-account"], queryFn: async ({ signal }) => {
    const status = await sdk.cloudroom.status(signal);
    if (status.account && typeof document !== "undefined" && document.visibilityState === "visible") {
      void fetchWithAppSurface("/api/v1/cloudroom/account/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    }
    return status;
  }, refetchInterval: (query) => query.state.data?.signingIn ? 500 : 10000 });
}

/** Starts browser sign-in, or cancels the one in progress. GitHub and Google skip the website's login page. */
export function useCloudroomSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: "github" | "google" | "email" | "cancel") => {
      if (action === "cancel") await sdk.cloudroom.cancel();
      else openUrlInExternalBrowser((await sdk.cloudroom.signIn(action === "email" ? {} : { provider: action })).url);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["cloudroom-account"] }),
    onError: (error) => appToast.error(error.message),
  });
}

export function useCloudroomConnection() {
  return useQuery({ queryKey: ["cloudroom-connection"], queryFn: async ({ signal }) => cloudroomStatusSchema.parse(await (await fetchWithAppSurface("/api/v1/cloudroom", { signal })).json()), refetchInterval: 10000 });
}

const desktopUpdateSchema = z.object({ version: z.string(), installAt: z.number().nullable(), installing: z.boolean() }).nullable();

export function useDesktopUpdate() {
  return useQuery({
    queryKey: ["cloudroom-desktop-update"],
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const update = desktopUpdateSchema.parse(await (await fetchWithAppSurface("/api/v1/cloudroom/desktop-update", { signal })).json());
      return update && { ...update, minutes: update.installAt === null ? null : Math.max(1, Math.ceil((update.installAt - Date.now()) / 60_000)) };
    },
  });
}

export function useInstallDesktopUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/desktop-update/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Could not restart to update.");
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["cloudroom-desktop-update"] }),
    onError: (error) => appToast.error(error.message),
  });
}

export function useCloudroomThread(threadId: string, enabled: boolean) {
  return useQuery({ queryKey: ["cloudroom-thread", threadId], enabled, queryFn: async ({ signal }) => threadStatusSchema.parse(await (await fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}`, { signal })).json()), refetchInterval: 1500 });
}

const cloudWorkspaceSchema = z.object({ path: z.string(), branch: z.string().nullable(), head: z.string().nullable() }).nullable();

export function useCloudroomThreadWorkspace(threadId: string, enabled: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["cloudroom-thread-workspace", threadId],
    enabled,
    retry: false,
    refetchInterval: 10000,
    queryFn: async ({ queryKey, signal }) => {
      const workspace = cloudWorkspaceSchema.parse(await sdk.cloudroom.threadWorkspace(threadId, signal));
      // An asleep sandbox answers null, and its checkout cannot change while asleep, so keep the last one.
      return workspace ?? client.getQueryData<z.infer<typeof cloudWorkspaceSchema>>(queryKey) ?? null;
    },
  });
}

export function useTeleportThread(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["cloudroom", "teleport", threadId],
    mutationFn: (input: "start" | "cancel" | { model: string; reasoning: string }) =>
      typeof input === "string" ? sdk.cloudroom.teleport(threadId, input) : sdk.cloudroom.teleport(threadId, "start", input),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useTeleportLocal(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["cloudroom", "teleport-local", threadId],
    mutationFn: () => sdk.cloudroom.teleportLocal(threadId),
    onSuccess: ({ conflicts }) => appToast.success(conflicts ? `Moved to this computer. ${conflicts} files could not be merged safely; the cloud versions are in .cloudroom/teleport/.` : "Moved to this computer."),
    onError: (error) => showMutationErrorToast({ error, fallbackMessage: "Could not teleport to Local" }),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useTeleportDirection(thread: Pick<Thread, "id" | "teleport">): "cloud" | "local" | null {
  const toCloud = useIsMutating({ mutationKey: ["cloudroom", "teleport", thread.id], predicate: (mutation) => mutation.state.variables !== "cancel" }) > 0;
  const toLocal = useIsMutating({ mutationKey: ["cloudroom", "teleport-local", thread.id] }) > 0;
  if (toLocal) return "local";
  if (toCloud || (thread.teleport && !["complete", "cancelled", "error"].includes(thread.teleport.phase))) return "cloud";
  return null;
}

export function useCopyToMac(threadId: string) {
  return useMutation({
    mutationFn: () => sdk.cloudroom.copyToMac(threadId),
    onSuccess: ({ branch }) => appToast.success(`Copied to this computer as branch ${branch}. The cloud agent keeps working.`),
    onError: (error) => showMutationErrorToast({ error, fallbackMessage: "Could not copy to this computer" }),
  });
}

export function useOpenCloudFile(threadId: string) {
  return useMutation({
    mutationFn: (path: string) => sdk.cloudroom.openCloudFile(threadId, path),
    onMutate: () => appToast.loading("Downloading from the cloud"),
    onSuccess: ({ path }, _path, toastId) => appToast.success(`Saved to ${path.replace(/^\/Users\/[^/]+/, "~")}`, { id: toastId }),
    onError: (error, _path, toastId) => appToast.error("Could not open the cloud file", { id: toastId, description: getMutationErrorMessage({ error, fallbackMessage: "The download failed." }) }),
  });
}

/** "Let cloud agents access this computer" (ADR 0113). */
export function useSetMacAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => sdk.cloudroom.setMacAccess(enabled),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-account"] }),
  });
}

/** "Copy my logins and model providers to my VM" (ADR 0130). */
export function useSetCopyLogins() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => sdk.cloudroom.setCopyLogins(enabled),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-account"] }),
  });
}

export function useImportBb() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string) => sdk.cloudroom.importBb(hostId),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useRetryCloudStart(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => sdk.cloudroom.retryStart(threadId),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-thread", threadId] }),
  });
}

export async function cloudroomRequestId(key: string, input: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
  const fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const storageKey = `cloudroom-request:${key}`;
  const previous = localStorage.getItem(storageKey)?.split(":");
  if (previous?.[0] === fingerprint && previous[1]) return previous[1];
  const id = crypto.randomUUID();
  localStorage.setItem(storageKey, `${fingerprint}:${id}`);
  return id;
}

export function clearCloudroomRequestId(key: string): void {
  localStorage.removeItem(`cloudroom-request:${key}`);
}
