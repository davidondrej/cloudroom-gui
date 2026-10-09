import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  UrlLink as UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { connectRpcContract } from "./src/rpc.js";
import QRCode from "qrcode";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  CONNECT_REALTIME_CHANNEL,
  type ConnectStateName,
  type ConnectStatus,
  type PhoneCode,
} from "@/src/types";

const LEGACY_UNTIL = "December 7, 2026";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DANGER_QUIET_CLASS =
  "text-destructive-text hover:text-destructive-text hover:bg-surface-destructive";

const STATES: readonly ConnectStateName[] = [
  "disconnected",
  "pairing",
  "connected",
  "reconnecting",
];

function isState(value: unknown): value is ConnectStateName {
  return STATES.includes(value as ConnectStateName);
}

function asStatus(payload: unknown): ConnectStatus | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (
    !isState(record.state) ||
    typeof record.paired !== "boolean" ||
    typeof record.since !== "number"
  ) {
    return null;
  }
  const shares: ConnectStatus["shares"] = [];
  if (Array.isArray(record.shares)) {
    for (const entry of record.shares as Record<string, unknown>[]) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.hostId === "string" &&
        typeof entry.hostName === "string" &&
        typeof entry.port === "number" &&
        typeof entry.createdAt === "number" &&
        typeof entry.url === "string"
      ) {
        shares.push({
          hostId: entry.hostId,
          hostName: entry.hostName,
          port: entry.port,
          createdAt: entry.createdAt,
          url: entry.url,
          ...(typeof entry.unavailableReason === "string"
            ? { unavailableReason: entry.unavailableReason }
            : {}),
        });
      }
    }
  }
  const legacy = record.legacy as { url?: unknown; state?: unknown } | null;
  return {
    state: record.state,
    paired: record.paired,
    handle: typeof record.handle === "string" ? record.handle : null,
    url: typeof record.url === "string" ? record.url : null,
    dashboardUrl:
      typeof record.dashboardUrl === "string" ? record.dashboardUrl : "",
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    nextRetryAt:
      typeof record.nextRetryAt === "number" ? record.nextRetryAt : null,
    since: record.since,
    remoteClients:
      typeof record.remoteClients === "number" ? record.remoteClients : 0,
    lastRemoteActivityAt:
      typeof record.lastRemoteActivityAt === "number"
        ? record.lastRemoteActivityAt
        : null,
    shares,
    signedIn: record.signedIn === true,
    legacy:
      legacy !== null &&
      typeof legacy === "object" &&
      typeof legacy.url === "string" &&
      isState(legacy.state)
        ? { url: legacy.url, state: legacy.state }
        : null,
  };
}

function formatSince(sinceMs: number): string {
  const at = new Date(sinceMs);
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function retryHint(nextRetryAt: number | null): string {
  if (nextRetryAt === null) return "retrying automatically";
  const seconds = Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000));
  return seconds > 0 ? `retrying in ${seconds}s` : "retrying…";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "muted" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" &&
          "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_18%,transparent)]",
        tone === "warn" &&
          "animate-pulse bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]",
        tone === "muted" && "bg-muted-foreground/50",
      )}
    />
  );
}

function StepNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-recessed text-xs font-medium text-muted-foreground"
    >
      {value}
    </span>
  );
}

function QrCodeImage({
  value,
  alt,
  className,
}: {
  value: string;
  alt: string;
  className?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 320 }).then(
      (url) => {
        if (!cancelled) setDataUrl(url);
      },
      () => {
        if (!cancelled) setDataUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (dataUrl === null) return null;
  return (
    <img
      src={dataUrl}
      alt={alt}
      className={cn(
        "size-32 rounded-md border border-border bg-white p-1.5",
        className,
      )}
    />
  );
}

function UrlHero({ url, showOpen }: { url: string; showOpen: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const urlRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const selectUrl = useCallback(() => {
    const element = urlRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectUrl();
        setCopyState("manual");
      },
    );
  }, [url, selectUrl]);

  return (
    <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
      <UrlLink
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground no-underline hover:underline"
      >
        <span ref={urlRef}>{url}</span>
      </UrlLink>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        aria-label="Copy URL"
      >
        <Icon
          name={copyState === "copied" ? "Check" : "Copy"}
          className="size-4"
        />
        {copyState === "copied"
          ? "Copied"
          : copyState === "manual"
            ? "Press ⌘C"
            : "Copy"}
      </Button>
      {showOpen ? (
        <Button type="button" variant="outline" size="sm" asChild>
          <UrlLink href={url} target="_blank" rel="noreferrer">
            Open
          </UrlLink>
        </Button>
      ) : null}
    </div>
  );
}

function QuietCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [text]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={copy}
      aria-label={label}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

interface ShareHostGroup {
  hostId: string;
  hostName: string;
  shares: ConnectStatus["shares"];
}

function groupSharesByHost(shares: ConnectStatus["shares"]): ShareHostGroup[] {
  const groups: ShareHostGroup[] = [];
  const byHostId = new Map<string, ShareHostGroup>();
  for (const share of shares) {
    let group = byHostId.get(share.hostId);
    if (group === undefined) {
      group = { hostId: share.hostId, hostName: share.hostName, shares: [] };
      byHostId.set(share.hostId, group);
      groups.push(group);
    }
    group.shares.push(share);
  }
  return groups;
}

function SharedPortsSection({
  shares,
  dimmed,
}: {
  shares: ConnectStatus["shares"];
  dimmed: boolean;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [portInput, setPortInput] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [exposing, setExposing] = useState(false);
  const [revokingShare, setRevokingShare] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expose = useCallback(() => {
    const trimmed = portInput.trim();
    if (trimmed.length === 0 || exposing) return;
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Port must be an integer between 1 and 65535");
      return;
    }
    setExposing(true);
    setError(null);
    rpc.call("expose", { port }).then(
      () => {
        setExposing(false);
        setPortInput("");
        setFormOpen(false);
      },
      (rpcError: unknown) => {
        setExposing(false);
        setError(errorText(rpcError));
      },
    );
  }, [portInput, exposing, rpc]);

  const unexpose = useCallback(
    (hostId: string, port: number) => {
      if (revokingShare !== null) return;
      const key = `${hostId}:${port}`;
      setRevokingShare(key);
      setError(null);
      rpc.call("unexpose", { hostId, port }).then(
        () => {
          setRevokingShare(null);
        },
        (rpcError: unknown) => {
          setRevokingShare(null);
          setError(errorText(rpcError));
        },
      );
    },
    [revokingShare, rpc],
  );

  return (
    <div
      className={cn(
        "space-y-2.5 border-t border-border-seam pt-4",
        dimmed && "pointer-events-none opacity-60 saturate-[0.85]",
      )}
    >
      <div className="flex items-center">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">
          Shared ports
        </h3>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setFormOpen((open) => !open)}
        >
          <Icon name="Plus" className="size-3.5" />
          Expose a port
        </Button>
      </div>

      {shares.length > 0 ? (
        <div className="space-y-2.5">
          {groupSharesByHost(shares).map((group) => {
            const hostDown = group.shares.every((share) => share.url === "");
            return (
              <div key={group.hostId} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <StatusDot tone={hostDown ? "muted" : "ok"} />
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs font-medium",
                      hostDown ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {group.hostName}
                  </span>
                </div>
                <ul className="space-y-1 pl-3.5">
                  {group.shares.map((share) => (
                    <li
                      key={`${share.hostId}:${share.port}`}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={cn(
                          "shrink-0 font-mono text-xs tabular-nums",
                          share.url
                            ? "text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        :{share.port}
                      </span>
                      {share.url ? (
                        <>
                          <UrlLink
                            href={share.url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            {hostOf(share.url)}
                          </UrlLink>
                          <QuietCopyButton
                            text={share.url}
                            label={`Copy share URL for port ${share.port}`}
                          />
                        </>
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                          title={share.unavailableReason}
                        >
                          Unavailable —{" "}
                          {share.unavailableReason ?? "unknown reason"}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={DANGER_QUIET_CLASS}
                        disabled={
                          revokingShare === `${share.hostId}:${share.port}`
                        }
                        onClick={() => unexpose(share.hostId, share.port)}
                      >
                        {revokingShare === `${share.hostId}:${share.port}` ? (
                          <Icon
                            name="Spinner"
                            className="size-4 animate-spin"
                          />
                        ) : null}
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}

      {formOpen ? (
        <form
          className="flex max-w-[16rem] items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            expose();
          }}
        >
          <Input
            type="number"
            min={1}
            max={65535}
            step={1}
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            placeholder="Port"
            inputMode="numeric"
            className="max-w-[7rem] font-mono"
            aria-label="Port to share"
          />
          <Button
            type="submit"
            size="sm"
            disabled={exposing || portInput.trim().length === 0}
          >
            {exposing ? (
              <Icon name="Spinner" className="size-4 animate-spin" />
            ) : null}
            Expose
          </Button>
        </form>
      ) : null}

      <p className="text-xs text-subtle-foreground/75">
        Agents can share their dev servers too. Only your signed-in phones can open them.
      </p>
      {error !== null ? (
        <p className="text-xs text-destructive-text">{error}</p>
      ) : null}
    </div>
  );
}

function PhoneCodeCard({ connected }: { connected: boolean }) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [code, setCode] = useState<PhoneCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    rpc.call("phoneCode").then(
      (next) => {
        setLoading(false);
        setCode(next);
      },
      (rpcError: unknown) => {
        setLoading(false);
        setError(errorText(rpcError));
      },
    );
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (code === null) return;
    const timer = setTimeout(refresh, Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code, refresh]);

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <StepNumber value={1} />
        <p className="text-sm">
          On your phone, open{" "}
          <span className="font-medium text-foreground">cloudroom.dev/mobile</span>
        </p>
      </div>
      <div className="flex gap-3">
        <StepNumber value={2} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm">Enter this code:</p>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-border bg-surface-recessed px-3 py-1.5 font-mono text-lg font-semibold tracking-widest">
              {code?.code ?? "····-····"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={loading}
              onClick={refresh}
            >
              {loading ? <Icon name="Spinner" className="size-4 animate-spin" /> : null}
              New code
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            It works once, for 10 minutes. Or scan the QR code with your phone&apos;s camera.
          </p>
          {error !== null ? (
            <p className="text-xs text-destructive-text">{error}</p>
          ) : null}
          {code !== null ? (
            <QrCodeImage value={code.url} alt="QR code to open Cloudroom on your phone" />
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Then keep it on your home screen. On iPhone, tap Share, then Add to Home
        Screen. On Android, open the browser menu and tap Install app.
        {connected ? "" : " Your phone reaches this Mac while Cloudroom is open and the Mac is awake."}
      </p>
    </div>
  );
}

function SignOutPhones() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [state, setState] = useState<"idle" | "confirm" | "pending">("idle");
  const [result, setResult] = useState<string | null>(null);
  const signOut = useCallback(() => {
    setState("pending");
    rpc.call("signOutPhones").then(
      ({ revoked }) => {
        setState("idle");
        setResult(revoked === 1 ? "Signed out 1 session." : `Signed out ${revoked} sessions.`);
      },
      (error: unknown) => {
        setState("idle");
        setResult(errorText(error));
      },
    );
  }, [rpc]);
  return (
    <div className="-mx-4 mt-4 flex items-center gap-3 border-t border-border-seam px-4 pt-3">
      <span className="min-w-0 text-xs text-muted-foreground">
        {result ?? "Phones stay signed in until you sign them out here."}
      </span>
      <span className="flex-1" />
      {state === "confirm" ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setState("idle")}>
          Cancel
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={DANGER_QUIET_CLASS}
        disabled={state === "pending"}
        onClick={() => (state === "confirm" ? signOut() : setState("confirm"))}
      >
        {state === "confirm" ? "Sign out all phones?" : "Sign out all phones"}
      </Button>
    </div>
  );
}

function LegacyNote({ url }: { url: string }) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-recessed/50 px-3 py-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        Your old link <span className="font-mono">{hostOf(url)}</span> still works
        until {LEGACY_UNTIL}. Use cloudroom.dev/mobile instead.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={DANGER_QUIET_CLASS}
        disabled={pending}
        onClick={() => {
          setPending(true);
          rpc.call("disconnect").finally(() => setPending(false));
        }}
      >
        Turn off old link
      </Button>
    </div>
  );
}

function StatusLine({ status }: { status: ConnectStatus }) {
  if (!status.signedIn) {
    return (
      <div className="flex items-center gap-2">
        <StatusDot tone="muted" />
        <span className="text-sm">Sign in to Cloudroom to use it on your phone.</span>
      </div>
    );
  }
  if (!status.paired) {
    return (
      <div className="flex items-center gap-2">
        <StatusDot tone="warn" />
        <span className="text-sm font-semibold">Setting up…</span>
        {status.lastError !== null ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {status.lastError}
          </span>
        ) : null}
      </div>
    );
  }
  if (status.state !== "connected") {
    return (
      <div className="flex items-center gap-2">
        <StatusDot tone="warn" />
        <span className="shrink-0 text-sm font-semibold text-warning-text">Reconnecting…</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {[status.lastError, retryHint(status.nextRetryAt)]
            .filter((part): part is string => Boolean(part))
            .join(" · ")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <StatusDot tone="ok" />
      <span className="text-sm font-semibold">Ready</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        since {formatSince(status.since)}
        {status.remoteClients > 0 ? ` · ${status.remoteClients} viewing remotely` : ""}
      </span>
    </div>
  );
}

function ConnectSettingsSection() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("status").then(
      (result) => {
        const next = asStatus(result);
        if (next !== null) setStatus(next);
        else setLoadError("Unexpected status payload.");
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc]);

  useRealtime(CONNECT_REALTIME_CHANNEL, (payload) => {
    const next = asStatus(payload);
    if (next !== null) {
      setStatus(next);
      setLoadError(null);
    }
  });

  if (loadError !== null) {
    return (
      <p className="text-sm text-destructive-text">
        Failed to load remote-access status: {loadError}
      </p>
    );
  }
  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <StatusLine status={status} />
      {status.paired ? <PhoneCodeCard connected={status.state === "connected"} /> : null}
      {status.paired && status.url !== null ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Your private address</p>
          <UrlHero url={status.url} showOpen={status.state === "connected"} />
        </div>
      ) : null}
      {status.legacy !== null ? <LegacyNote url={status.legacy.url} /> : null}
      {status.paired || status.legacy !== null ? (
        <SharedPortsSection shares={status.shares} dimmed={status.state !== "connected" && status.legacy?.state !== "connected"} />
      ) : null}
      {status.paired ? <SignOutPhones /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "remote-access",
    description:
      "Open Cloudroom on your phone with one code at cloudroom.dev/mobile.",
    component: ConnectSettingsSection,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "remote-access",
    label: "Cloudroom Connect",
    icon: "Smartphone",
    onActivate({ openPluginDetails }) {
      openPluginDetails();
    },
  });
});
