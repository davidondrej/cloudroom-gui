import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Switch } from "@bb/shared-ui/switch";
import { PersistentResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { AgentSetup } from "./AgentSetup";

export function CloudroomSetup() {
  const account = useCloudroomAccount();
  const saveMacAccess = useSetMacAccess();
  const saveCopyLogins = useSetCopyLogins();
  const [macAccess, setMacAccess] = useState(true);
  const [copyLogins, setCopyLogins] = useState(true);
  const [rows, setRows] = useState<{ mac: boolean; logins: boolean } | null>(null);
  const saving = saveMacAccess.isPending || saveCopyLogins.isPending;
  const titleId = useId();
  const descriptionId = useId();
  const accountId = account.data?.account?.id;
  const savedMacAccess = account.data?.macAccess;
  const savedCopyLogins = account.data?.copyLogins;
  // Existing users who already chose Mac access are asked only about copying logins.
  const askMacAccess = savedMacAccess === null;
  const askCopyLogins = savedCopyLogins === null;
  // Connecting an agent saves the choices early, so the screen stays open until the user finishes.
  useEffect(() => {
    if (!accountId) setRows(null);
    else if (askMacAccess || askCopyLogins) setRows((current) => current ?? { mac: askMacAccess, logins: askCopyLogins });
  }, [accountId, askMacAccess, askCopyLogins]);
  const savePending = () =>
    Promise.all([
      askMacAccess && saveMacAccess.mutateAsync(macAccess),
      askCopyLogins && saveCopyLogins.mutateAsync(copyLogins),
    ]);
  const finish = () => savePending().then(() => setRows(null), (error: Error) => appToast.error(error.message));
  if (!rows || !accountId) return null;

  return (
    <PersistentResponsiveDrawerShell
      open
      onOpenChange={() => {}}
      closeOnBackdropClick={false}
      labelledBy={titleId}
      describedBy={descriptionId}
      backdropClassName="bg-black/40 backdrop-blur-sm"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl p-0 shadow-2xl [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
      <div className="p-7">
        <h2 id={titleId} className="text-3xl font-semibold tracking-tight">Set up Cloudroom</h2>
        <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
          Connect the agents you use. Finish anytime, and add more later in Settings.
        </p>
        <div className="mt-6 divide-y divide-border/60 rounded-lg border border-border/60 bg-muted/20">
          {rows.mac && (
            <SetupRow title="Let cloud agents use this computer" description="Far more powerful agents. Turn off anytime.">
              <Switch
                checked={savedMacAccess ?? macAccess}
                onCheckedChange={(value) => (savedMacAccess == null ? setMacAccess(value) : saveMacAccess.mutate(value))}
                aria-label="Let cloud agents use this computer"
              />
            </SetupRow>
          )}
          {rows.logins && (
            <SetupRow title="Copy my logins to the cloud" description="Agent logins, API keys, and model providers.">
              <Switch
                checked={savedCopyLogins ?? copyLogins}
                onCheckedChange={(value) => (savedCopyLogins == null ? setCopyLogins(value) : saveCopyLogins.mutate(value))}
                aria-label="Copy my logins to the cloud"
              />
            </SetupRow>
          )}
        </div>
        <AgentSetup className="mt-4" beforeConnect={savePending} />
        <Button size="lg" className="mt-6 w-full text-base" disabled={saving} onClick={() => void finish()}>
          {saving ? "Saving…" : "Start using Cloudroom"}
        </Button>
      </div>
    </PersistentResponsiveDrawerShell>
  );
}

function SetupRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
