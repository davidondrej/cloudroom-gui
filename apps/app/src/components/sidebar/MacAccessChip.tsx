import type { MacAccessLevel } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";

const LEVELS: { id: MacAccessLevel; label: string; description: string; icon: string; text: string; chip: string }[] = [
  { id: "off", label: "Off", description: "Cloud agents can't touch this Mac.", icon: "Unavailable", text: "text-muted-foreground", chip: "bg-muted-foreground/10" },
  { id: "read-only", label: "Read-only", description: "Read files and logs. No changes.", icon: "Eye", text: "text-sky-400", chip: "bg-sky-400/15" },
  { id: "ask", label: "Ask first", description: "Changes need your one-tap OK.", icon: "SecurityCheck", text: "text-warning", chip: "bg-warning/15" },
  { id: "full", label: "Full", description: "Run anything, like you would.", icon: "Zap", text: "text-success dark:text-primary", chip: "bg-success/15 dark:bg-primary/15" },
];

export function MacAccessMenu({ withLabel = false }: { withLabel?: boolean }) {
  const status = useCloudroomAccount();
  const macAccess = useSetMacAccess();
  const pending = macAccess.isPending ? macAccess.variables : undefined;
  const saved = status.data?.macAccessLevel ?? (status.data?.macAccess ? "full" : "off");
  const id = pending === undefined ? saved : pending === true ? "full" : pending === false ? "off" : pending;
  const current = LEVELS.find((level) => level.id === id) ?? LEVELS[0]!;
  const select = (level: (typeof LEVELS)[number]) => {
    if (level === current) return;
    macAccess.mutate(level.id, {
      onSuccess: () => appToast.success(`Mac access: ${level.label}`),
      onError: (error) => appToast.error(error.message),
    });
  };
  return <DropdownMenu>
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={cn("h-8 gap-1 rounded-lg px-2 hover:opacity-90 [&_[data-icon-root]]:size-4", current.text, current.chip)} aria-label={`Mac access: ${current.label}`} disabled={macAccess.isPending}>
            <Icon name={current.icon} aria-hidden />
            {withLabel && <span className="text-sm">{current.label}</span>}
            <Icon name="ChevronUp" className="!size-3 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="top">Mac access: {current.label}</TooltipContent>
    </Tooltip>
    <DropdownMenuContent side="top" align="end" sideOffset={6} mobileTitle="Mac access" className="w-72 p-1.5">
      <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">Mac access</DropdownMenuLabel>
      {LEVELS.map((level) => {
        const selected = level === current;
        return <DropdownMenuItem key={level.id} role="menuitemradio" aria-checked={selected} className={cn("items-start gap-2.5 py-2", selected && "bg-state-hover")} onSelect={() => select(level)}>
          <Icon name={level.icon} className={cn("mt-0.5", level.text)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">{level.label}</span>
            <span className="block text-xs text-muted-foreground">{level.description}</span>
          </span>
          {selected && <Icon name="Check" className="mt-0.5 text-foreground" aria-hidden />}
        </DropdownMenuItem>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function MacAccessChip() {
  const status = useCloudroomAccount();
  if (!status.data?.account) return null;
  return <SidebarMenuItem data-footer-item="mac-access"><MacAccessMenu /></SidebarMenuItem>;
}
