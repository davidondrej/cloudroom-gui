import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SettingsSection } from "@/components/ui/settings-section";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { MAC_ACCESS_LEVELS, useMacAccessLevel } from "@/components/sidebar/MacAccessChip";
import { openCodexConnection, openCursorConnection } from "@/components/CodexConnectionPanel";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { cloudUnavailableFixPrompt, syncFixPrompt } from "@/lib/fix-prompts";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { SelfHostedCoreForm } from "./SelfHostedCoreForm";

const AGENT_LOGINS = [
  { id: "codex", name: "Codex", open: openCodexConnection },
  { id: "acp-cursor", name: "Cursor", open: openCursorConnection },
] as const;

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
  const account = status.data?.account;
  const ready = status.data?.ready;
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, account?.id, ready]);
  const error = action.error instanceof Error ? action.error.message : status.data?.signInError;
  const sync = status.data?.sync;
  const syncBroken = ready && sync && (sync.issue || sync.state === "offline" || sync.state === "conflict");
  const previews = status.data?.previews;
  const signedIn = account && !status.data?.signingIn;
  return <>
    {signedIn ? <section className="space-y-3">
      <h2 className="sr-only">Cloudroom account</h2>
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card bg-gradient-to-br from-primary/[0.07] to-transparent to-55% p-5">
        <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">{account.email.charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">{account.email}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill ok={Boolean(ready)}>{ready ? "Cloud connected" : status.data?.error ?? "Cloud is unavailable. Your VM may still be working."}</StatusPill>
            {previews && <StatusPill ok={previews.state === "connected"} title={previews.issue ?? previews.message ?? undefined}>{previews.state === "connected" ? "Previews ready" : "Previews reconnecting"}</StatusPill>}
            {sync && <StatusPill ok={sync.state === "synced"} title="Skills and portable agent settings sync automatically.">{sync.state === "synced" ? "Synced" : `Sync: ${sync.state}`}</StatusPill>}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="size-9 shrink-0" aria-label="Account actions"><Icon name="MoreHorizontal" aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 p-1.5">
            <DropdownMenuItem disabled={action.isPending} onSelect={() => action.mutate("logout")}>Sign out of this app</DropdownMenuItem>
            <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Cloud agents keep running and local history stays. To switch accounts, sign out first. Existing cloud threads stay on their original account and VM.</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!ready && <FixPrompt prompt={cloudUnavailableFixPrompt(status.data?.error)} />}
      {sync && (sync.issue || sync.conflicts) ? <p role="status" className="text-sm">{sync.issue ?? `${sync.conflicts} conflicting files need review.`}</p> : null}
      {sync && syncBroken && <FixPrompt prompt={syncFixPrompt(sync.state, sync.issue)} />}
      {error && <p role="alert" className="text-sm">{error}</p>}
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
    {signedIn && <SettingsSection plain title="Mac access" description="What cloud agents can do on this Mac."><MacAccessTiles /></SettingsSection>}
    {ready && <SettingsSection plain title="Agent logins" description="Cloud provider logins stay on your VM."><AgentLogins /></SettingsSection>}
  </>;
}

function StatusPill({ ok, title, children }: { ok: boolean; title?: string; children: ReactNode }) {
  return <span role="status" title={title} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-0.5 text-xs text-foreground">
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
    {children}
  </span>;
}

function MacAccessTiles() {
  const { current, select, saving } = useMacAccessLevel();
  return <div role="radiogroup" aria-label="Mac access" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
    {MAC_ACCESS_LEVELS.map((level) => {
      const selected = level === current;
      return <button
        key={level.id}
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={saving}
        onClick={() => select(level)}
        className={cn(
          "flex flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default",
          selected ? "border-success/60 bg-success/[0.06] ring-3 ring-success/5 dark:border-primary/55 dark:bg-primary/[0.08] dark:ring-primary/5" : "border-border bg-card hover:bg-state-hover",
        )}
      >
        <Icon name={level.icon} className={cn("size-[18px]", selected ? "text-success dark:text-primary" : "text-muted-foreground")} aria-hidden />
        <span>
          <span className={cn("block text-sm font-semibold", selected ? "text-success dark:text-primary" : "text-foreground")}>{level.label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{level.description}</span>
        </span>
      </button>;
    })}
  </div>;
}

function AgentLogins() {
  const providers = useSystemProviders().data;
  return <div className="grid gap-2.5 sm:grid-cols-2">
    {AGENT_LOGINS.map(({ id, name, open }) => {
      const provider = providers?.find((entry) => entry.id === id);
      const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
      return <div key={id} className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-foreground" style={provider && getProviderIconTintStyle(provider)}><Logo className="size-[18px]" /></span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        <Button variant="outline" size="sm" aria-label={`Manage ${name} connection`} onClick={() => open()}>Manage</Button>
      </div>;
    })}
  </div>;
}
