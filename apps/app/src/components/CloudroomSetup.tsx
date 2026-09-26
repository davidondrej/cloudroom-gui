import { useId, useState } from "react";
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
      backdropClassName="bg-black/25 backdrop-blur-xs"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl p-8 shadow-2xl [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="space-y-6 text-base">
        <h2 id={titleId} className="text-2xl font-semibold">Set up Cloudroom</h2>
        {askMacAccess && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium">Let cloud agents use this computer</p>
              <p id={descriptionId} className="text-muted-foreground">They get much more powerful. You can turn this off later.</p>
            </div>
            <Switch checked={macAccess} onCheckedChange={setMacAccess} aria-label="Let cloud agents use this computer" />
          </div>
        )}
        {askCopyLogins && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium">Copy my logins to my cloud computer</p>
              <p id={askMacAccess ? undefined : descriptionId} className="text-muted-foreground">Your agent logins, API keys, and custom model providers, so cloud agents work right away.</p>
            </div>
            <Switch checked={copyLogins} onCheckedChange={setCopyLogins} aria-label="Copy my logins to my cloud computer" />
          </div>
        )}
        {ready && (
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium">{codexConnected ? "Codex connected ✓" : "Connect Codex"}</p>
              <p className="text-muted-foreground">{codexConnected ? codex.data?.email : "Use your ChatGPT plan."}</p>
            </div>
            {!codexConnected && (
              <Button variant="outline" disabled={saving || codex.isPending} onClick={() => finish(() => openCodexConnection())}>
                Connect
              </Button>
            )}
          </div>
        )}
        <Button size="lg" className="w-full text-base" disabled={saving} onClick={() => finish()}>
          {saving ? "Saving…" : "Start using Cloudroom"}
        </Button>
      </div>
    </PersistentResponsiveDrawerShell>
  );
}
