import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutoDeleteDays } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { sdk } from "@/lib/sdk";
import { Card, errorText } from "./CloudEnvironmentSettingsSection";
import { SETTINGS_DROPDOWN_CONTENT_CLASS, SETTINGS_DROPDOWN_TRIGGER_CLASS } from "./settings-dropdown";

const KEY = ["cloudroom-auto-delete"];
const OPTIONS: { days: AutoDeleteDays; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: null, label: "Never" },
];

export function AutoDeleteSettingsSection() {
  const queryClient = useQueryClient();
  const setting = useQuery({ queryKey: KEY, queryFn: ({ signal }) => sdk.cloudroom.autoDelete(signal), retry: false });
  const save = useMutation({
    mutationFn: (days: AutoDeleteDays) => sdk.cloudroom.setAutoDelete(days),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });
  const days = setting.data?.days;
  const problem = errorText(setting.error ?? save.error);

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold text-foreground">Auto-delete</h2>
      <Card
        icon="Clock"
        title="Delete unused cloud threads after"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                disabled={!setting.data || save.isPending}
                aria-label="Delete unused cloud threads after"
              >
                {OPTIONS.find((option) => option.days === days)?.label ?? "…"}
                <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
              {OPTIONS.map((option) => (
                <DropdownMenuItem key={option.label} onSelect={() => save.mutate(option.days)}>
                  {option.label}
                  <Icon name="Check" className={cn("ml-auto size-3.5", option.days !== days && "opacity-0")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive-text">
          {problem}
        </p>
      )}
    </div>
  );
}
