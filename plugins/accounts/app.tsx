import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  ACCOUNTS_CHANGED,
  LOCAL,
  MAX_ACCOUNTS,
  type AccountView,
  type Provider,
  type UsageWindow,
  type accountsRpcContract,
} from "./src/contract.js";

type Rpc = ReturnType<typeof useRpc<typeof accountsRpcContract>>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function until(timestamp: number): string {
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function usageText(windows: UsageWindow[]): string {
  if (windows.length === 0) return "No usage data";
  return windows
    .slice(0, 2)
    .map((window) => {
      const label = window.label
        .replace("Five-hour limit", "5h")
        .replace("Weekly limit", "7d")
        .replace("Weekly", "7d");
      return `${label} ${Math.round(window.usedPercent)}%`;
    })
    .join(" · ");
}

function AccountRow({
  account,
  index,
  onUse,
  onRename,
  onRemove,
}: {
  account: AccountView;
  index: number;
  onUse: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const local = account.id === LOCAL;
  const fallback = account.email ?? (local ? "This Mac" : `Account ${index + 1}`);
  const name = account.name ?? fallback;
  const detail = [
    local && account.email ? "This Mac" : null,
    account.name ? account.email : null,
    account.plan,
  ]
    .filter(Boolean)
    .join(" · ");
  const status = account.limitedUntil
    ? `Limit hit · resets in ${until(account.limitedUntil)}`
    : account.error;
  return (
    <div className="flex items-center gap-3 py-2.5 text-sm">
      <button
        type="button"
        aria-label={account.inUse ? "In use" : "Use this account"}
        title={account.inUse ? "In use" : "Use this account"}
        disabled={account.inUse}
        onClick={onUse}
        style={{ borderWidth: account.inUse ? 5 : 1.5 }}
        className={cn(
          "size-4 shrink-0 rounded-full",
          account.inUse
            ? "border-primary"
            : "border-muted-foreground/60 hover:border-primary",
        )}
      />
      <div className="min-w-0 flex-1 truncate">
        {editing ? (
          <input
            autoFocus
            aria-label="Account name"
            defaultValue={account.name ?? ""}
            placeholder={fallback}
            maxLength={60}
            className="w-full max-w-64 rounded border border-border bg-transparent px-1.5 py-0.5 text-sm text-foreground outline-none focus:border-primary"
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.value = account.name ?? "";
              if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              setEditing(false);
              if (event.currentTarget.value.trim() !== (account.name ?? ""))
                onRename(event.currentTarget.value);
            }}
          />
        ) : (
          <>
            <span className="text-foreground">{name}</span>
            {detail ? (
              <span className="text-subtle-foreground"> · {detail}</span>
            ) : null}
          </>
        )}
      </div>
      {status ? (
        <span
          className="max-w-[45%] truncate text-xs text-warning-text"
          title={status}
        >
          {status}
        </span>
      ) : local && account.windows.length === 0 ? null : (
        <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
          {usageText(account.windows)}
        </span>
      )}
      {local ? (
        <span className="size-7 shrink-0" />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Rename account"
          onClick={() => setEditing(true)}
        >
          <Icon name="Edit" />
        </Button>
      )}
      {local ? (
        <span className="size-7 shrink-0" />
      ) : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Account actions"
            >
              <Icon name="MoreHorizontal" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={onRemove}
              className="text-destructive-text focus:text-destructive-text"
            >
              <Icon name="Trash2" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function SignInRow({
  provider,
  rpc,
  close,
}: {
  provider: Provider;
  rpc: Rpc;
  close: () => void;
}) {
  const navigate = useBbNavigate();
  const [step, setStep] = useState<{
    sessionId: string;
    url: string;
    userCode: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const start =
      provider === "claude-code"
        ? rpc.call("claude.start", null).then((started) => ({
            sessionId: started.sessionId,
            url: started.authorizeUrl,
            userCode: null,
          }))
        : rpc.call("codex.start", null).then((started) => ({
            sessionId: started.sessionId,
            url: started.verificationUri,
            userCode: started.userCode,
          }));
    start.then(
      (next) => {
        if (cancelled) return;
        setStep(next);
        navigate.openUrl(next.url);
      },
      (cause: unknown) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [provider, rpc]);

  useEffect(() => {
    if (step === null || error !== null) return;
    const timer = window.setInterval(() => {
      void rpc
        .call(provider === "codex" ? "codex.poll" : "claude.poll", {
          sessionId: step.sessionId,
        })
        .then((result) => {
          if (result.status === "complete") close();
          if (result.status === "error") setError(result.message);
        });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [provider, step, error, rpc, close]);

  const copy = () => {
    if (!step) return;
    void navigator.clipboard.writeText(step.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="flex items-center gap-3 py-2.5 text-sm">
      {error ? (
        <Icon name="AlertCircle" className="size-4 shrink-0 text-destructive-text" />
      ) : (
        <Icon name="Spinner" className="size-4 shrink-0 animate-spin text-primary" />
      )}
      <div className="min-w-0 flex-1 truncate text-muted-foreground">
        {error ? (
          <span className="text-destructive-text" title={error}>
            {error}
          </span>
        ) : step === null ? (
          "Starting sign-in…"
        ) : (
          <>
            {step.userCode ? (
              <>
                Enter code{" "}
                <span className="font-mono text-foreground">{step.userCode}</span>
              </>
            ) : (
              "Waiting for sign-in"
            )}
            {" · "}
            <button
              type="button"
              onClick={copy}
              className="text-primary-text hover:underline"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Cancel"
        onClick={close}
      >
        <Icon name="X" />
      </Button>
    </div>
  );
}

function AccountsSection({ provider }: { provider: Provider }) {
  const rpc = useRpc<typeof accountsRpcContract>();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc
      .call("accounts.list", { provider })
      .then(setAccounts, (cause: unknown) => setError(errorText(cause)));
  }, [provider, rpc]);
  useEffect(load, [load]);
  useRealtime(ACCOUNTS_CHANGED, load);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    }
    load();
  };

  const count = accounts?.length ?? 0;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={adding || count >= MAX_ACCOUNTS}
          onClick={() => setAdding(true)}
        >
          <Icon name="Plus" /> Add
        </Button>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {accounts === null ? (
          <p className="py-2.5 text-xs text-muted-foreground">Loading…</p>
        ) : (
          accounts.map((account, index) => (
            <AccountRow
              key={account.id}
              account={account}
              index={index}
              onUse={() =>
                void run(() =>
                  rpc.call("accounts.use", { provider, id: account.id }),
                )
              }
              onRename={(name) =>
                void run(() =>
                  rpc.call("accounts.rename", {
                    provider,
                    id: account.id,
                    name,
                  }),
                )
              }
              onRemove={() =>
                void run(() =>
                  rpc.call("accounts.remove", { provider, id: account.id }),
                )
              }
            />
          ))
        )}
        {adding ? (
          <SignInRow
            provider={provider}
            rpc={rpc}
            close={() => {
              setAdding(false);
              load();
            }}
          />
        ) : null}
      </div>
      <p className="text-xs text-subtle-foreground">
        {provider === "claude-code"
          ? "All Local and Cloud threads use the selected account."
          : "All Local threads use the selected account."}
      </p>
      {error ? <p className="text-xs text-destructive-text">{error}</p> : null}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "claude-code",
    component: () => <AccountsSection provider="claude-code" />,
  });
  app.slots.settingsSection({
    id: "codex",
    component: () => <AccountsSection provider="codex" />,
  });
});
