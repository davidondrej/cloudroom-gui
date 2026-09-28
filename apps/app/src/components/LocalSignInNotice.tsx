import { useMutation } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { ClaudeSignIn, useClaudeConnection } from "@/components/ClaudeConnection";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { sdk } from "@/lib/sdk";

const loginCommands: Record<string, string> = {
  codex: "codex login",
  "acp-cursor": "cursor-agent login",
};

export function LocalSignInNotice({
  threadId,
  providerId,
  hostId,
  environmentId,
  authFailed,
}: {
  threadId: string;
  providerId: string;
  hostId?: string | null;
  environmentId?: string | null;
  authFailed: boolean;
}) {
  const claude = providerId === "claude-code";
  const target = { target: "local" as const, hostId, environmentId };
  const auth = useClaudeConnection(target, claude);
  const retry = useMutation({
    mutationFn: () => sdk.threads.retry({ threadId, reason: "Signed in again" }),
  });
  const signedOut = claude && auth.data?.state === "missing";
  if (!authFailed && !signedOut) return null;
  const command = loginCommands[providerId];
  return (
    <PromptStackCard ariaLabel="Sign in" className="w-full max-w-sm justify-self-center p-3 text-xs">
      {claude ? (
        <ClaudeSignIn
          target={target}
          onContinue={authFailed ? () => retry.mutate() : undefined}
          continuing={retry.isPending}
        />
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Sign in to continue</p>
            <p className="text-muted-foreground">
              {command ? <>Run <code>{command}</code> in your terminal, then retry.</> : "Sign in to this provider, then retry."}
            </p>
          </div>
          <Button type="button" size="sm" className="h-7 text-xs" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}
      {retry.error && <p role="alert" className="mt-2 text-destructive">{retry.error.message}</p>}
    </PromptStackCard>
  );
}
