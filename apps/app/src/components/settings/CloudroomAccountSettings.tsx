import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS, SettingsSection } from "@/components/ui/settings-section";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { MacAccessMenuItems, useMacAccessLevel } from "@/components/sidebar/MacAccessChip";
import { openCodexConnection, openCursorConnection } from "@/components/CodexConnectionPanel";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { cloudUnavailableFixPrompt, syncFixPrompt } from "@/lib/fix-prompts";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { SelfHostedCoreForm } from "./SelfHostedCoreForm";

const AGENT_LOGINS = [
  { id: "codex", name: "Codex", open: openCodexConnection },
  { id: "acp-cursor", name: "Cursor", open: openCursorConnection },
] as const;

function useRefreshCloudroom() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] }), queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] })]);
  };
}

export function CloudroomAccountSettings() {
  const queryClient = useQueryClient();
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const status = useCloudroomAccount();
  const refresh = useRefreshCloudroom();
  const action = useMutation({
    mutationFn: async (kind: "sign-in" | "cancel") => {
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
  const account = status.data?.account;
  const ready = status.data?.ready;
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, account?.id, ready]);
  const error = action.error instanceof Error ? action.error.message : status.data?.signInError;
  const sync = status.data?.sync;
  const syncBroken = ready && sync && (sync.issue || sync.state === "offline" || sync.state === "conflict");
  const previews = status.data?.previews;
  const signedIn = account && !status.data?.signingIn;
  return <>
    {signedIn ? <section className="flex flex-col items-center gap-3 text-center">
      <h2 className="sr-only">Cloudroom account</h2>
      <span aria-hidden className="grid size-14 place-items-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">{account.email.charAt(0).toUpperCase()}</span>
      <div className="min-w-0 max-w-full">
        <p className="truncate text-base font-semibold text-foreground">{account.email}</p>
        <div className="mt-1.5 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <StatusPill ok={Boolean(ready)}>{ready ? "Cloud connected" : status.data?.error ?? "Cloud is unavailable. Your VM may still be working."}</StatusPill>
          {previews && <StatusPill ok={previews.state === "connected"} title={previews.issue ?? previews.message ?? undefined}>{previews.state === "connected" ? "Previews ready" : "Previews reconnecting"}</StatusPill>}
          {sync && <StatusPill ok={sync.state === "synced"} title="Skills and portable agent settings sync automatically.">{sync.state === "synced" ? "Synced" : `Sync: ${sync.state}`}</StatusPill>}
        </div>
      </div>
      <div className="w-full space-y-3 text-left empty:hidden">
        {!ready && <FixPrompt prompt={cloudUnavailableFixPrompt(status.data?.error)} />}
        {sync && (sync.issue || sync.conflicts) ? <p role="status" className="text-sm">{sync.issue ?? `${sync.conflicts} conflicting files need review.`}</p> : null}
        {sync && syncBroken && <FixPrompt prompt={syncFixPrompt(sync.state, sync.issue)} />}
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
    </section> : <SettingsSection title="Cloudroom account" description="Sign in to connect your existing cloud VM. Local execution stays available.">
      <div className="space-y-3 text-sm">
        <p>{account ? account.email : "Not signed in to Cloudroom"}</p>
        {status.isError && <p role="alert">Could not reach the local Cloudroom backend.</p>}
        {error && <p role="alert">{error}</p>}
        {status.data?.signingIn ? <>
          <p role="status">Finish signing in and confirm your account in the browser.</p>
          <div className="flex gap-2">{signInUrl && <Button variant="outline" onClick={() => openUrlInExternalBrowser(signInUrl)}>Open browser again</Button>}<Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("cancel")}>Cancel sign-in</Button></div>
        </> : !status.data?.selfHosted && <div className="flex gap-2"><Button disabled={action.isPending || status.isPending || status.isError} onClick={() => action.mutate("sign-in")}>Sign in to Cloudroom</Button></div>}
        {status.data && !account && !status.data.signingIn && <SelfHostedCoreForm connected={status.data.selfHosted === true} ready={status.data.ready} error={status.data.error} />}
      </div>
    </SettingsSection>}
    {signedIn && <BillingRow />}
    {signedIn && <MacAccessRow />}
    {ready && <SettingsSection plain title="Agent logins" description="Cloud provider logins stay on your VM."><AgentLogins /></SettingsSection>}
  </>;
}

function StatusPill({ ok, title, children }: { ok: boolean; title?: string; children: ReactNode }) {
  return <span role="status" title={title} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
    {children}
  </span>;
}

// Plan, usage, and invoices live on the website (web/app/billing).
function BillingRow() {
  return <div className={SETTINGS_CARD_CLASS}>
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">Plan & billing</p>
        <p className="text-xs text-subtle-foreground/75">Your plan, usage, and invoices.</p>
      </div>
      <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label="Open plan and billing" onClick={() => openUrlInExternalBrowser("https://www.cloudroom.dev/billing")}>Open<Icon name="ExternalLink" aria-hidden /></Button>
    </div>
  </div>;
}

function MacAccessRow() {
  const { current, select, saving } = useMacAccessLevel();
  return <div className={SETTINGS_CARD_CLASS}>
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">Mac access</p>
        <p className="text-xs text-subtle-foreground/75">{current.description}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={`Mac access: ${current.label}`} disabled={saving}>{current.label}<Icon name="ChevronDown" className="text-muted-foreground" aria-hidden /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle="Mac access" className="w-72 p-1.5"><MacAccessMenuItems current={current} select={select} /></DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>;
}

function AgentLogins() {
  const providers = useSystemProviders().data;
  return <div className={SETTINGS_CARD_CLASS}>
    {AGENT_LOGINS.map(({ id, name, open }) => {
      const provider = providers?.find((entry) => entry.id === id);
      const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
      return <div key={id} className={SETTINGS_CARD_ROW_CLASS}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-foreground" style={provider && getProviderIconTintStyle(provider)}><Logo className="size-4" /></span>
        <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={`Manage ${name} connection`} onClick={() => open()}>Manage<Icon name="ChevronRight" aria-hidden /></Button>
      </div>;
    })}
  </div>;
}

// Bottom of the Machines page. The menu step keeps sign-out from being a single stray click.
export function CloudroomSignOut() {
  const status = useCloudroomAccount();
  const refresh = useRefreshCloudroom();
  const logout = useMutation({ mutationFn: () => sdk.cloudroom.logout(), onSuccess: refresh });
  if (!status.data?.account || status.data.signingIn) return null;
  return <div className="flex flex-col items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Sign out</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-72 p-1.5">
        <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>Sign out of this app</DropdownMenuItem>
        <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Cloud agents keep running and local history stays. To switch accounts, sign out first. Existing cloud threads stay on their original account and VM.</p>
      </DropdownMenuContent>
    </DropdownMenu>
    {logout.error instanceof Error && <p role="alert" className="text-sm">{logout.error.message}</p>}
  </div>;
}
