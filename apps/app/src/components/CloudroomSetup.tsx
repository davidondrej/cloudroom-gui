import { type ReactNode, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Switch } from "@bb/shared-ui/switch";
import { PersistentResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { openCodexConnection } from "./CodexConnectionPanel";

export function CloudroomSetup() {
  const account = useCloudroomAccount();
  const saveMacAccess = useSetMacAccess();
  const saveCopyLogins = useSetCopyLogins();
  const [macAccess, setMacAccess] = useState(true);
  const [copyLogins, setCopyLogins] = useState(true);
  const saving = saveMacAccess.isPending || saveCopyLogins.isPending;
  const titleId = useId();
  const descriptionId = useId();
  const accountId = account.data?.account?.id;
  const ready = account.data?.ready === true;
  // Existing users who already chose Mac access are asked only about copying logins.
  const askMacAccess = account.data?.macAccess === null;
  const askCopyLogins = account.data?.copyLogins === null;
  const open = Boolean(accountId) && (askMacAccess || askCopyLogins);
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: open && ready,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
  });
  const codexConnected = codex.data?.state === "connected";
  const finish = (then?: () => void) =>
    Promise.all([
      askMacAccess && saveMacAccess.mutateAsync(macAccess),
      askCopyLogins && saveCopyLogins.mutateAsync(copyLogins),
    ]).then(() => then?.(), (error: Error) => appToast.error(error.message));
  if (!open) return null;

  return (
    <PersistentResponsiveDrawerShell
      open
      onOpenChange={() => {}}
      closeOnBackdropClick={false}
      labelledBy={titleId}
      describedBy={descriptionId}
      backdropClassName="bg-black/40 backdrop-blur-sm"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl p-0 shadow-2xl [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
      <div className="p-7">
        <h2 id={titleId} className="text-3xl font-semibold tracking-tight">Set up Cloudroom</h2>
        <div className="mt-6 divide-y divide-border/60 rounded-lg border border-border/60 bg-muted/20">
          {askMacAccess && (
            <SetupRow title="Let cloud agents use this computer" description="Far more powerful agents. Turn off anytime." descriptionId={descriptionId}>
              <Switch checked={macAccess} onCheckedChange={setMacAccess} aria-label="Let cloud agents use this computer" />
            </SetupRow>
          )}
          {askCopyLogins && (
            <SetupRow title="Copy my logins to the cloud" description="Agent logins, API keys, and model providers." descriptionId={askMacAccess ? undefined : descriptionId}>
              <Switch checked={copyLogins} onCheckedChange={setCopyLogins} aria-label="Copy my logins to the cloud" />
            </SetupRow>
          )}
          {ready && (
            <SetupRow title={codexConnected ? "Codex" : "Connect Codex"} description={codexConnected ? codex.data?.email : "Use your ChatGPT plan."}>
              {codexConnected ? (
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
                  Connected
                </span>
              ) : (
                <Button variant="outline" size="sm" disabled={saving || codex.isPending} onClick={() => finish(() => openCodexConnection())}>
                  Connect
                </Button>
              )}
            </SetupRow>
          )}
        </div>
        <Button size="lg" className="mt-6 w-full text-base" disabled={saving} onClick={() => finish()}>
          {saving ? "Saving…" : "Start using Cloudroom"}
        </Button>
      </div>
    </PersistentResponsiveDrawerShell>
  );
}

function SetupRow({ title, description, descriptionId, children }: {
  title: string;
  description?: string | null;
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p id={descriptionId} className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
