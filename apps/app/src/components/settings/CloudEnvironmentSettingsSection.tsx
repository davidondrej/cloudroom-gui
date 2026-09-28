import { useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CloudEnvironment, CloudEnvironmentChange } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import { Checkbox } from "@bb/shared-ui/checkbox";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { sdk } from "@/lib/sdk";

const ENVIRONMENT_KEY = ["cloudroom-environment"];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREINSTALLED = "Node.js · Git · GitHub CLI · Claude Code · Codex · Pi · Cursor";
const SCRIPT_PLACEHOLDER = "# Runs once in each new cloud sandbox, as the agent. sudo works.\nnpm install -g vercel";

const errorText = (error: unknown) => (error instanceof Error ? error.message : error ? String(error) : null);

export function CloudEnvironmentSettingsSection() {
  const queryClient = useQueryClient();
  const environment = useQuery({
    queryKey: ENVIRONMENT_KEY,
    queryFn: ({ signal }) => sdk.cloudroom.environment(signal),
    refetchInterval: 15_000,
    retry: false,
  });
  const saved = (data: CloudEnvironment) => queryClient.setQueryData(ENVIRONMENT_KEY, data);
  const update = useMutation({ mutationFn: (change: CloudEnvironmentChange) => sdk.cloudroom.updateEnvironment(change), onSuccess: saved });
  const data = environment.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Cloud environment</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-subtle-foreground">
            Every new cloud thread starts with these API keys and this setup. Change them here or on your cloudroom.dev dashboard. Both stay in sync.
          </p>
        </div>
        {data && !environment.isError && (
          <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-border bg-surface-recessed px-2.5 py-1 text-2xs text-subtle-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            Synced with cloudroom.dev
          </span>
        )}
      </header>
      {!data ? (
        <div role={environment.isError ? "alert" : "status"} className="rounded-lg border border-border bg-card px-4 py-6 text-center text-xs text-subtle-foreground">
          {environment.isError ? errorText(environment.error) : "Loading your cloud environment…"}
        </div>
      ) : (
        <>
          <VariablesCard environment={data} busy={update.isPending} onChange={(change) => update.mutateAsync(change)} onImported={saved} />
          <SetupScriptCard setup={data.setup} onSave={(setup) => update.mutateAsync({ action: "setup", setup })} />
        </>
      )}
      {update.error && (
        <p role="alert" className="text-xs text-destructive-text">
          {errorText(update.error)}
        </p>
      )}
    </div>
  );
}

function Card({ icon, title, description, action, children }: { icon: string; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-recessed text-subtle-foreground">
            <Icon name={icon} className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <p className="text-xs text-subtle-foreground">{description}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function VariablesCard({
  environment,
  busy,
  onChange,
  onImported,
}: {
  environment: CloudEnvironment;
  busy: boolean;
  onChange: (change: CloudEnvironmentChange) => Promise<unknown>;
  onImported: (data: CloudEnvironment) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameProblem = name && !VARIABLE_NAME.test(name) ? "Names start with a letter or underscore." : null;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name || !value.trim() || nameProblem) return;
    void onChange({ action: "set", variables: { [name]: value } }).then(() => {
      setName("");
      setValue("");
    }, () => {});
  };
  const pasteLine = (event: ClipboardEvent<HTMLInputElement>) => {
    const line = event.clipboardData.getData("text").trim().replace(/^export\s+/, "");
    const at = line.indexOf("=");
    if (at < 1) return;
    event.preventDefault();
    setName(line.slice(0, at).trim());
    setValue(line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
  };
  return (
    <Card
      icon="Lock"
      title="API keys"
      description="Agents get these as environment variables. Values are hidden after saving."
      action={
        <Button size="sm" variant="outline" aria-expanded={importing} onClick={() => setImporting(!importing)}>
          <Icon name="Laptop" />
          Import from Mac
        </Button>
      }
    >
      {importing && (
        <MacImport
          saved={new Set(environment.variables.map((variable) => variable.name))}
          onClose={() => setImporting(false)}
          onImported={(data) => {
            onImported(data);
            setImporting(false);
          }}
        />
      )}
      {environment.variables.length ? (
        <ul className="divide-y divide-border border-t border-border">
          {environment.variables.map((variable) => (
            <li key={variable.name} className="group flex items-center gap-3 px-4 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{variable.name}</code>
              <span className="font-mono text-xs tracking-wider text-subtle-foreground" aria-label="Hidden value">
                ••••••••{variable.hint}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-subtle-foreground hover:text-destructive-text"
                aria-label={`Remove ${variable.name}`}
                disabled={busy}
                onClick={() => void onChange({ action: "remove", name: variable.name }).catch(() => {})}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-5 text-center text-xs text-subtle-foreground">
          No API keys yet. Add one below, or import them from your Mac.
        </p>
      )}
      <form onSubmit={add} className="flex flex-col gap-2 border-t border-border bg-surface-recessed/40 px-4 py-3 sm:flex-row sm:items-start">
        <div className="sm:w-60">
          <Input
            className="h-8 font-mono text-xs"
            placeholder="OPENROUTER_API_KEY"
            aria-label="Variable name"
            aria-invalid={nameProblem !== null}
            autoComplete="off"
            spellCheck={false}
            value={name}
            onPaste={pasteLine}
            onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          />
          {nameProblem && <p className="mt-1 text-2xs text-destructive-text">{nameProblem}</p>}
        </div>
        <Input
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          type="password"
          placeholder="Value"
          aria-label="Variable value"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !name || !value.trim() || nameProblem !== null}>
          <Icon name="Plus" />
          Add
        </Button>
      </form>
    </Card>
  );
}

function MacImport({ saved, onClose, onImported }: { saved: Set<string>; onClose: () => void; onImported: (data: CloudEnvironment) => void }) {
  const found = useQuery({ queryKey: ["cloudroom-mac-variables"], queryFn: ({ signal }) => sdk.cloudroom.macVariables(signal), staleTime: 0, retry: false });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const names = found.data?.names ?? [];
  const selected = picked ?? new Set(names.filter((name) => !saved.has(name)));
  const run = useMutation({ mutationFn: () => sdk.cloudroom.importMacVariables([...selected]), onSuccess: onImported });
  const toggle = (name: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    setPicked(next);
  };
  return (
    <div className="border-t border-border bg-surface-recessed/40 px-4 py-3">
      {found.isPending ? (
        <p className="text-xs text-subtle-foreground">Looking for API keys in your shell…</p>
      ) : found.isError ? (
        <p role="alert" className="text-xs text-destructive-text">{errorText(found.error)}</p>
      ) : !names.length ? (
        <p className="text-xs text-subtle-foreground">No API keys found in your shell on this Mac (for example, in ~/.zshrc).</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-subtle-foreground">Found in your shell on this Mac. Pick the ones cloud agents should get.</p>
          <div className="grid gap-0.5 sm:grid-cols-2">
            {names.map((name) => (
              <label key={name} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover">
                <Checkbox checked={selected.has(name)} onCheckedChange={(on) => toggle(name, on === true)} aria-label={name} />
                <code className="min-w-0 truncate font-mono text-xs text-foreground">{name}</code>
                {saved.has(name) && <span className="ml-auto shrink-0 text-2xs text-subtle-foreground">Replaces saved</span>}
              </label>
            ))}
          </div>
        </>
      )}
      {run.error && <p role="alert" className="mt-2 text-xs text-destructive-text">{errorText(run.error)}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {names.length > 0 && (
          <Button size="sm" disabled={!selected.size || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Importing…" : `Import ${selected.size}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function SetupScriptCard({ setup, onSave }: { setup: string; onSave: (setup: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const script = draft ?? setup;
  const dirty = draft !== null && draft !== setup;
  const save = () => {
    setSaving(true);
    void onSave(script).then(() => setDraft(null), () => {}).finally(() => setSaving(false));
  };
  return (
    <Card icon="Terminal" title="Setup script" description="Runs once in each new cloud sandbox, in the background. Output: /var/log/cloudroom/setup.log">
      <div className="border-t border-border p-3">
        <Textarea
          className="min-h-36 resize-y font-mono text-xs leading-relaxed"
          placeholder={SCRIPT_PLACEHOLDER}
          aria-label="Setup script"
          spellCheck={false}
          value={script}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-recessed/40 px-4 py-3">
        <p className="min-w-0 text-xs text-subtle-foreground">
          Already installed: <span className="text-foreground/80">{PREINSTALLED}</span>
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save script" : "Saved"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
