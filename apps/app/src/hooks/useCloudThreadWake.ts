import { useCallback, useEffect } from "react";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { isDocumentVisible, useDocumentVisibilityRevision } from "@/lib/document-visibility";

export type CloudWakeReason = "view" | "typing";

const WAKE_INTERVAL_MS = 60_000;
const VIEW_DELAY_MS = 500;
const lastWakeAt = new Map<string, number>();

export function useCloudThreadWake(threadId: string, isCloud: boolean): (reason: CloudWakeReason) => void {
  const wake = useCallback((reason: CloudWakeReason) => {
    if (!isCloud || Date.now() - (lastWakeAt.get(threadId) ?? 0) < WAKE_INTERVAL_MS) return;
    lastWakeAt.set(threadId, Date.now());
    void fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/wake`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
    }).catch(() => {});
  }, [isCloud, threadId]);
  const visibility = useDocumentVisibilityRevision();
  useEffect(() => {
    if (!isCloud || !isDocumentVisible()) return;
    const timer = setTimeout(() => wake("view"), VIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isCloud, visibility, wake]);
  return wake;
}
