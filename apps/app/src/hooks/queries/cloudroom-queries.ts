import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { reasoningLevelSchema, serviceTierSchema } from "@bb/domain";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { appToast } from "@/components/ui/app-toast";
import { showMutationErrorToast } from "@/lib/mutation-errors";

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
  })).default([]),
});

const CORE_HARNESS_IDS: Record<string, string> = { "acp-cursor": "cursor", "acp-fx": "fx" };

export function cloudHarness(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined) {
  const id = harness === undefined ? undefined : (CORE_HARNESS_IDS[harness] ?? harness);
  return status?.harnesses.find((item) => item.id === id);
}

export function cloudServiceTierSupported(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined): boolean {
  return cloudHarness(status, harness)?.service_tier === true;
}

export function cloudReasoningLevels(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string | undefined, model: string | undefined): string[] {
  const profile = cloudHarness(status, harness);
  if (profile?.models === null) return [];
  const remoteModel = harness === "pi" && model ? model.slice(model.indexOf("/") + 1) : model;
  return (profile?.models ? profile.models.find((item) => item.model === remoteModel)?.reasoning_levels : profile?.reasoning_levels) ?? [];
}
export function cloudFeatureSupported(status: z.infer<typeof cloudroomStatusSchema> | undefined, harness: string, feature: "steer" | "compact" | "rewind"): boolean {
  const profile = cloudHarness(status, harness);
  return status?.[feature] === true && profile?.[feature] !== false;
}
const threadStatusSchema = z.object({ authRequired: z.boolean().default(false), starting: z.boolean().default(false), sessionId: z.string().nullable(), paused: z.boolean(), failedStart: z.boolean().default(false), model: z.string(), reasoning: reasoningLevelSchema, serviceTier: serviceTierSchema.default("default"), error: z.string().nullable(), reconnecting: z.boolean().default(false), pendingDelivery: z.number() }).nullable();

export function useCloudroomAccount() {
  return useQuery({ queryKey: ["cloudroom-account"], queryFn: ({ signal }) => sdk.cloudroom.status(signal), refetchInterval: (query) => query.state.data?.signingIn ? 1500 : 10000 });
}

export function useCloudroomConnection() {
  return useQuery({ queryKey: ["cloudroom-connection"], queryFn: async ({ signal }) => cloudroomStatusSchema.parse(await (await fetchWithAppSurface("/api/v1/cloudroom", { signal })).json()), refetchInterval: 10000 });
}

export function useCloudroomThread(threadId: string, enabled: boolean) {
  return useQuery({ queryKey: ["cloudroom-thread", threadId], enabled, queryFn: async ({ signal }) => threadStatusSchema.parse(await (await fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}`, { signal })).json()), refetchInterval: 1500 });
}

export function useCloudroomThreadWorkspace(threadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cloudroom-thread-workspace", threadId],
    enabled,
    retry: false,
    refetchInterval: 10000,
    queryFn: async ({ signal }) => {
      return z.object({ path: z.string(), branch: z.string().nullable(), head: z.string().nullable() }).nullable().parse(await sdk.cloudroom.threadWorkspace(threadId, signal));
    },
  });
}

export function useTeleportThread(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: "start" | "cancel" | { model: string; reasoning: string }) =>
      typeof input === "string" ? sdk.cloudroom.teleport(threadId, input) : sdk.cloudroom.teleport(threadId, "start", input),
    onSettled: () => client.invalidateQueries(),
  });
}

export function useTeleportLocal(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => sdk.cloudroom.teleportLocal(threadId),
    onSuccess: ({ conflicts }) => appToast.success(conflicts ? `Moved to this computer. ${conflicts} files could not be merged safely; the cloud versions are in .cloudroom/teleport/.` : "Moved to this computer."),
    onError: (error) => showMutationErrorToast({ error, fallbackMessage: "Could not teleport to Local" }),
    onSettled: () => client.invalidateQueries(),
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
