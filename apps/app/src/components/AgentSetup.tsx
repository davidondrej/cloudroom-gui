import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ClaudeConnectionButton, useClaudeConnection } from "@/components/ClaudeConnection";
import { openCodexConnection } from "@/components/CodexConnectionPanel";
import { buildProviderCliIssue, hasProviderCliAction, useProviderCliInstallRunner } from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useHostProviderCliStatus } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { sdk } from "@/lib/sdk";

type Agent = "claude-code" | "codex";
type Where = "local" | "cloud";
type CellState = "checking" | "connected" | "missing" | "not-installed" | "unavailable";
const AGENTS: { id: Agent; name: string }[] = [{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex" }];
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-center gap-x-3 px-4";

/** Local: installed and signed in on this computer. Cloud: connected for cloud threads. */
export function useAgentConnections() {
  const { localHostId } = useHostDaemon();
  const account = useCloudroomAccount();
  const accountId = account.data?.account?.id;
  const cloudReady = account.data?.ready === true;
  const cli = useHostProviderCliStatus({ hostId: localHostId });
  const claudeLocal = useClaudeConnection({ target: "local", hostId: localHostId });
  const claudeCloud = useClaudeConnection({ target: "cloud" }, Boolean(accountId));
  const codexCloud = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: Boolean(accountId) && cloudReady,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
  });
  const local = (id: Agent, signedIn: boolean | undefined): CellState => {
    if (!cli.data) return "checking";
    if (cli.data[id]?.installed === false) return "not-installed";
    return signedIn === undefined ? "checking" : signedIn ? "connected" : "missing";
  };
  const cloud = (pending: boolean, connected: boolean): CellState =>
    !accountId || !cloudReady ? "unavailable" : pending ? "checking" : connected ? "connected" : "missing";
  const cells: Record<Agent, Record<Where, CellState>> = {
    "claude-code": {
      local: local("claude-code", claudeLocal.isPending ? undefined : claudeLocal.data?.state === "connected"),
      cloud: cloud(claudeCloud.isPending, claudeCloud.data?.state === "connected"),
    },
    codex: {
      local: local("codex", account.data?.localLogins?.codex),
      cloud: cloud(codexCloud.isPending, codexCloud.data?.state === "connected"),
    },
  };
  const anyConnected = Object.values(cells).some((cell) => cell.local === "connected" || cell.cloud === "connected");
  return { cells, anyConnected, localHostId, cli: cli.data };
}

/** Claude Code and Codex, each with its own Local and Cloud status and the one action that fixes it. */
export function AgentSetup({ beforeConnect, className }: { beforeConnect?: () => Promise<unknown>; className?: string }) {
  const { cells, localHostId, cli } = useAgentConnections();
  const client = useQueryClient();
  const installs = useProviderCliInstallRunner();
  const connectCodex = useMutation({
    mutationFn: async () => {
      await beforeConnect?.();
      const result = await sdk.cloudroom.codexLogin(crypto.randomUUID());
      if (result.state === "waiting") openCodexConnection();
      else if (result.state !== "connected") throw new Error(result.message ?? "Codex could not connect. Try again.");
    },
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-codex-auth"] }),
  });
  const installing = (id: Agent) =>
    localHostId !== null && (installs.runningJobKey === providerCliJobKey(localHostId, id) || installs.queuedJobKeys.has(providerCliJobKey(localHostId, id)));
  const install = (id: Agent) => {
    const status = cli?.[id];
    const issue = status ? buildProviderCliIssue({ provider: id, status }) : null;
    if (localHostId && issue && hasProviderCliAction(issue)) installs.startInstall({ hostId: localHostId, issue });
  };

  const cell = (id: Agent, where: Where): ReactNode => {
    const state = cells[id][where];
    if (state === "connected") return <Connected />;
    if (state === "checking") return <Muted>Checking…</Muted>;
    if (state === "unavailable") return <Muted>Unavailable</Muted>;
    if (state === "not-installed") {
      if (cli?.[id]?.installAction?.kind !== "install") return <Muted>Not installed</Muted>;
      return <CellButton disabled={installing(id)} onClick={() => install(id)}>{installing(id) ? "Installing…" : "Install"}</CellButton>;
    }
    if (id === "claude-code") return <ClaudeConnectionButton target={where} hostId={where === "local" ? localHostId : undefined} presentation="inline" />;
    if (where === "local")
      return (
        <CellButton title="Copy, then run it in your terminal" onClick={() => void copyToClipboardWithToast("codex login", { successMessage: "Copied. Run it in your terminal." })}>
          <Icon name="Copy" className="!size-3" aria-hidden />
          <span className="font-mono">codex login</span>
        </CellButton>
      );
    return <CellButton disabled={connectCodex.isPending} onClick={() => connectCodex.mutate()}>{connectCodex.isPending ? "Connecting…" : "Connect"}</CellButton>;
  };

  return (
    <div className={cn("rounded-lg border border-border/60 bg-muted/20 text-left", className)}>
      <div className={cn(COLUMNS, "border-b border-border/60 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground")}>
        <span>Agents</span>
        <span className="flex items-center gap-1.5"><Icon name="Laptop" className="size-3.5" aria-hidden />Local</span>
        <span className="flex items-center gap-1.5"><Icon name="Cloud" className="size-3.5" aria-hidden />Cloud</span>
      </div>
      <div className="divide-y divide-border/60">
        {AGENTS.map(({ id, name }) => {
          const AgentIcon = getProviderIconInfo("agent", id).icon;
          return (
            <div key={id} className={cn(COLUMNS, "min-h-12 py-2.5")}>
              <span className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
                <AgentIcon className="size-4 shrink-0" />
                <span className="truncate">{name}</span>
              </span>
              <div aria-label={`${name} · Local`}>{cell(id, "local")}</div>
              <div aria-label={`${name} · Cloud`}>{cell(id, "cloud")}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Connected() {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium">
      <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
      Connected
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function CellButton(props: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" {...props} />;
}
