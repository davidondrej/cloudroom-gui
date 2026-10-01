import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useStartingMachine,
  type StartingMachine,
} from "@/hooks/useStartingMachine";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "./settings-dropdown";

const STARTING_MACHINE_OPTIONS: ReadonlyArray<{
  label: string;
  value: StartingMachine;
}> = [
  { label: "Cloud", value: "cloud" },
  { label: "Last used", value: "last" },
];

export function DefaultsSettingsSection() {
  const [startingMachine, setStartingMachine] = useStartingMachine();
  return (
    <SettingsSection title="Defaults">
      <SettingsWithControl
        label="Starting machine"
        description="Where new threads run when you open the composer."
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
              aria-label="Starting machine"
            >
              {startingMachine === "cloud" ? "Cloud" : "Last used"}
              <Icon
                name="ChevronDown"
                className="size-3.5 text-muted-foreground"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className={SETTINGS_DROPDOWN_CONTENT_CLASS}
          >
            {STARTING_MACHINE_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => setStartingMachine(option.value)}
              >
                {option.label}
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto",
                    startingMachine !== option.value && "opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingsWithControl>
    </SettingsSection>
  );
}
