import { useEffect, useMemo, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Checkbox } from "@bb/shared-ui/checkbox";
import { Icon } from "@bb/shared-ui/icon";
import { appToast } from "@/components/ui/app-toast";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useImportSessions, useNativeSessions } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { formatRelativeTime } from "@/lib/relative-time";
import type { sdk } from "@/lib/sdk";

type NativeSession = Awaited<ReturnType<typeof sdk.cloudroom.nativeSessions>>["sessions"][number];

const RECENT_MS = 30 * 86_400_000;
const APPS = [["claude-code", "Claude Code"], ["codex", "Codex"]] as const;
const keyOf = (session: NativeSession) => `${session.harness}:${session.id}`;

function AppLogo({ id }: { id: string }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return <span className="flex shrink-0" style={provider && getProviderIconTintStyle(provider)}><Logo className="size-4" /></span>;
}

export function ImportChats({ onDone }: { onDone?: () => void }) {
  const sessions = useNativeSessions();
  const importSessions = useImportSessions();
  const { localHostId } = useHostDaemon();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const list = sessions.data?.sessions;
  const apps = useMemo(() => APPS.map(([harness, name]) => {
    const byFolder = new Map<string, NativeSession[]>();
    for (const session of list ?? []) if (session.harness === harness) byFolder.set(session.cwd, [...(byFolder.get(session.cwd) ?? []), session]);
    return { harness, name, folders: [...byFolder.entries()] };
  }).filter((app) => app.folders.length), [list]);

  useEffect(() => {
    if (list && selected === null) setSelected(new Set(list.filter((session) => Date.now() - session.updatedAt < RECENT_MS).map(keyOf)));
  }, [list, selected]);

  if (sessions.isPending) return <p className="text-sm text-muted-foreground">Looking for chats on this Mac…</p>;
  if (sessions.error) return <p role="alert" className="text-sm text-destructive">{sessions.error.message}</p>;
  if (!apps.length) return <p className="text-sm text-muted-foreground">No new Claude Code or Codex chats on this Mac.</p>;

  const chosen = (list ?? []).filter((session) => selected?.has(keyOf(session)));
  const toggle = (keys: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    return next;
  });
  const start = () => {
    if (!localHostId) return appToast.error("This Mac is not connected yet. Try again in a moment.");
    importSessions.mutate({ hostId: localHostId, sessions: chosen.map(({ harness, id }) => ({ harness, id })) }, {
      onSuccess: ({ imported, skipped }) => {
        appToast.success(`Imported ${imported.length} chat${imported.length === 1 ? "" : "s"}`);
        if (skipped.length) appToast.error(`${skipped.length} skipped. First reason: ${skipped[0]!.reason}`);
        onDone?.();
      },
      onError: (error) => appToast.error(error.message),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="max-h-[420px] overflow-y-auto rounded-md border">
        {apps.map(({ harness, name, folders }) => {
          const keys = folders.flatMap(([, items]) => items.map(keyOf));
          const count = keys.filter((key) => selected?.has(key)).length;
          return (
            <div key={harness} className="border-b last:border-b-0">
              <label className="sticky top-0 z-10 flex items-center gap-2.5 border-b bg-muted px-3 py-2 text-sm font-semibold">
                <Checkbox
                  checked={count === keys.length ? true : count ? "indeterminate" : false}
                  disabled={importSessions.isPending}
                  onCheckedChange={(checked) => toggle(keys, checked === true)}
                  aria-label={`All ${name} chats`}
                />
                <AppLogo id={harness} />
                <span>{name}</span>
                <span className="ml-auto text-xs font-normal text-muted-foreground">{count} of {keys.length} chats</span>
              </label>
              {folders.map(([folder, items]) => (
                <Folder key={folder} folder={folder} items={items} selected={selected} disabled={importSessions.isPending} toggle={toggle}
                  expanded={open.has(`${harness}:${folder}`)}
                  onExpand={() => setOpen((current) => {
                    const next = new Set(current);
                    const id = `${harness}:${folder}`;
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" disabled={!chosen.length || importSessions.isPending} onClick={start}>
          {importSessions.isPending && <Icon name="Loading" className="animate-spin" aria-hidden />}
          {importSessions.isPending ? `Importing ${chosen.length} chats…` : `Import ${chosen.length} chat${chosen.length === 1 ? "" : "s"}`}
        </Button>
        <span className="text-xs text-muted-foreground">Chats from the last 30 days are picked. Originals stay untouched.</span>
      </div>
    </div>
  );
}

function Folder({ folder, items, selected, disabled, expanded, toggle, onExpand }: {
  folder: string;
  items: NativeSession[];
  selected: Set<string> | null;
  disabled: boolean;
  expanded: boolean;
  toggle: (keys: string[], on: boolean) => void;
  onExpand: () => void;
}) {
  const keys = items.map(keyOf);
  const count = keys.filter((key) => selected?.has(key)).length;
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-2.5 py-2 pr-3 pl-6 text-sm">
        <Checkbox
          checked={count === keys.length ? true : count ? "indeterminate" : false}
          disabled={disabled}
          onCheckedChange={(checked) => toggle(keys, checked === true)}
          aria-label={`All chats in ${folder}`}
        />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onExpand}>
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="max-w-[60%] shrink-0 truncate font-medium">{folder.split("/").filter(Boolean).at(-1) ?? folder}</span>
          <span className="min-w-0 truncate font-mono text-xs text-subtle-foreground">{folder.replace(/^\/Users\/[^/]+/, "~")}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{count}/{keys.length}</span>
        </button>
      </div>
      {expanded && items.map((session) => (
        <label key={keyOf(session)} className="flex items-center gap-2.5 py-1.5 pr-3 pl-12 text-sm hover:bg-accent/40">
          <Checkbox
            checked={selected?.has(keyOf(session)) ?? false}
            disabled={disabled}
            onCheckedChange={(checked) => toggle([keyOf(session)], checked === true)}
            aria-label={session.title}
          />
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          <span className="shrink-0 text-xs text-subtle-foreground">{formatRelativeTime({ timestamp: session.updatedAt, now: Date.now() })}</span>
        </label>
      ))}
    </div>
  );
}

export function ImportChatsSettingsSection() {
  return (
    <SettingsSection
      title="Import chats"
      description="Bring your Claude Code and Codex chats over as Local threads. The agent keeps its full memory, and you see every message."
    >
      <ImportChats />
    </SettingsSection>
  );
}
