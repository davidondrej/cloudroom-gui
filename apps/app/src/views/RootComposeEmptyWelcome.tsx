import { Icon, type IconName } from "@bb/shared-ui/icon";
import { BbLogo } from "@/components/ui/bb-logo";
import { appToast } from "@/components/ui/app-toast";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useImportBb } from "@/hooks/queries/cloudroom-queries";

interface RootComposeEmptyWelcomeProps {
  onCompose: () => void;
}

interface WelcomeActionProps {
  icon: IconName;
  title: string;
  description: string;
  onClick: () => void;
}

function WelcomeAction({ icon, title, description, onClick }: WelcomeActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon
        name={icon}
        aria-hidden
        className="size-5 shrink-0 text-subtle-foreground group-hover:text-foreground"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

export function RootComposeEmptyWelcome({ onCompose }: RootComposeEmptyWelcomeProps) {
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
  return (
    <div className="flex flex-col items-center gap-12 duration-500 animate-in fade-in-0 slide-in-from-bottom-2">
      <div role="img" aria-label="Cloudroom" className="size-24 select-none">
        <BbLogo className="size-full" />
      </div>
      <div className="flex w-full max-w-[360px] flex-col gap-1">
        <WelcomeAction
          icon="MessageSquarePlus"
          title="New thread"
          description="Start a new conversation"
          onClick={() => onCompose()}
        />
        <WelcomeAction
          icon="FolderGit"
          title={importBb.isPending ? "Bringing your work over…" : "Bring your work over"}
          description="Copy your open BB threads. Uses no tokens."
          onClick={bringWorkOver}
        />
      </div>
    </div>
  );
}
