import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@cloudroom/shared-ui/button";
import {
  ResourceListPanel,
  ResourceListState,
  ResourceRow,
} from "@cloudroom/shared-ui/resource-list";
import { AutomationLifecycleControl } from "./detail-view.js";
import type { automationRpcContract } from "./src/rpc.js";

// Cloud automations (ADR 0212) run on Cloudroom's servers and re-prompt a Cloud thread, even while this Mac is off.
// Agents create them with `room-cli automation create --cloud`; this list shows, pauses, runs, and deletes them.
export type CloudAutomation = {
  id: string;
  thread_id: string;
  name: string;
  cron: string | null;
  timezone: string;
  run_at: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  runs: number;
};
type Request =
  | { action: "list" }
  | { action: "update"; id: string; enabled: boolean }
  | { action: "run" | "delete"; id: string };

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

function describe(a: CloudAutomation): string {
  const schedule = a.cron ? `${a.cron} (${a.timezone})` : "Once";
  const state = !a.enabled
    ? "Paused"
    : a.next_run_at
      ? `Next ${time(a.next_run_at)}`
      : "Starts within a minute";
  const last = a.last_run_at ? ` · Last ${time(a.last_run_at)}` : "";
  return `${schedule} · ${state}${last} · ${a.runs} runs`;
}

export function CloudAutomationsList() {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<{
    rows: CloudAutomation[] | null;
    error: string | null;
  }>({ rows: null, error: null });
  const call = useCallback(
    (request: Request) => rpc.call("cloud_automations", request),
    [rpc],
  );
  const load = useCallback(
    () =>
      call({ action: "list" }).then(
        (value) =>
          setState({
            rows:
              (value as { automations?: CloudAutomation[] }).automations ?? [],
            error: null,
          }),
        (error: unknown) =>
          setState({
            rows: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      ),
    [call],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = useCallback(
    async (request: Request, done: string) => {
      try {
        await call(request);
        toast.success(done);
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      await load();
    },
    [call, load],
  );

  if (state.error)
    return (
      <ResourceListState state="error" message={state.error} onRetry={load} />
    );
  if (!state.rows)
    return (
      <ResourceListState state="loading" message="Loading cloud automations" />
    );
  if (state.rows.length === 0)
    return (
      <ResourceListState
        state="empty"
        message="No cloud automations yet. They re-prompt a Cloud thread on a schedule, even while this Mac is off. Ask an agent to create one."
      />
    );
  return (
    <CloudAutomationRows
      rows={state.rows}
      onOpen={(a) => navigate.toThread(a.thread_id)}
      onRun={(a) => void act({ action: "run", id: a.id }, "Runs within a minute")}
      onDelete={(a) => {
        if (window.confirm(`Delete "${a.name}"?`))
          void act({ action: "delete", id: a.id }, "Deleted");
      }}
      onEnabledChange={(a, enabled) =>
        void act({ action: "update", id: a.id, enabled }, enabled ? "Resumed" : "Paused")
      }
    />
  );
}

/** The rows alone, so stories can show them without a server. */
export function CloudAutomationRows({
  rows,
  onOpen,
  onRun,
  onDelete,
  onEnabledChange,
}: {
  rows: CloudAutomation[];
  onOpen: (a: CloudAutomation) => void;
  onRun: (a: CloudAutomation) => void;
  onDelete: (a: CloudAutomation) => void;
  onEnabledChange: (a: CloudAutomation, enabled: boolean) => void;
}) {
  return (
    <ResourceListPanel>
      {rows.map((a) => (
        <ResourceRow
          key={a.id}
          title={a.name}
          description={
            a.last_error ? `${describe(a)} · ${a.last_error}` : describe(a)
          }
          muted={!a.enabled}
          openLabel="Open Cloud thread"
          onOpen={() => onOpen(a)}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => onRun(a)}>
                Run now
              </Button>
              <Button size="sm" variant="outline" onClick={() => onDelete(a)}>
                Delete
              </Button>
            </>
          }
          persistentActions={
            <AutomationLifecycleControl
              checked={a.enabled}
              label={`${a.enabled ? "Pause" : "Resume"} ${a.name}`}
              onCheckedChange={(enabled) => onEnabledChange(a, enabled)}
            />
          }
        />
      ))}
    </ResourceListPanel>
  );
}
