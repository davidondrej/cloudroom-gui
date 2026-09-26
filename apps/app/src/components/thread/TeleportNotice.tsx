import { useReducer } from "react";
import type { Thread } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  BannerActionSlot,
  PROMPT_BANNER_ACTION_BUTTON_CLASS,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import { useTeleportThread } from "@/hooks/queries/cloudroom-queries";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { projectFilesFixPrompt } from "@/lib/fix-prompts";
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
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const progress = thread.teleport;
  if (!progress || progress.phase === "cancelled") return null;
  const owner = progress.owner === thread.id;
  const complete = progress.phase === "complete";
  const dismissKey = `cloudroom.teleport.dismissed.${progress.id}`;
  if (complete && window.localStorage.getItem(dismissKey)) return null;
  const failed =
    progress.phase === "error" || Boolean(action.error || stop.error);
  const error = action.error?.message ?? stop.error?.message ?? progress.error;
  const files = `${progress.completed} of ${progress.total} files`;
  const [icon, title, detail] = !owner
    ? ["Cloud", "Moved to Cloud", "The parent thread continues this work."]
    : complete
      ? [
          "CircleCheck",
          "Running in Cloud",
          pendingDelivery === 0
            ? "You can close your laptop."
            : "Checking delivery…",
        ]
      : failed
        ? ["AlertCircle", "Teleport paused", "Local history is safe."]
        : progress.phase === "cancelling"
          ? ["Spinner", "Cancelling", "Keep your laptop online."]
          : progress.phase === "stopping"
            ? ["Spinner", "Teleporting to Cloud", "Stopping local work…"]
            : progress.cloudStarted
              ? [
                  "Spinner",
                  paused ? "Cloud agent stopped" : "Agent working in Cloud",
                  progress.completed < progress.total
                    ? `Uploading ${files}. Keep your laptop online.`
                    : "Finishing handoff…",
                ]
              : [
                  "Spinner",
                  "Teleporting to Cloud",
                  "Sending the conversation…",
                ];
  const showBar = owner && !complete && !failed;
  const percent = progress.total
    ? Math.max(4, (progress.completed / progress.total) * 100)
    : 4;
  return (
    <PromptStackCard
      ariaLabel="Teleport progress"
      className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center gap-0.5 p-0.5 text-xs">
        <div
          role="status"
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            PROMPT_STACK_INLAY_SEGMENT_CLASS,
          )}
        >
          <Icon
            name={icon}
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              icon === "Spinner" && "animate-spin text-foreground",
              icon === "CircleCheck" && "text-primary",
              icon === "AlertCircle" && "text-destructive",
            )}
          />
          <span className="shrink-0 text-foreground">{title}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {detail}
          </span>
        </div>
        <BannerActionSlot hideInTiny={false}>
          {!owner && (
            <RouteAnchor
              className={PROMPT_BANNER_ACTION_BUTTON_CLASS}
              href={getThreadRoutePath({
                projectId: thread.projectId,
                threadId: progress.owner,
              })}
            >
              Open parent
            </RouteAnchor>
          )}
          {owner && failed && (
            <PromptBannerActionButton
              disabled={action.isPending}
              onClick={() => action.mutate("start")}
            >
              Retry
            </PromptBannerActionButton>
          )}
          {owner && !complete && progress.cloudStarted && (
            <PromptBannerActionButton
              disabled={stop.isPending}
              onClick={() => stop.mutate(thread.id)}
            >
              Stop
            </PromptBannerActionButton>
          )}
          {owner && !complete && !progress.cloudStarted && (
            <PromptBannerActionButton
              disabled={action.isPending || progress.phase === "cancelling"}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </PromptBannerActionButton>
          )}
          {complete && (
            <button
              type="button"
              aria-label="Dismiss"
              className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                window.localStorage.setItem(dismissKey, "1");
                rerender();
              }}
            >
              <Icon name="CircleX" className="size-4" aria-hidden />
            </button>
          )}
        </BannerActionSlot>
      </div>
      {error && (
        <p
          role={failed ? "alert" : "status"}
          className={cn(
            "whitespace-pre-wrap break-words px-3 pb-2 text-xs",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error}
        </p>
      )}
      {owner && failed && (
        <FixPrompt
          className="mx-3 mb-2"
          prompt={projectFilesFixPrompt(thread.id, error)}
        />
      )}
      {showBar && (
        <div className="h-0.5 bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </PromptStackCard>
  );
}
