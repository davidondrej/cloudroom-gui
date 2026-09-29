import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { AgentSetup, useAgentConnections } from "@/components/AgentSetup";
import { BbLogo } from "@/components/ui/bb-logo";
import { appToast } from "@/components/ui/app-toast";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useCloudroomAccount, useCloudroomSignIn, useImportBb } from "@/hooks/queries/cloudroom-queries";

interface RootComposeEmptyWelcomeProps {
  onCompose: () => void;
}

const STEPS = ["Log in", "Connect agents", "Start a thread"];
const LINK_CLASS = "text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50";

export function RootComposeEmptyWelcome({ onCompose }: RootComposeEmptyWelcomeProps) {
  const account = useCloudroomAccount();
  const signIn = useCloudroomSignIn();
  const { anyConnected } = useAgentConnections();
  const { localHostId } = useHostDaemon();
  const importBb = useImportBb();
  const bringWorkOver = () => {
    if (importBb.isPending) return;
    if (!localHostId) return appToast.error("This Mac is not connected yet. Try again in a moment.");
    importBb.mutate(localHostId, {
      onSuccess: ({ imported, skipped }) =>
        appToast.success(`Imported ${imported.length} BB thread${imported.length === 1 ? "" : "s"}`, {
          description: skipped.length ? skipped.map((thread) => `${thread.title}: ${thread.reason}`).join(" · ") : undefined,
        }),
      onError: (error) => appToast.error(error.message),
    });
  };
  const email = account.data?.account?.email;
  const signingIn = account.data?.signingIn === true || signIn.isPending;
  if (account.isPending) return null;
  return (
    <div className="flex w-full max-w-lg flex-col items-center text-center duration-500 animate-in fade-in-0 slide-in-from-bottom-2">
      <div role="img" aria-label="Cloudroom" className={cn("select-none", email ? "size-14" : "size-20")}>
        <BbLogo className="size-full" />
      </div>
      {email ? (
        <>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">Connect your agents</h1>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Signed in as {email}. Use the subscriptions you already pay for, on this computer and in the cloud.
          </p>
          <AgentSetup className="mt-8 w-full" />
          <Button
            size="lg"
            variant={anyConnected ? "default" : "outline"}
            className={cn("mt-8 h-11 rounded-full px-10 text-base", anyConnected && "bb-beam")}
            onClick={() => onCompose()}
          >
            <Icon name="MessageSquarePlus" aria-hidden />
            New thread
          </Button>
          <button type="button" className={cn(LINK_CLASS, "mt-4")} disabled={importBb.isPending} onClick={bringWorkOver}>
            {importBb.isPending ? "Bringing your work over…" : "Coming from BB? Bring your work over. Uses no tokens."}
          </button>
        </>
      ) : (
        <>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight">Welcome to Cloudroom</h1>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Run agents in the cloud with the subscriptions you already pay for. They keep working when your laptop is closed.
          </p>
          <Button size="lg" className="bb-beam mt-10 h-11 w-56 rounded-full text-base" disabled={signingIn} onClick={() => signIn.mutate(false)}>
            {signingIn ? (
              <>
                <Icon name="Loading" className="animate-spin" aria-hidden />
                Waiting for your browser…
              </>
            ) : (
              "Log in"
            )}
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">
            {signingIn ? (
              <>
                Finish logging in in your browser.{" "}
                <button type="button" className={LINK_CLASS} onClick={() => signIn.mutate(true)}>
                  Cancel
                </button>
              </>
            ) : (
              "Opens your browser. New here? Create your account there."
            )}
          </p>
        </>
      )}
      <Steps current={!email ? 0 : anyConnected ? 2 : 1} />
      {!email && (
        <button type="button" className={cn(LINK_CLASS, "mt-6")} onClick={() => onCompose()}>
          Continue without an account
        </button>
      )}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="Setup steps" className="mt-12 flex items-center gap-2 text-xs text-muted-foreground">
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden className={cn("h-px w-6", index <= current ? "bg-primary/40" : "bg-border")} />}
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[10px] font-medium",
              index < current ? "border-primary/40 text-primary" : index === current ? "border-foreground/60 text-foreground" : "border-border",
            )}
          >
            {index < current ? <Icon name="Check" className="size-3" aria-label="Done" /> : index + 1}
          </span>
          <span className={cn(index === current && "text-foreground")}>{label}</span>
        </li>
      ))}
    </ol>
  );
}
