import { useReducer } from "react";
import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useRetryProjectCopy } from "@/hooks/queries/cloudroom-queries";
import { useClipboardCopy } from "@/lib/clipboard";
import { projectFilesFixPrompt } from "@/lib/fix-prompts";

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));
const timeLeft = (seconds: number) => seconds < 60 ? "under a minute left" : `about ${Math.round(seconds / 60)} min left`;

export function ProjectCopyNotice({ thread }: { thread: Thread }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const retry = useRetryProjectCopy(thread.id);
  const progress = thread.projectCopy;
  const fixPrompt = useClipboardCopy({ text: projectFilesFixPrompt(thread.id, progress?.error) });
  const dismissKey = `cloudroom.project-copy.dismissed.${thread.id}`;
  if (!progress || progress.phase === "complete") return null;
  const failed = progress.phase === "error";
  const waiting = progress.phase === "waiting";
  if (failed && window.localStorage.getItem(dismissKey)) return null;
  const [title, detail] = failed
    ? ["Project files didn't copy", "Your agent can still work and pull files itself."]
    : waiting
      ? ["Copy paused", "This thread went to sleep. Copying picks up when it wakes."]
      : ["New project in Cloud", progress.phase === "cloning"
        ? "Cloning from GitHub…"
        : progress.total
          ? `Copying files from your Mac… ${megabytes(progress.completed)} of ${megabytes(progress.total)} MB${progress.secondsLeft === undefined ? "" : ` · ${timeLeft(progress.secondsLeft)}`}`
          : "Preparing files on your Mac…"];
  const percent = progress.total ? Math.max(4, (progress.completed / progress.total) * 100) : 4;
  return (
    <PromptStackCard ariaLabel="Project copy progress" className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4">
      <div role="status" className="flex items-start gap-3 p-3">
        <div className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground", failed && "bg-warning/15 text-warning")}>
          <Icon name={failed ? "AlertTriangle" : waiting ? "FolderSync" : "Spinner"} aria-hidden className={cn("size-4", !failed && !waiting && "animate-spin")} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
          {failed && (
            <div className="mt-2.5 flex gap-2">
              {!thread.teleport && <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>}
              <Button size="sm" variant="outline" onClick={() => void fixPrompt.copy()}>{fixPrompt.copied ? "Copied" : "Copy fix prompt"}</Button>
            </div>
          )}
        </div>
        {failed && (
          <button type="button" aria-label="Dismiss" className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground" onClick={() => { window.localStorage.setItem(dismissKey, "1"); rerender(); }}>
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {!failed && !waiting && (
        <div className="h-0.5 bg-border">
          <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
      )}
    </PromptStackCard>
  );
}
