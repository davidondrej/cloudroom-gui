import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Switch } from "@bb/shared-ui/switch";
import { SettingsSection } from "@/components/ui/settings-section";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useCloudroomAccount, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { openCodexConnection, openCursorConnection } from "@/components/CodexConnectionPanel";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { cloudUnavailableFixPrompt, syncFixPrompt } from "@/lib/fix-prompts";

export function CloudroomAccountSettings() {
  const queryClient = useQueryClient();
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const status = useCloudroomAccount();
  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] }), queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] })]);
  };
  const action = useMutation({
    mutationFn: async (kind: "sign-in" | "cancel" | "logout") => {
      if (kind === "sign-in") {
        const { url } = await sdk.cloudroom.signIn();
        setSignInUrl(url);
        openUrlInExternalBrowser(url);
      } else {
        await sdk.cloudroom[kind]();
        setSignInUrl(null);
      }
    },
    onSuccess: refresh,
  });
  const macAccess = useSetMacAccess();
  const accountId = status.data?.account?.id;
  const ready = status.data?.ready;
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, accountId, ready]);
  const error = action.error instanceof Error ? action.error.message : status.data?.signInError;
  const sync = status.data?.sync;
  const syncBroken = ready && sync && (sync.issue || sync.state === "offline" || sync.state === "conflict");
  return <SettingsSection title="Cloudroom account" description="Sign in to connect your existing cloud VM. Local execution stays available.">
    <div className="space-y-3 text-sm">
      {status.data?.account && <div className="flex items-center justify-between gap-3 border-b pb-3">
        <span>Let cloud agents access this computer<span className="block text-xs text-muted-foreground">Makes your agents much more powerful. They can run commands and copy files as you.</span></span>
        <Switch checked={macAccess.isPending ? macAccess.variables : status.data.macAccess === true} disabled={macAccess.isPending} onCheckedChange={(enabled) => macAccess.mutate(enabled)} aria-label="Let cloud agents access this computer" />
      </div>}
      {macAccess.error && <p role="alert">{macAccess.error.message}</p>}
      <p>{status.data?.account ? status.data.account.email : "Not signed in to Cloudroom"}</p>
      {status.isError && <p role="alert">Could not reach the local Cloudroom backend.</p>}
      {status.data?.account && <p role="status">{ready ? "Cloud connected" : status.data.error ?? "Cloud is unavailable. Your VM may still be working."}</p>}
      {status.data?.account && !ready && <FixPrompt prompt={cloudUnavailableFixPrompt(status.data.error)} />}
      {status.data?.sync && <p role="status">Automatic sync: {status.data.sync.state === "synced" ? "Up to date" : status.data.sync.state}. {status.data.sync.issue ?? (status.data.sync.conflicts ? `${status.data.sync.conflicts} conflicting files need review.` : "")}</p>}
      {sync && syncBroken && <FixPrompt prompt={syncFixPrompt(sync.state, sync.issue)} />}
      {status.data?.previews && <p role="status">Cloud previews: {status.data.previews.state === "connected" ? "Ready" : "Reconnecting"}. {status.data.previews.issue ?? status.data.previews.message}</p>}
      <p className="text-xs text-muted-foreground">Skills and portable agent settings sync automatically. Cloud provider logins stay on your VM.</p>
      {error && <p role="alert">{error}</p>}
      {status.data?.signingIn ? <>
        <p role="status">Finish signing in and confirm your account in the browser.</p>
        <div className="flex gap-2">{signInUrl && <Button variant="outline" onClick={() => openUrlInExternalBrowser(signInUrl)}>Open browser again</Button>}<Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("cancel")}>Cancel sign-in</Button></div>
      </> : <div className="flex gap-2">{status.data?.account ? <>
        <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("logout")}>Sign out of this app</Button>
        <Button variant="ghost" onClick={() => void refresh()}>Check connection</Button>
      </> : <Button disabled={action.isPending || status.isPending || status.isError} onClick={() => action.mutate("sign-in")}>Sign in to Cloudroom</Button>}</div>}
      {ready && <div className="flex items-center justify-between gap-3 border-t pt-3"><span>Codex</span><Button variant="outline" onClick={() => openCodexConnection()}>Manage connection</Button></div>}
      {ready && <div className="flex items-center justify-between gap-3 border-t pt-3"><span>Cursor</span><Button variant="outline" onClick={() => openCursorConnection()}>Manage connection</Button></div>}
      <p className="text-xs text-muted-foreground">Signing out leaves cloud agents running and preserves local history. To switch accounts, sign out first. Existing cloud threads stay bound to their original account and VM.</p>
    </div>
  </SettingsSection>;
}
