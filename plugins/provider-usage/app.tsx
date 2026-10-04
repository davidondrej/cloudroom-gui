import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useSidebarThreads,
  type ExperimentalSidebarFooterDisclosureProps,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  formatUsageReset,
  formatUsdCents,
  usageBarColorClass,
} from "@bb/shared-ui/lib/usage-format";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import {
  selectUsageMachine,
  usageRpcSuccessSchema,
  type UsageMachine,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow as UsageWindowValue,
} from "./usage-schema.js";
import {
  emptyUsageMessage,
  hasReportedUsage,
  offlineUsageMessage,
  UsageFeedback,
  usageFeedbackMessages,
} from "./usage-feedback.js";

import { UsageSettings } from "./settings.js";

export interface UsageStoreSnapshot {
  data: UsageSnapshot | null;
  error: string | null;
  isRefreshing: boolean;
}

const CARD_MAX_AGE_MS = 2 * 60_000;
const FOCUS_MAX_AGE_MS = 5 * 60_000;
const SAFETY_REFRESH_INTERVAL_MS = 30 * 60_000;
const storeListeners = new Set<() => void>();
let storeSnapshot: UsageStoreSnapshot = {
  data: null,
  error: null,
  isRefreshing: false,
};
let activeRefreshCount = 0;
let lastMachineId: string | null = null;

function updateStore(next: UsageStoreSnapshot): void {
  storeSnapshot = next;
  for (const listener of storeListeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getStoreSnapshot(): UsageStoreSnapshot {
  return storeSnapshot;
}

function rpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
}

function refreshUsage({
  force,
  machineIds,
  maxAgeMs,
  providerId = null,
  signal,
}: {
  force: boolean;
  machineIds: string[] | null;
  maxAgeMs: number;
  providerId?: string | null;
  signal?: AbortSignal;
}): Promise<void> {
  activeRefreshCount += 1;
  updateStore({ ...storeSnapshot, error: null, isRefreshing: true });
  return (async () => {
    try {
      const response = await fetch(
        "/api/v1/plugins/provider-usage/rpc/getUsage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force, machineIds, maxAgeMs, providerId }),
          signal:
            signal === undefined
              ? AbortSignal.timeout(60_000)
              : AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      if (!response.ok)
        throw new Error(`Usage request returned HTTP ${response.status}.`);
      const body: unknown = await response.json();
      const parsed = usageRpcSuccessSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          rpcErrorMessage(body) ?? "Provider usage could not be loaded.",
        );
      }
      updateStore({
        data: parsed.data.result,
        error: null,
        isRefreshing: activeRefreshCount > 1,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        return;
      }
      console.warn("Provider usage refresh failed", cause);
      updateStore({
        ...storeSnapshot,
        error: "Couldn’t refresh usage.",
      });
    } finally {
      activeRefreshCount -= 1;
      if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
        updateStore({ ...storeSnapshot, isRefreshing: false });
      }
    }
  })();
}

function formatResetCountdown(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
function UsageWindow({ window }: { window: UsageWindowValue }) {
  const [showReset, setShowReset] = useState(false);
  const reset = formatUsageReset(window.resetsAt);
  const countdown = formatResetCountdown(window.resetsAt);
  const value =
    window.cost === null
      ? Math.round(window.usedPercent) + "% used"
      : formatUsdCents(window.cost.usedUsdCents, true) +
        " / " +
        formatUsdCents(window.cost.limitUsdCents, false);
  const label = window.label
    .replace(/^Five-hour limit$|^5 hours$/u, "5h")
    .replace(/^Weekly limit$|^Weekly/u, "7d")
    .replace(/^Daily limit$/u, "1d");
  return (
    <button
      type="button"
      className="block w-full rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      title={`${window.label} · ${reset ?? "Reset time not reported"}`}
      aria-label={`${window.label}: ${value}. ${reset ?? "Reset time not reported"}`}
      aria-expanded={showReset}
      onClick={() => setShowReset((shown) => !shown)}
    >
      <span className="flex items-baseline gap-3 text-2xs">
        <span className="min-w-0 flex-1 text-subtle-foreground">{label}</span>
        <span className="tabular-nums text-sidebar-foreground">
          {Math.round(window.usedPercent)}%
        </span>
        <span
          aria-hidden="true"
          className="tabular-nums text-subtle-foreground"
        >
          {countdown ?? "—"}
        </span>
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-sidebar-border">
        <span
          className={
            "block h-full rounded-full " +
            usageBarColorClass(window.usedPercent)
          }
          style={{
            width: Math.max(2, Math.min(100, window.usedPercent)) + "%",
          }}
        />
      </span>
      {showReset ? (
        <span className="mt-1 block text-2xs text-subtle-foreground">
          {reset ?? "Reset time not reported."}
          {window.cost === null ? "" : ` · ${value}`}
        </span>
      ) : null}
    </button>
  );
}

function ProviderUsageBody({ provider }: { provider: UsageProvider }) {
  const usage = provider.usage;
  if (usage === null) {
    return <p className="text-xs text-muted-foreground">Usage not reported.</p>;
  }
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No usage limits reported for this plan.
        </p>
      ) : (
        <div className="space-y-1.5">
          {usage.windows.map((window) => (
            <UsageWindow key={window.label} window={window} />
          ))}
        </div>
      );
    case "not_installed":
      return (
        <p className="text-xs text-muted-foreground">
          Not installed on this machine.
        </p>
      );
    case "unauthenticated":
      return (
        <p className="text-xs text-muted-foreground">{provider.signInHint}</p>
      );
    case "expired":
      return (
        <p className="text-xs text-muted-foreground">{provider.expiredHint}</p>
      );
    case "error":
      return <p className="text-xs text-muted-foreground">{usage.message}</p>;
  }
}

function MachineSelector({
  machines,
  activeMachine,
  onSelect,
}: {
  machines: UsageMachine[];
  activeMachine: UsageMachine | null;
  onSelect: (machineId: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={machines.length === 0}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activeMachine === null
              ? "Usage machine"
              : "Usage machine: " + activeMachine.displayName
          }
          disabled={machines.length === 0}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            "h-7 shrink overflow-hidden px-1 text-sidebar-foreground hover:bg-sidebar-accent",
          )}
        >
          <span className="block min-w-0 flex-1 truncate">
            {activeMachine?.displayName ?? "Usage"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Usage source"
        className="max-w-72"
      >
        {machines.map((machine) => {
          const isActive = machine.id === activeMachine?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-label={machine.displayName}
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className="flex items-center gap-2"
            >
              <Icon
                name={machine.id.startsWith("source:") ? "Layers" : "Laptop"}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">
                {machine.displayName}
              </span>
              <Icon
                name="Check"
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProviderUsageStatusContent({
  dismiss,
  snapshot,
  threadMachineId,
  refreshEnabled = true,
}: ExperimentalSidebarFooterDisclosureProps & {
  snapshot: UsageStoreSnapshot;
  threadMachineId: string | null;
  refreshEnabled?: boolean;
}) {
  const [, refreshCountdowns] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => refreshCountdowns((tick) => tick + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const machines = snapshot.data?.machines ?? [];
  const [requestedMachineId, setRequestedMachineId] = useState<string | null>(
    lastMachineId,
  );
  const activeMachine = selectUsageMachine(
    machines,
    requestedMachineId,
    threadMachineId,
  );
  const providers = useMemo(() => {
    const groups = new Map<
      string,
      UsageProvider & { accounts: UsageProvider[] }
    >();
    for (const account of activeMachine?.providers ?? []) {
      if (account.usage?.status === "not_installed") continue;
      const group = groups.get(account.providerId);
      if (group) group.accounts.push(account);
      else
        groups.set(account.providerId, {
          ...account,
          id: account.providerId,
          accounts: [account],
        });
    }
    return [...groups.values()];
  }, [activeMachine]);
  const hasUsage = hasReportedUsage(
    providers.flatMap((provider) => provider.accounts),
  );
  const feedback =
    activeMachine === null
      ? snapshot.error !== null
        ? usageFeedbackMessages.loadFailed
        : snapshot.isRefreshing
          ? usageFeedbackMessages.loading
          : usageFeedbackMessages.noSources
      : activeMachine.status === "disconnected"
        ? offlineUsageMessage(activeMachine, hasUsage)
        : snapshot.error !== null || activeMachine.error !== null
          ? hasUsage
            ? usageFeedbackMessages.refreshFailed
            : usageFeedbackMessages.loadFailed
          : providers.length === 0
            ? emptyUsageMessage(activeMachine)
            : null;
  const activeMachineId = activeMachine?.id ?? null;
  const hasProviders = providers.length > 0;

  useEffect(() => {
    if (!refreshEnabled || activeMachineId === null || !hasProviders) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void refreshUsage({
        force: false,
        machineIds: [activeMachineId],
        maxAgeMs: CARD_MAX_AGE_MS,
      });
    };
    refresh();
    const timer = window.setInterval(refresh, CARD_MAX_AGE_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [activeMachineId, hasProviders, refreshEnabled]);

  const selectMachine = useCallback((machineId: string) => {
    lastMachineId = machineId;
    setRequestedMachineId(machineId);
  }, []);

  return (
    <div className="flex max-h-80 flex-col">
      <div
        data-provider-usage-header=""
        className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5"
      >
        <div className="flex min-w-0 flex-1">
          <MachineSelector
            machines={machines}
            activeMachine={activeMachine}
            onSelect={selectMachine}
          />
        </div>
        <button
          type="button"
          aria-label="Reload provider usage"
          disabled={snapshot.isRefreshing}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
          onClick={() =>
            void refreshUsage({
              force: true,
              machineIds: activeMachineId === null ? null : [activeMachineId],
              maxAgeMs: 0,
            })
          }
        >
          <Icon
            name="RotateCcw"
            aria-hidden="true"
            className={
              "size-3.5 " + (snapshot.isRefreshing ? "animate-spin" : "")
            }
          />
        </button>
        <button
          type="button"
          aria-label="Collapse provider usage"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={dismiss}
        >
          <Icon name="ChevronDown" aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto p-2.5">
        {feedback === null ? null : (
          <UsageFeedback
            message={feedback}
            loading={feedback === usageFeedbackMessages.loading}
          />
        )}
        {providers.map((provider) => (
          <section key={provider.id} aria-label={provider.displayName}>
            <h2 className="flex min-w-0 items-center gap-2 text-xs font-medium text-sidebar-foreground">
              <ProviderIcon
                providerKind="agent"
                provider={provider}
                fallback="Bot"
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{provider.displayName}</span>
            </h2>
            {provider.accounts.map((account) => (
              <div key={account.id} className="mt-1 pl-5.5">
                {account.accountLabel === null ? null : (
                  <h3
                    title={account.accountLabel}
                    className="truncate text-2xs text-subtle-foreground"
                  >
                    {account.accountLabel}
                  </h3>
                )}
                {account.usage === null && snapshot.isRefreshing ? (
                  <p className="text-xs text-muted-foreground">
                    {usageFeedbackMessages.loading}
                  </p>
                ) : account.usage === null &&
                  (activeMachine?.error != null || snapshot.error !== null) ? (
                  <p className="text-xs text-muted-foreground">
                    {usageFeedbackMessages.unavailable}
                  </p>
                ) : (
                  <ProviderUsageBody provider={account} />
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function ProviderUsageStatus(props: ExperimentalSidebarFooterDisclosureProps) {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  const threadMachineId = useMemo(
    () =>
      sidebarThreads.threads.find((thread) => thread.id === threadId)?.host
        ?.id ?? null,
    [sidebarThreads.threads, threadId],
  );
  return (
    <ProviderUsageStatusContent
      {...props}
      snapshot={snapshot}
      threadMachineId={threadMachineId}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "usage", component: UsageSettings });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: ProviderUsageStatus,
  });
  app.contentScripts.register({
    id: "refresh-usage",
    mount({ signal }) {
      let timer: number | null = null;
      let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
      let blurredAt: number | null = null;
      const scheduleSafetyRefresh = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted || document.visibilityState !== "visible") return;
        timer = window.setTimeout(runSafetyRefresh, SAFETY_REFRESH_INTERVAL_MS);
      };
      const reconcile = (maxAgeMs: number, machineIds: string[] | null) => {
        void refreshUsage({
          force: false,
          machineIds,
          maxAgeMs,
          signal,
        });
      };
      const runSafetyRefresh = () => {
        if (document.visibilityState === "visible") {
          reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onActive = () => {
        const inactiveAt =
          hiddenAt === null
            ? blurredAt
            : blurredAt === null
              ? hiddenAt
              : Math.min(hiddenAt, blurredAt);
        hiddenAt = null;
        blurredAt = null;
        if (
          inactiveAt !== null &&
          Date.now() - inactiveAt >= FOCUS_MAX_AGE_MS
        ) {
          reconcile(FOCUS_MAX_AGE_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          hiddenAt ??= Date.now();
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          return;
        }
        onActive();
      };
      const onBlur = () => {
        blurredAt ??= Date.now();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onActive);
      reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
      scheduleSafetyRefresh();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onActive);
      };
    },
  });
});
