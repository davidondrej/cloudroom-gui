import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ClaudeConnectionButton, useClaudeConnection } from "@/components/ClaudeConnection";
import { openCodexConnection } from "@/components/CodexConnectionPanel";
import { selectCloudForNewThreads } from "@/components/promptbox/NewThreadComposer";
import { ImportChats } from "@/components/settings/ImportChats";
import { BbLogo } from "@/components/ui/bb-logo";
import { appToast } from "@/components/ui/app-toast";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useCloudroomAccount, useCloudroomSignIn, useImportBb, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { usePromptBoxProviderPreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { booleanLocalStorage } from "@/lib/browser-storage";
import { MACOS_APP_REGION_NO_DRAG_CLASS, MACOS_WINDOW_DRAG_CLASS } from "@/lib/bb-desktop";
import { copyTextToClipboard, copyToClipboardWithToast } from "@/lib/clipboard";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useSystemConfig, useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const dismissedAtom = atomWithStorage("cloudroom.setup.dismissed", false, booleanLocalStorage, { getOnInit: true });
const openAtom = atom(false);
export const useOpenSetup = () => useSetAtom(openAtom);

const STEPS = ["Sign in", "Connect an agent", "Connect GitHub", "Import your work"];
const STEP_IDS = ["account", "agent", "github", "project"] as const;
type SetupStepId = (typeof STEP_IDS)[number];
type SetupDetail = "claude" | "codex" | "both" | "none" | "existing" | "found" | "folder" | "bb_import" | "chat_import";
function track(step: SetupStepId, action: "viewed" | "started" | "done" | "skipped" | "closed" | "detected", detail: SetupDetail | null = null) {
  void fetchWithAppSurface("/api/v1/cloudroom/setup-step", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, action, detail }),
  }).catch(() => {});
}
const LATER = ["Your Cloudroom account", "Claude Code or Codex", "For private repos", "Last step"];
const PALETTE = {
  "--ob-bg": "#faf7ef", "--ob-rail": "#f2ecde", "--ob-card": "#fffdf7", "--ob-line": "#e2dac6", "--ob-dash": "#c9bfa6",
  "--ob-ink": "#29251e", "--ob-muted": "#7a7263", "--ob-lime": "#bfff00", "--ob-ok": "#4d6b00",
} as CSSProperties;

export function useSetupProgress() {
  const account = useCloudroomAccount();
  const accountId = account.data?.account?.id;
  const ready = account.data?.ready === true;
  const offline = Boolean(account.data?.account && !ready && account.data?.error);
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId));
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: Boolean(accountId) && ready,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "waiting" ? 1500 : false),
  });
  const github = useQuery({
    queryKey: ["cloudroom-github-auth", accountId],
    enabled: Boolean(accountId) && ready,
    queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "waiting" ? 1500 : false),
  });
  const agents = { claude: claude.data?.state === "connected", codex: codex.data?.state === "connected" };
  const done = [Boolean(accountId), agents.claude || agents.codex, github.data?.state === "connected"];
  return { account, ready, offline, agents, codex, github, done, complete: done.every(Boolean), checking: account.isPending };
}

export function Onboarding() {
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const [open, setOpen] = useAtom(openAtom);
  const projects = useSidebarNavigation().data?.projects;
  const account = useCloudroomAccount();
  const locked = account.isSuccess && !account.data.account;
  const visible = locked || open || (!dismissed && projects !== undefined && projects.length === 0);
  if (!visible) return null;
  return <Setup locked={locked} close={() => { setDismissed(true); setOpen(false); }} />;
}

function Setup({ locked, close }: { locked: boolean; close: () => void }) {
  const progress = useSetupProgress();
  const { done, account } = progress;
  useFirstAgentDefault(progress.agents);
  const first = done.findIndex((isDone) => !isDone);
  const [picked, setPicked] = useState<number | null>(null);
  const step = picked ?? (first === -1 ? 3 : first);
  const next = () => setPicked(nextStep(done, step));
  const signedIn = done[0];
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current && step === 0) setPicked(nextStep(done, 0));
    wasSignedIn.current = signedIn;
  }, [signedIn, step, done]);
  // Stay on the agent step after one agent connects; only both connecting moves on by itself.
  const bothAgents = progress.agents.claude && progress.agents.codex;
  const hadBothAgents = useRef(bothAgents);
  useEffect(() => {
    if (step === 1 && picked === null) setPicked(1);
    if (bothAgents && !hadBothAgents.current && step === 1) setPicked(nextStep(done, 1));
    hadBothAgents.current = bothAgents;
  }, [bothAgents, step, picked, done]);
  const viewed = useRef(new Set<number>());
  useEffect(() => {
    if (progress.checking || viewed.current.has(step)) return;
    const timer = setTimeout(() => { viewed.current.add(step); track(STEP_IDS[step] ?? "project", "viewed"); }, 1500);
    return () => clearTimeout(timer);
  }, [progress.checking, step]);
  const knownSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (progress.checking) return;
    if (knownSignedIn.current === false && signedIn) track("account", "done");
    knownSignedIn.current = signedIn;
  }, [progress.checking, signedIn]);
  if (progress.checking) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Cloudroom" style={PALETTE} className="fixed inset-0 z-50 flex flex-col bg-(--ob-bg) text-(--ob-ink) duration-300 animate-in fade-in-0">
      <div className={cn("h-10 shrink-0 border-b border-(--ob-line) bg-(--ob-rail)", MACOS_WINDOW_DRAG_CLASS)} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-(--ob-line) bg-(--ob-rail) px-[22px] pt-7 pb-6">
          <div className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
            <BbLogo className="size-7" />
            cloudroom
          </div>
          <p className="mt-10 mb-3 ml-3 text-[11px] tracking-[0.14em] text-(--ob-muted) uppercase">Setup</p>
          <ol className="flex flex-col gap-2">
            {STEPS.map((title, index) => {
              const state = index === step ? "now" : index < 3 && done[index] ? "done" : "todo";
              const meta = state === "now" ? "In progress" : state === "done" ? doneMeta(index, progress) : LATER[index];
              const reachable = index <= Math.max(first === -1 ? 3 : first, step) || state === "done";
              return (
                <li key={title} className="relative">
                  {index < 3 && <span aria-hidden className="absolute top-11 left-[25px] h-[30px] border-l border-dashed border-(--ob-dash)" />}
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => setPicked(index)}
                    aria-current={state === "now" ? "step" : undefined}
                    className={cn(
                      "relative flex w-full items-start gap-3.5 border border-transparent p-3 text-left",
                      state === "now" && "z-10 border-(--ob-line) bg-(--ob-card) shadow-[0_10px_30px_-18px_rgba(60,45,10,0.35)]",
                      state === "todo" && "opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center border text-[11px] font-semibold",
                        state === "done" && "border-(--ob-ink) bg-(--ob-ink) text-(--ob-bg)",
                        state === "now" && "border-(--ob-ink) bg-(--ob-lime) text-black",
                        state === "todo" && "border-(--ob-line) bg-(--ob-rail) text-(--ob-muted)",
                      )}
                    >
                      {state === "done" ? <Icon name="Check" className="size-3.5" aria-label="Done" /> : `0${index + 1}`}
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-sm leading-tight font-semibold">{title}</strong>
                      <small className="mt-0.5 block truncate text-[12.5px] text-(--ob-muted)">{meta}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-auto px-3 text-[12.5px] text-(--ob-muted)">Reopen setup anytime from the account button in the sidebar.</p>
        </aside>
        <main className="relative flex min-w-0 flex-1 overflow-y-auto px-[110px] py-10">
          {!locked && (
            <button type="button" onClick={() => { track(STEP_IDS[step] ?? "project", "closed"); close(); }} className={cn("absolute top-5 right-6 flex items-center gap-1.5 text-[13px] text-(--ob-muted) hover:text-(--ob-ink)", MACOS_APP_REGION_NO_DRAG_CLASS)}>
              Skip setup
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          )}
          <div key={step} className={cn("my-auto w-full duration-300 animate-in fade-in-0 slide-in-from-bottom-1", step === 3 ? "max-w-[860px]" : "max-w-[600px]")}>
            <BbLogo className="mb-6 size-[72px] -rotate-[5deg]" />
            <p className="font-serif text-base text-(--ob-muted) italic">Step {step + 1} of 4</p>
            {step === 0 && <AccountStep email={account.data?.account?.email ?? null} signingIn={account.data?.signingIn === true} next={next} />}
            {step === 1 && <AgentStep progress={progress} next={next} />}
            {step === 2 && <GithubStep progress={progress} next={next} />}
            {step === 3 && <ProjectStep close={close} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function useFirstAgentDefault({ claude, codex }: { claude: boolean; codex: boolean }) {
  const settings = useSystemConfig().data?.generalSettings;
  const update = useUpdateGeneralSettings();
  const setProvider = usePromptBoxProviderPreference().setValue;
  const assigned = useRef(false);
  const agent = claude ? "claude-code" : codex ? "codex" : null;
  useEffect(() => {
    if (assigned.current || !agent || !settings || settings.defaultProviderId !== null) return;
    assigned.current = true;
    setProvider(agent);
    update.mutate({ ...settings, defaultProviderId: agent });
  }, [agent, settings, setProvider, update]);
}

function nextStep(done: boolean[], from: number) {
  const index = done.findIndex((isDone, i) => i > from && !isDone);
  return index === -1 ? 3 : index;
}

function doneMeta(index: number, progress: ReturnType<typeof useSetupProgress>) {
  if (index === 0) return progress.account.data?.account?.email ?? "Signed in";
  if (index === 1) return [progress.agents.claude && "Claude Code", progress.agents.codex && "Codex"].filter(Boolean).join(" + ");
  return progress.github.data?.email ?? "Connected";
}

function Heading({ lead, mark }: { lead: string; mark: string }) {
  return (
    <h1 className="mt-1.5 font-serif text-[52px] leading-[1.08] font-medium tracking-[-0.025em]">
      {lead}{" "}
      <em className="bg-[linear-gradient(transparent_58%,var(--ob-lime)_58%,var(--ob-lime)_92%,transparent_92%)]">{mark}</em>
    </h1>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-(--ob-muted)">{children}</p>;
const LINK = "text-(--ob-ink) underline underline-offset-[3px] disabled:opacity-50";
const QUIET_LINK = "underline decoration-(--ob-dash) underline-offset-[3px] hover:text-(--ob-ink) disabled:opacity-50";

function Cta({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("inline-flex h-12 items-center justify-center gap-2.5 bg-(--ob-ink) px-7 text-[15.5px] font-semibold text-(--ob-bg) transition-opacity hover:opacity-90 disabled:opacity-40 [&_svg]:size-4", className)}
      {...props}
    >
      {children}
    </button>
  );
}

const OUTLINE = "inline-flex h-9 shrink-0 items-center gap-2 rounded-none border border-(--ob-ink) bg-(--ob-card) px-4 text-[13.5px] font-medium text-(--ob-ink) hover:bg-(--ob-bg) hover:text-(--ob-ink) disabled:opacity-50";
const CONNECT = cn(OUTLINE, "h-11 gap-2.5 border-2 px-6 text-[15px] font-semibold shadow-[4px_4px_0_var(--ob-ink)] after:content-['→'] active:translate-x-0.5 active:translate-y-0.5 active:shadow-[2px_2px_0_var(--ob-ink)]");

function Outline({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(OUTLINE, className)}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ on, isDefault, logo, name, detail, children }: { on?: boolean; isDefault?: boolean; logo: ReactNode; name: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-4 border bg-(--ob-card) px-[22px] py-[18px]", on ? "border-(--ob-ink)" : "border-(--ob-line)")}>
      <span className="grid size-11 shrink-0 place-items-center">{logo}</span>
      <span className="min-w-0 flex-1">
        <b className="block text-base font-semibold">
          {name}
          {isDefault && <span className="ml-2 border border-(--ob-line) px-1.5 py-px align-[2px] text-[11px] font-medium text-(--ob-muted)">Default</span>}
        </b>
        <span className="text-[13px] text-(--ob-muted)">{detail}</span>
      </span>
      {children}
    </div>
  );
}

const Connected = () => (
  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-(--ob-ok)">
    <Icon name="Check" className="size-3" aria-hidden />
    Connected
  </span>
);

function AccountStep({ email, signingIn, next }: { email: string | null; signingIn: boolean; next: () => void }) {
  const signIn = useCloudroomSignIn();
  const busy = signingIn || signIn.isPending;
  const start = () => { track("account", "started"); signIn.mutate("signIn"); };
  return (
    <>
      <Heading lead="Sign in to" mark="Cloudroom" />
      {email ? (
        <div className="mt-8 flex items-center gap-5">
          <Cta onClick={next}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
          <Note>Signed in as {email}.</Note>
        </div>
      ) : busy ? (
        <div className="mt-8 flex max-w-[420px] flex-col gap-3">
          <Cta disabled className="w-full"><Icon name="Loading" className="animate-spin" aria-hidden />Waiting for your browser…</Cta>
          <Note>Finish logging in in your browser. <button type="button" className={LINK} onClick={() => signIn.mutate("cancel")}>Cancel</button></Note>
        </div>
      ) : (
        <>
          <p className="mt-3 text-base text-(--ob-muted)">Use the account you made on cloudroom.dev.</p>
          <div className="mt-8 flex flex-col items-start gap-4">
            <Cta onClick={start}>Sign in with browser <Icon name="ArrowRight" aria-hidden /></Cta>
            <Note>Already signed in there? You come right back.</Note>
          </div>
        </>
      )}
    </>
  );
}

function AgentStep({ progress, next }: { progress: ReturnType<typeof useSetupProgress>; next: () => void }) {
  const { account, agents, codex, ready, offline } = progress;
  const defaultAgent = useSystemConfig().data?.generalSettings.defaultProviderId;
  const { localHostId } = useHostDaemon();
  const claudeLocal = useClaudeConnection({ target: "local", hostId: localHostId });
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current || claudeLocal.isPending || !account.data) return;
    detected.current = true;
    const claude = claudeLocal.data?.state === "connected", codexFound = Boolean(account.data.localLogins?.codex);
    track("agent", "detected", claude && codexFound ? "both" : claude ? "claude" : codexFound ? "codex" : "none");
  }, [claudeLocal.isPending, claudeLocal.data?.state, account.data]);
  const startedAgents = useRef(new Set<"claude" | "codex">());
  const started = (agent: "claude" | "codex") => {
    if (startedAgents.current.has(agent)) return;
    startedAgents.current.add(agent);
    track("agent", "started", agent);
  };
  const client = useQueryClient();
  const saveMacAccess = useSetMacAccess();
  const saveCopyLogins = useSetCopyLogins();
  const [ask] = useState(() => ({ mac: account.data?.macAccess == null, logins: account.data?.copyLogins == null }));
  const [macAccess, setMacAccess] = useState(true);
  const [copyLogins, setCopyLogins] = useState(true);
  const saveChoices = () =>
    Promise.all([
      ask.mac && account.data?.macAccess == null && saveMacAccess.mutateAsync(macAccess),
      ask.logins && account.data?.copyLogins == null && saveCopyLogins.mutateAsync(copyLogins),
    ]);
  const connectCodex = useMutation({
    mutationFn: async () => {
      await saveChoices();
      const result = await sdk.cloudroom.codexLogin(crypto.randomUUID());
      // A VM signs in with a device code; a sandbox signs in on this Mac, where Codex opens the browser itself.
      if (result.state === "waiting" && result.user_code) openCodexConnection();
      else if (result.state !== "connected" && result.state !== "waiting") throw new Error(result.message ?? "Codex could not connect. Try again.");
      client.setQueryData(["cloudroom-codex-auth", account.data?.account?.id], result);
    },
    meta: { showErrorToast: false },
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-codex-auth"] }),
  });
  const finish = useMutation({ mutationFn: saveChoices, onSuccess: () => { track("agent", "done", agents.claude && agents.codex ? "both" : agents.claude ? "claude" : "codex"); next(); }, meta: { showErrorToast: false }, onError: (error) => appToast.error(error.message) });
  const codexBrowser = codex.data?.state === "waiting" && !codex.data.user_code ? codex.data : null;
  const waiting = !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…" : null;
  const action = (connected: boolean, button: ReactNode) => (connected ? <Connected /> : waiting ? <Note>{waiting}</Note> : button);
  return (
    <>
      <Heading lead="Connect an" mark="agent" />
      <div className="mt-8 flex flex-col gap-3">
        <Card on={agents.claude} isDefault={agents.claude && defaultAgent === "claude-code"} logo={<AgentLogo id="claude-code" className="bg-[#f4e4d6]" />} name="Claude Code" detail={claudeLocal.data?.state === "connected" ? "Found on this Mac" : "Uses your Claude plan"}>
          {action(agents.claude, <span onClickCapture={() => started("claude")}><ClaudeConnectionButton target="cloud" presentation="inline" className={CONNECT} /></span>)}
        </Card>
        <Card on={agents.codex} isDefault={agents.codex && defaultAgent === "codex"} logo={<AgentLogo id="codex" className="bg-black text-white" />} name="Codex" detail={account.data?.localLogins?.codex ? "Found on this Mac" : "Uses your ChatGPT plan"}>
          {action(agents.codex, codexBrowser ? (
            <Note>
              Finish in your browser.{" "}
              {codexBrowser.verification_url && <button type="button" className={LINK} onClick={() => openUrlInExternalBrowser(codexBrowser.verification_url!)}>Reopen</button>}
            </Note>
          ) : (
            <Outline className={CONNECT} disabled={connectCodex.isPending} onClick={() => { started("codex"); connectCodex.mutate(); }}>{connectCodex.isPending ? "Connecting…" : "Connect"}</Outline>
          ))}
        </Card>
      </div>
      {offline && <CloudOffline />}
      {(ask.mac || ask.logins) && (
        <div className="mt-5 flex flex-col gap-2 text-[13px]">
          {ask.logins && <Choice checked={copyLogins} onChange={setCopyLogins} label="Copy my logins to the cloud" detail="Agent logins, API keys, and model providers." />}
          {ask.mac && <Choice checked={macAccess} onChange={setMacAccess} label="Let cloud agents use this computer" detail="Far more powerful agents. Turn off anytime." />}
        </div>
      )}
      <div className="mt-8 flex items-center gap-5">
        <Cta disabled={!(agents.claude || agents.codex) || finish.isPending} onClick={() => finish.mutate()}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        <Note>Add the other one later in Settings.</Note>
      </div>
    </>
  );
}

function CloudOffline() {
  const signIn = useCloudroomSignIn();
  const signingIn = useCloudroomAccount().data?.signingIn === true;
  return (
    <div className="mt-3">
      <Note>
        Your cloud isn't responding.{" "}
        <button type="button" className={LINK} disabled={signIn.isPending || signingIn} onClick={() => signIn.mutate("signIn")}>{signingIn ? "Finish in your browser…" : "Sign in again"}</button>
      </Note>
    </div>
  );
}

/** Uses the provider record so the plugin's real logo and tint load, not the generic fallback. */
function AgentLogo({ id, className }: { id: string; className: string }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return (
    <span className={cn("grid size-11 place-items-center", className)} style={provider && getProviderIconTintStyle(provider)}>
      <Logo className="size-6" />
    </span>
  );
}

function Choice({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-(--ob-ink)" />
      <span className="font-medium">{label}</span>
      <span className="text-(--ob-muted)">{detail}</span>
    </label>
  );
}

const GITHUB_COUNTDOWN = 4;
const openGithub = (url: string) => { if (new URL(url).origin === "https://github.com") openUrlInExternalBrowser(url); };

function GithubStep({ progress, next }: { progress: ReturnType<typeof useSetupProgress>; next: () => void }) {
  const { github, account, ready, offline } = progress;
  const client = useQueryClient();
  const requestId = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  const connect = useMutation({
    mutationFn: async () => {
      track("github", "started");
      requestId.current = crypto.randomUUID();
      const result = await sdk.cloudroom.githubLogin(requestId.current);
      if (result.state === "waiting" && result.verification_url && result.user_code) {
        if (new URL(result.verification_url).origin !== "https://github.com") throw new Error("Unexpected GitHub sign-in page.");
        setCopied(await copyTextToClipboard(result.user_code));
        setLeft(GITHUB_COUNTDOWN);
      } else if (result.state !== "connected") throw new Error(result.message ?? "GitHub could not connect. Try again.");
      return result;
    },
    onSuccess: (result) => client.setQueriesData({ queryKey: ["cloudroom-github-auth"] }, result),
    onError: (error) => appToast.error(error.message),
    onSettled: refresh,
  });
  const cancel = useMutation({
    onMutate: () => setLeft(null),
    mutationFn: () => sdk.cloudroom.cancelGithubLogin(requestId.current ?? github.data?.login_id ?? ""),
    onSettled: refresh,
  });
  const state = github.data?.state;
  const connected = state === "connected";
  const code = state === "waiting" ? github.data?.user_code : null;
  const url = state === "waiting" ? github.data?.verification_url : null;
  const open = () => {
    setLeft(null);
    if (url) openGithub(url);
  };
  useEffect(() => {
    if (left === null || !url) return;
    const timer = setTimeout(() => {
      if (left > 1) return setLeft(left - 1);
      setLeft(null);
      openGithub(url);
    }, 1000);
    return () => clearTimeout(timer);
  }, [left, url]);
  const copyAgain = async () => {
    if (code && await copyToClipboardWithToast(code, { successMessage: "Code copied." })) setCopied(true);
  };
  const detail = connected
    ? "Cloud agents can use your repos."
    : !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…" : "Not found on this Mac. You'll copy a code, then paste it on github.com.";
  if (code) {
    return (
      <>
        <Heading lead="Your GitHub" mark="code" />
        <div className="mt-8 flex items-center gap-2">
          {code.split("").map((char, index) => char === "-"
            ? <span key={index} aria-hidden className="mx-1 h-[3px] w-3.5 bg-(--ob-ink)" />
            : <span key={index} className="grid h-16 w-[52px] place-items-center border-[1.5px] border-(--ob-ink) bg-(--ob-card) font-mono text-3xl font-semibold">{char}</span>)}
        </div>
        <p className="mt-4 text-[15px]">
          {copied && <span className="font-semibold text-(--ob-ok)">✓ Copied to your clipboard · </span>}
          <button type="button" className={LINK} onClick={() => void copyAgain()}>{copied ? "Copy again" : "Copy code"}</button>
        </p>
        <div className="mt-8 flex items-center gap-5">
          <Cta onClick={open}><Icon name="Github" aria-hidden />{left === null ? "Open GitHub" : `Opening GitHub in ${left}…`}</Cta>
          <Note>
            {left !== null && <><button type="button" className={LINK} onClick={open}>Open now</button> · </>}
            <button type="button" className={LINK} onClick={() => cancel.mutate()}>Cancel</button>
          </Note>
        </div>
        {left !== null && (
          <div className="mt-3.5 h-1.5 w-[360px] bg-(--ob-line)">
            <span className="bb-hero-progress-fill block h-full bg-(--ob-ink)" style={{ "--bb-hero-slide-duration": `${GITHUB_COUNTDOWN}s` } as CSSProperties} />
          </div>
        )}
        <p className="mt-6 text-sm text-(--ob-muted)">
          On GitHub: press <b className="text-(--ob-ink)">⌘V</b> to paste, then click <b className="text-(--ob-ink)">Authorize</b>. This screen moves on by itself.
        </p>
      </>
    );
  }
  return (
    <>
      <Heading lead="Connect" mark="GitHub" />
      <div className="mt-8">
        <Card on={connected} logo={<span className="grid size-11 place-items-center bg-black text-white"><Icon name="Github" className="size-6" aria-hidden /></span>} name="GitHub" detail={detail}>
          {connected && <Connected />}
        </Card>
      </div>
      {offline && <CloudOffline />}
      <div className="mt-8 flex items-center gap-5">
        {connected ? (
          <Cta onClick={() => { track("github", "done"); next(); }}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        ) : (
          <Cta disabled={!ready || connect.isPending} onClick={() => connect.mutate()}>
            <Icon name={connect.isPending ? "Loading" : "Github"} className={cn(connect.isPending && "animate-spin")} aria-hidden />
            {connect.isPending ? "Getting your code…" : "Connect GitHub"}
          </Cta>
        )}
        {!connected && (
          <Note><button type="button" className={LINK} onClick={() => { track("github", "skipped"); next(); }}>Skip this step</button> if you only use public repos.</Note>
        )}
      </div>
    </>
  );
}

function ProjectStep({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const setProjectId = useSetRootComposeProjectId();
  const quickCreate = useQuickCreateProjectController();
  const { canUseNativeFolderPicker, clientHostId, hostId } = usePathPickerHost();
  const { localHostId } = useHostDaemon();
  const importBb = useImportBb();
  const add = useMutation({
    mutationFn: async () => {
      const folder = hostId && clientHostId ? (await sdk.hosts.pickFolder({ hostId, clientHostId })).path : null;
      if (!folder || !hostId) return null;
      return createProject.mutateAsync({ name: deriveProjectNameFromPath(folder), source: { type: "local_path", hostId, path: folder } });
    },
    onSuccess: (project) => {
      if (!project) return;
      track("project", "done", "folder");
      setProjectId(project.id);
      selectCloudForNewThreads();
      void navigate(getRootComposeRoutePath());
      close();
    },
    onError: (error) => appToast.error(error.message),
  });
  const addFolder = () => {
    if (canUseNativeFolderPicker) return add.mutate();
    selectCloudForNewThreads();
    track("project", "started", "folder");
    close();
    quickCreate.openCreateDialog();
  };
  const bringWorkOver = () => {
    if (!localHostId) return appToast.error("This Mac is not connected yet. Try again in a moment.");
    track("project", "started", "bb_import");
    importBb.mutate(localHostId, {
      onSuccess: ({ imported }) => appToast.success(`Imported ${imported.length} BB thread${imported.length === 1 ? "" : "s"}`),
      onError: (error) => appToast.error(error.message),
    });
  };
  return (
    <>
      <Heading lead="Import your" mark="work" />
      <p className="mt-3 max-w-[560px] text-base text-(--ob-muted)">Your Claude Code and Codex chats move over with full memory. Originals stay untouched.</p>
      <div className="mt-7">
        <ImportChats onDone={() => track("project", "started", "chat_import")} />
      </div>
      <p className="mt-9 text-[13.5px] text-(--ob-muted)">
        Don’t use Claude Code or Codex yet?{" "}
        <button type="button" className={QUIET_LINK} onClick={() => { track("project", "skipped"); close(); }}>Start empty</button>
        {" or "}
        <button type="button" className={QUIET_LINK} disabled={add.isPending} onClick={addFolder}>{add.isPending ? "opening a folder…" : "open a folder"}</button>.
        <span aria-hidden className="mx-2 text-(--ob-dash)">·</span>
        <button type="button" className={QUIET_LINK} disabled={importBb.isPending} onClick={bringWorkOver}>
          {importBb.isPending ? "Bringing your BB threads over…" : "Coming from BB?"}
        </button>
      </p>
    </>
  );
}
