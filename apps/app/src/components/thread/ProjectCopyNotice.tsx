import { useReducer } from "react";
import type { Thread } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import { BannerActionSlot } from "@/components/promptbox/banner/prompt-banner-actions";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { projectFilesFixPrompt } from "@/lib/fix-prompts";

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));

export function ProjectCopyNotice({ thread }: { thread: Thread }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const progress = thread.projectCopy;
  const dismissKey = `cloudroom.project-copy.dismissed.${thread.id}`;
  if (!progress || progress.phase === "complete") return null;
  const failed = progress.phase === "error";
  if (failed && window.localStorage.getItem(dismissKey)) return null;
  const detail = failed
    ? "The agent can still work and fetch files itself."
    : progress.phase === "cloning"
      ? "Cloning from GitHub…"
      : progress.total
        ? `Copying files from your Mac… ${megabytes(progress.completed)} of ${megabytes(progress.total)} MB`
        : "Preparing files on your Mac…";
  const percent = progress.total
    ? Math.max(4, (progress.completed / progress.total) * 100)
    : 4;
  return (
    <PromptStackCard
      ariaLabel="Project copy progress"
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
            name={failed ? "AlertCircle" : "Spinner"}
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              failed ? "text-destructive" : "animate-spin text-foreground",
            )}
          />
          <span className="shrink-0 text-foreground">
            {failed ? "Project copy failed" : "New project in Cloud"}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {detail}
          </span>
        </div>
        {failed && (
          <BannerActionSlot hideInTiny={false}>
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
          </BannerActionSlot>
        )}
      </div>
      {failed && progress.error && (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words px-3 pb-2 text-xs text-destructive"
        >
          {progress.error}
        </p>
      )}
      {failed && (
        <FixPrompt
          className="mx-3 mb-2"
          prompt={projectFilesFixPrompt(thread.id, progress.error)}
        />
      )}
      {!failed && (
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
