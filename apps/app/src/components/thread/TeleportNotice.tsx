import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useTeleportThread } from "@/hooks/queries/cloudroom-queries";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";

export function TeleportNotice({
  thread,
  pendingDelivery,
  paused,
}: {
  thread: Thread;
  pendingDelivery?: number;
  paused?: boolean;
}) {
  const action = useTeleportThread(thread.id);
  const stop = useStopThread();
  const progress = thread.teleport;
  if (!progress || progress.phase === "cancelled") return null;
  const complete = progress.phase === "complete";
  const child = progress.owner !== thread.id;
  const failed =
    progress.phase === "error" || Boolean(action.error || stop.error);
  const label = complete
    ? child
      ? "This task’s context was transferred to the parent."
      : pendingDelivery === 0
        ? "Teleport complete. You can close your laptop."
        : "Teleport complete. Checking cloud delivery…"
    : progress.phase === "cancelling"
      ? "Confirming cancellation… Keep your laptop online."
      : progress.phase === "stopping"
        ? "Teleporting: stopping local work…"
        : progress.cloudStarted
          ? paused
            ? "Cloud work stopped; files are still uploading."
            : "Agent running; still uploading."
          : "Teleporting: sending the conversation…";
  return (
    <PromptStackCard
      ariaLabel="Teleport progress"
      className="space-y-2 p-3 text-xs"
    >
      <div role="status">{label}</div>
      {!complete && progress.total > 0 && (
        <div className="text-muted-foreground">
          {progress.completed} / {progress.total} files uploaded. Keep your
          laptop online.
        </div>
      )}
      {(progress.error || action.error || stop.error) && (
        <div
          role={failed ? "alert" : "status"}
          className={`whitespace-pre-wrap break-words ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {action.error?.message ?? stop.error?.message ?? progress.error}
        </div>
      )}
      {child && (
        <RouteAnchor
          className="underline"
          href={getThreadRoutePath({
            projectId: thread.projectId,
            threadId: progress.owner,
          })}
        >
          Open parent thread
        </RouteAnchor>
      )}
      {!complete && progress.owner === thread.id && (
        <div className="flex gap-2">
          {progress.phase === "error" && (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate("start")}
            >
              Retry transfer
            </Button>
          )}
          {progress.cloudStarted ? (
            <Button
              size="sm"
              variant="outline"
              disabled={stop.isPending}
              onClick={() => stop.mutate(thread.id)}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending || progress.phase === "cancelling"}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </PromptStackCard>
  );
}
