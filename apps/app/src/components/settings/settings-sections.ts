import type { IconName } from "@bb/shared-ui/icon";
import {
  SETTINGS_ROUTE_PATH,
  getPluginConfigurationRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";
import type { PluginSettingsEntry } from "./plugin-settings-entries";

export const SETTINGS_NAV_SECTIONS = [
  { icon: "Settings", id: "general", label: "General" },
  { icon: "Star", id: "defaults", label: "Defaults" },
  { icon: "Cloud", id: "cloud-environment", label: "Cloud environment" },
  { icon: "Bot", id: "providers", label: "Providers" },
  { icon: "Download", id: "import", label: "Import chats" },
  { icon: "Palette", id: "appearance", label: "Appearance" },
  { icon: "SlidersHorizontal", id: "keyboard", label: "Keyboard" },
  { icon: "Browser", id: "browser", label: "Browser" },
  { icon: "File", id: "files", label: "Files" },
  { icon: "FolderGit", id: "projects", label: "Projects" },
  { icon: "Laptop", id: "machines", label: "Machines" },
  { icon: "PackageReceive", id: "updates", label: "Updates" },
  { icon: "ElectricPlugs", id: "plugins", label: "Installed plugins" },
  { icon: "Puzzle", id: "marketplaces", label: "Plugin marketplaces" },
  { icon: "Lock", id: "command-guard", label: "Command Guard" },
  { icon: "Bot", id: "system-prompt", label: "System prompt" },
  { icon: "Beaker", id: "experiments", label: "Experiments" },
  { icon: "MessageSquare", id: "community", label: "Community" },
  { icon: "Archive", id: "archived", label: "Archived threads" },
] as const satisfies readonly {
  icon: IconName;
  id: string;
  label: string;
}[];

export type SettingsNavSection = (typeof SETTINGS_NAV_SECTIONS)[number];

export type SettingsSectionId = SettingsNavSection["id"];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_NAV_SECTIONS.some((section) => section.id === value);
}

export function getSettingsSectionRoutePath(
  sectionId: SettingsSectionId,
): string {
  return sectionId === "general"
    ? SETTINGS_ROUTE_PATH
    : getSettingsRoutePath(sectionId);
}

type SettingsGroupMember =
  | { kind: "section"; id: SettingsSectionId; label?: string }
  | { kind: "plugin"; id: string; label: string };

export interface SettingsNavGroup {
  icon: IconName;
  id: string;
  keywords: string;
  label: string;
  members: readonly SettingsGroupMember[];
}

export interface SettingsNavLink {
  active: boolean;
  key: string;
  label: string;
  to: string;
}

interface SettingsNavLinkState {
  activePluginId: string | null;
  activeSection: SettingsSectionId | null;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

const section = (id: SettingsSectionId, label?: string): SettingsGroupMember =>
  ({ kind: "section", id, label });
const plugin = (id: string, label: string): SettingsGroupMember =>
  ({ kind: "plugin", id, label });

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    icon: "Settings",
    id: "general",
    keywords: "threads editing links localhost git branch skills naming voice privacy telemetry feedback streamer diagnostics sleep",
    label: "General",
    members: [
      section("general"),
      section("browser"),
      section("files"),
      plugin("push-notifications", "Notifications"),
      plugin("keep-awake", "Keep Awake"),
    ],
  },
  {
    icon: "Bot",
    id: "agents",
    keywords: "claude code codex pi acp models limits",
    label: "Agents",
    members: [
      section("providers"),
      section("defaults"),
      plugin("provider-claude-code", "Claude Code"),
      plugin("provider-codex", "Codex"),
      plugin("provider-acp", "ACP"),
      plugin("provider-usage", "Usage"),
      plugin("provider-retry", "Retry"),
    ],
  },
  {
    icon: "Edit",
    id: "instructions",
    keywords: "prompt skills agents.md",
    label: "Instructions",
    members: [
      plugin("custom-instructions", "Custom instructions"),
      section("system-prompt"),
      plugin("bb-guide", "Cloudroom guide"),
    ],
  },
  {
    icon: "Cloud",
    id: "cloud",
    keywords: "github repos api keys secrets setup script sandbox",
    label: "Cloud",
    members: [section("cloud-environment")],
  },
  {
    icon: "Laptop",
    id: "machines",
    keywords: "account sign in mac access ssh remote phone gh_token environment",
    label: "Machines",
    members: [section("machines"), plugin("connect", "Cloudroom Connect")],
  },
  {
    icon: "FolderGit",
    id: "projects",
    keywords: "restore",
    label: "Projects",
    members: [section("projects"), section("import"), section("archived")],
  },
  {
    icon: "Palette",
    id: "appearance",
    keywords: "theme dark light colors sidebar corners favicon",
    label: "Appearance",
    members: [section("appearance")],
  },
  {
    icon: "SlidersHorizontal",
    id: "keyboard",
    keywords: "shortcuts hotkeys",
    label: "Keyboard",
    members: [section("keyboard")],
  },
  {
    icon: "ElectricPlugs",
    id: "plugins",
    keywords: "extensions",
    label: "Plugins",
    members: [
      section("plugins", "Installed"),
      section("marketplaces", "Marketplaces"),
    ],
  },
  {
    icon: "PackageReceive",
    id: "updates",
    keywords: "version changelog daemon provider cli github website",
    label: "Updates",
    members: [section("updates"), section("community")],
  },
  {
    icon: "Toolbox",
    id: "advanced",
    keywords: "safety beta",
    label: "Advanced",
    members: [section("command-guard"), section("experiments")],
  },
];

export function findSettingsNavGroup(
  activeSection: SettingsSectionId | null,
  activePluginId: string | null,
): SettingsNavGroup {
  const group = SETTINGS_NAV_GROUPS.find((candidate) =>
    candidate.members.some((member) =>
      activePluginId !== null
        ? member.kind === "plugin" && member.id === activePluginId
        : member.kind === "section" && member.id === activeSection,
    ),
  );
  const fallbackId = activePluginId !== null ? "plugins" : "general";
  return (
    group ?? SETTINGS_NAV_GROUPS.find((candidate) => candidate.id === fallbackId)!
  );
}

export function getSettingsGroupLinks(
  group: SettingsNavGroup,
  state: SettingsNavLinkState,
): SettingsNavLink[] {
  const links = group.members.flatMap((member): SettingsNavLink[] => {
    if (member.kind === "section") {
      const available = state.sections.find((entry) => entry.id === member.id);
      return available
        ? [
            {
              active:
                state.activePluginId === null &&
                state.activeSection === member.id,
              key: member.id,
              label: member.label ?? available.label,
              to: getSettingsSectionRoutePath(member.id),
            },
          ]
        : [];
    }
    return state.pluginEntries.some((entry) => entry.id === member.id)
      ? [
          {
            active: state.activePluginId === member.id,
            key: member.id,
            label: member.label,
            to: getPluginConfigurationRoutePath({ pluginId: member.id }),
          },
        ]
      : [];
  });
  const activePluginId = state.activePluginId;
  if (
    group.id === "plugins" &&
    activePluginId !== null &&
    !links.some((link) => link.active)
  ) {
    const entry = state.pluginEntries.find(({ id }) => id === activePluginId);
    links.push({
      active: true,
      key: activePluginId,
      label: entry?.label ?? activePluginId,
      to: getPluginConfigurationRoutePath({ pluginId: activePluginId }),
    });
  }
  return links;
}

export function matchesSettingsSearch(
  group: SettingsNavGroup,
  links: readonly SettingsNavLink[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [group.label, group.keywords, ...links.map((link) => link.label)]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
