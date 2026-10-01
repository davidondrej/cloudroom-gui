import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ClaudeConnectionButton, useClaudeConnection } from "@/components/ClaudeConnection";
import { openCodexConnection } from "@/components/CodexConnectionPanel";
import { selectCloudForNewThreads } from "@/components/promptbox/NewThreadComposer";
import { BbLogo } from "@/components/ui/bb-logo";
import { appToast } from "@/components/ui/app-toast";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { useCloudroomAccount, useCloudroomSignIn, useImportBb, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { booleanLocalStorage } from "@/lib/browser-storage";
import { MACOS_APP_REGION_NO_DRAG_CLASS, MACOS_WINDOW_DRAG_CLASS } from "@/lib/bb-desktop";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const dismissedAtom = atomWithStorage("cloudroom.setup.dismissed", false, booleanLocalStorage, { getOnInit: true });
const openAtom = atom(false);
export const useOpenSetup = () => useSetAtom(openAtom);

const STEPS = ["Create account", "Connect an agent", "Connect GitHub", "Pick a project"];
const LATER = ["Free", "Claude Code or Codex", "For private repos", "Last step"];
const PALETTE = {
  "--ob-bg": "#faf7ef", "--ob-rail": "#f2ecde", "--ob-card": "#fffdf7", "--ob-line": "#e2dac6", "--ob-dash": "#c9bfa6",
  "--ob-ink": "#29251e", "--ob-muted": "#7a7263", "--ob-lime": "#bfff00", "--ob-ok": "#4d6b00",
} as CSSProperties;

export function useSetupProgress() {
  const account = useCloudroomAccount();
  const accountId = account.data?.account?.id;
  const ready = account.data?.ready === true;
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId));
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: Boolean(accountId) && ready,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
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
  return { account, ready, agents, github, done, complete: done.every(Boolean), checking: account.isPending };
}

export function Onboarding() {
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const [open, setOpen] = useAtom(openAtom);
  const projects = useSidebarNavigation().data?.projects;
  const visible = open || (!dismissed && projects !== undefined && projects.length === 0);
  if (!visible) return null;
  return <Setup close={() => { setDismissed(true); setOpen(false); }} />;
}

function Setup({ close }: { close: () => void }) {
  const progress = useSetupProgress();
  const { done, account } = progress;
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
        <main className="relative flex min-w-0 flex-1 items-center overflow-y-auto px-[110px] py-10">
          <button type="button" onClick={close} className={cn("absolute top-5 right-6 flex items-center gap-1.5 text-[13px] text-(--ob-muted) hover:text-(--ob-ink)", MACOS_APP_REGION_NO_DRAG_CLASS)}>
            {signedIn ? "Skip setup" : "Use without an account"}
            <Icon name="X" className="size-3" aria-hidden />
          </button>
          <div key={step} className="w-full max-w-[600px] duration-300 animate-in fade-in-0 slide-in-from-bottom-1">
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

const Lede = ({ children }: { children: ReactNode }) => <p className="mt-3 max-w-[520px] text-base text-(--ob-muted)">{children}</p>;
const Note = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-(--ob-muted)">{children}</p>;
const LINK = "text-(--ob-ink) underline underline-offset-[3px] disabled:opacity-50";

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

function Outline({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("inline-flex h-9 shrink-0 items-center gap-2 border border-(--ob-ink) bg-(--ob-card) px-4 text-[13.5px] font-medium hover:bg-(--ob-bg) disabled:opacity-50", className)}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ on, logo, name, detail, children }: { on?: boolean; logo: ReactNode; name: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-4 border bg-(--ob-card) px-[22px] py-[18px]", on ? "border-(--ob-ink)" : "border-(--ob-line)")}>
      <span className="grid size-11 shrink-0 place-items-center">{logo}</span>
      <span className="min-w-0 flex-1">
        <b className="block text-base font-semibold">{name}</b>
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
  return (
    <>
      <Heading lead="Create your" mark="account" />
      <Lede>It's free. It unlocks cloud agents that keep working when your laptop is closed.</Lede>
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
        <div className="mt-8 flex max-w-[420px] flex-col gap-3">
          <Cta className="w-full" onClick={() => signIn.mutate("github")}><Icon name="Github" aria-hidden />Continue with GitHub</Cta>
          <Outline className="h-12 w-full justify-center text-[15.5px] font-semibold" onClick={() => signIn.mutate("google")}><GoogleLogo />Continue with Google</Outline>
          <Note>Opens your browser, then brings you right back. <button type="button" className={LINK} onClick={() => signIn.mutate("email")}>Use email instead</button></Note>
        </div>
      )}
    </>
  );
}

function AgentStep({ progress, next }: { progress: ReturnType<typeof useSetupProgress>; next: () => void }) {
  const { account, agents, ready } = progress;
  const { localHostId } = useHostDaemon();
  const claudeLocal = useClaudeConnection({ target: "local", hostId: localHostId });
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
      if (result.state === "waiting") openCodexConnection();
      else if (result.state !== "connected") throw new Error(result.message ?? "Codex could not connect. Try again.");
    },
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-codex-auth"] }),
  });
  const finish = useMutation({ mutationFn: saveChoices, onSuccess: next, onError: (error) => appToast.error(error.message) });
  const ClaudeIcon = getProviderIconInfo("agent", "claude-code").icon;
  const CodexIcon = getProviderIconInfo("agent", "codex").icon;
  const waiting = !account.data?.account ? "Log in first" : !ready ? "Starting your cloud…" : null;
  const action = (connected: boolean, button: ReactNode) => (connected ? <Connected /> : waiting ? <Note>{waiting}</Note> : button);
  return (
    <>
      <Heading lead="Connect an" mark="agent" />
      <Lede>Use the Claude or ChatGPT plan you already pay for. One is enough.</Lede>
      <div className="mt-8 flex flex-col gap-3">
        <Card on={agents.claude} logo={<span className="grid size-11 place-items-center bg-[#f4e4d6]"><ClaudeIcon className="size-6" /></span>} name="Claude Code" detail={claudeLocal.data?.state === "connected" ? "Found on this Mac" : "Uses your Claude plan"}>
          {action(agents.claude, <ClaudeConnectionButton target="cloud" presentation="inline" />)}
        </Card>
        <Card on={agents.codex} logo={<span className="grid size-11 place-items-center bg-black text-white"><CodexIcon className="size-6" /></span>} name="Codex" detail={account.data?.localLogins?.codex ? "Found on this Mac" : "Uses your ChatGPT plan"}>
          {action(agents.codex, <Outline disabled={connectCodex.isPending} onClick={() => connectCodex.mutate()}>{connectCodex.isPending ? "Connecting…" : "Connect"}</Outline>)}
        </Card>
      </div>
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

function Choice({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-(--ob-ink)" />
      <span className="font-medium">{label}</span>
      <span className="text-(--ob-muted)">{detail}</span>
    </label>
  );
}

function GithubStep({ progress, next }: { progress: ReturnType<typeof useSetupProgress>; next: () => void }) {
  const { github, account, ready } = progress;
  const client = useQueryClient();
  const requestId = useRef<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  const connect = useMutation({
    mutationFn: async () => {
      requestId.current = crypto.randomUUID();
      const result = await sdk.cloudroom.githubLogin(requestId.current);
      if (result.state === "waiting" && result.verification_url) {
        if (new URL(result.verification_url).origin !== "https://github.com") throw new Error("Unexpected GitHub sign-in page.");
        if (result.user_code) await navigator.clipboard?.writeText(result.user_code).catch(() => undefined);
        openUrlInExternalBrowser(result.verification_url);
      } else if (result.state !== "connected") throw new Error(result.message ?? "GitHub could not connect. Try again.");
    },
    onError: (error) => appToast.error(error.message),
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => sdk.cloudroom.cancelGithubLogin(requestId.current ?? github.data?.login_id ?? ""),
    onSettled: refresh,
  });
  const state = github.data?.state;
  const connected = state === "connected";
  const code = state === "waiting" ? github.data?.user_code : null;
  const detail = connected
    ? "Cloud agents can use your repos."
    : !account.data?.account ? "Log in first" : !ready ? "Starting your cloud…" : "Not found on this Mac. Connecting opens github.com.";
  return (
    <>
      <Heading lead="Connect" mark="GitHub" />
      <Lede>So cloud agents can clone, commit, and push to your private repos.</Lede>
      <div className="mt-8">
        <Card on={connected} logo={<span className="grid size-11 place-items-center bg-black text-white"><Icon name="Github" className="size-6" aria-hidden /></span>} name="GitHub" detail={detail}>
          {connected && <Connected />}
        </Card>
      </div>
      {code && (
        <div className="mt-3 flex items-center gap-4 border border-dashed border-(--ob-dash) bg-(--ob-card) px-[22px] py-4">
          <span className="font-mono text-2xl font-semibold tracking-[0.2em]">{code}</span>
          <Note>Enter this code on github.com. We copied it for you.</Note>
          <Outline className="ml-auto" onClick={() => void copyToClipboardWithToast(code, { successMessage: "Code copied." })}><Icon name="Copy" className="size-3.5" aria-hidden />Copy</Outline>
        </div>
      )}
      <div className="mt-8 flex items-center gap-5">
        {connected ? (
          <Cta onClick={next}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        ) : code ? (
          <Cta disabled><Icon name="Loading" className="animate-spin" aria-hidden />Waiting for GitHub…</Cta>
        ) : (
          <Cta disabled={!ready || connect.isPending} onClick={() => connect.mutate()}><Icon name="Github" aria-hidden />Connect GitHub</Cta>
        )}
        {code ? (
          <Note><button type="button" className={LINK} onClick={() => cancel.mutate()}>Cancel</button></Note>
        ) : !connected && (
          <Note><button type="button" className={LINK} onClick={next}>Skip this step</button> if you only use public repos.</Note>
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
  const projects = useSidebarNavigation().data?.projects ?? [];
  const repos = useQuery({ queryKey: ["cloudroom-local-repos"], queryFn: ({ signal }) => sdk.cloudroom.localRepos(signal), retry: false, staleTime: 60_000 });
  const { localHostId } = useHostDaemon();
  const importBb = useImportBb();
  const open = (projectId: string) => {
    setProjectId(projectId);
    selectCloudForNewThreads();
    void navigate(getRootComposeRoutePath());
    close();
  };
  const add = useMutation({
    mutationFn: async (path: string | null) => {
      const folder = path ?? (hostId && clientHostId ? (await sdk.hosts.pickFolder({ hostId, clientHostId })).path : null);
      if (!folder || !hostId) return null;
      return createProject.mutateAsync({ name: deriveProjectNameFromPath(folder), source: { type: "local_path", hostId, path: folder } });
    },
    onSuccess: (project) => { if (project) open(project.id); },
    onError: (error) => appToast.error(error.message),
  });
  const addFolder = () => {
    if (canUseNativeFolderPicker) return add.mutate(null);
    selectCloudForNewThreads();
    close();
    quickCreate.openCreateDialog();
  };
  const bringWorkOver = () => {
    if (!localHostId) return appToast.error("This Mac is not connected yet. Try again in a moment.");
    importBb.mutate(localHostId, {
      onSuccess: ({ imported }) => appToast.success(`Imported ${imported.length} BB thread${imported.length === 1 ? "" : "s"}`),
      onError: (error) => appToast.error(error.message),
    });
  };
  const names = new Set(projects.map((project) => project.name.toLowerCase()));
  const found = (repos.data?.repos ?? []).filter((repo) => !names.has(deriveProjectNameFromPath(repo.path).toLowerCase())).slice(0, Math.max(0, 5 - projects.length));
  const busy = add.isPending;
  return (
    <>
      <Heading lead="Pick your first" mark="project" />
      <Lede>Choose what your agents work on. You can add more projects anytime.</Lede>
      <div className="mt-7 flex flex-col gap-2">
        {projects.slice(0, 5).map((project) => (
          <ProjectRow key={project.id} name={project.name} detail="Already in Cloudroom" disabled={busy} onClick={() => open(project.id)} />
        ))}
        {found.map((repo) => (
          <ProjectRow key={repo.path} name={repo.name} detail={repo.path.replace(/^\/Users\/[^/]+/, "~")} disabled={busy} onClick={() => add.mutate(repo.path)} />
        ))}
        {repos.isPending && <Note>Looking for projects on this Mac…</Note>}
        <button type="button" disabled={busy} onClick={addFolder} className="flex items-center gap-3.5 border border-(--ob-line) bg-(--ob-card) px-4 py-3 text-left text-[14.5px] font-medium hover:border-(--ob-ink) disabled:opacity-50">
          <Icon name={busy ? "Loading" : "FolderPlus"} className={cn("size-4", busy && "animate-spin")} aria-hidden />
          {busy ? "Adding your project…" : "Choose another folder"}
        </button>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Note><button type="button" className={LINK} onClick={close}>Start without a project</button></Note>
        <Note>
          <button type="button" className={LINK} disabled={importBb.isPending} onClick={bringWorkOver}>
            {importBb.isPending ? "Bringing your work over…" : "Coming from BB? Bring your work over."}
          </button>
        </Note>
      </div>
    </>
  );
}

function ProjectRow({ name, detail, disabled, onClick }: { name: string; detail: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="group flex items-center gap-3.5 border border-(--ob-line) bg-(--ob-card) px-4 py-3 text-left hover:border-(--ob-ink) hover:shadow-[inset_3px_0_0_var(--ob-lime)] disabled:opacity-50">
      <Icon name="Folder" className="size-4 shrink-0 text-(--ob-muted)" aria-hidden />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[14.5px] font-semibold">{name}</b>
        <span className="block truncate font-mono text-xs text-(--ob-muted)">{detail}</span>
      </span>
      <Icon name="ArrowRight" className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
    </button>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M21.805 10.023H12v3.954h5.608c-.242 1.272-.975 2.35-2.077 3.073v2.555h3.364c1.969-1.813 3.105-4.484 3.105-7.655 0-.671-.06-1.314-.195-1.927Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.964-.895 6.618-2.395l-3.364-2.555c-.931.625-2.124 1.005-3.254 1.005-2.609 0-4.823-1.76-5.614-4.125H2.932v2.636A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.386 13.93a6.007 6.007 0 0 1 0-3.86V7.434H2.932a10 10 0 0 0 0 9.132l3.454-2.636Z" />
      <path fill="#EA4335" d="M12 5.945c1.475 0 2.795.509 3.836 1.504l2.877-2.877C16.964 2.945 14.7 2 12 2a10 10 0 0 0-9.068 5.434l3.454 2.636C7.177 7.705 9.391 5.945 12 5.945Z" />
    </svg>
  );
}
