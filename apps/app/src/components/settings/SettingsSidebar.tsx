import { type MouseEvent as ReactMouseEvent, useId, useState } from "react";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarActionRow,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import {
  getSettingsSectionRoutePath,
  type SettingsNavSection,
  type SettingsSectionId,
} from "./settings-sections";
import type { PluginSettingsEntry } from "./plugin-settings-entries";

const VISIBLE_SECTIONS = new Set<SettingsSectionId>([
  "general",
  "providers",
  "appearance",
  "keyboard",
  "machines",
  "updates",
  "plugins",
]);

const VISIBLE_PLUGINS = new Set([
  "bb-guide",
  "provider-claude-code",
  "provider-codex",
  "concurrency-limit",
  "custom-instructions",
  "keep-awake",
  "provider-retry",
  "provider-usage",
  "connect",
]);

interface SettingsSidebarProps {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  mobileHosted?: boolean;
}

type SettingsSidebarNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

interface SettingsSidebarContentProps extends SettingsSidebarProps {
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  mobileHosted,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const { activePluginId, activeSection, pluginEntries, sections } = navigation;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const visiblePlugins = pluginEntries.filter((entry) =>
    VISIBLE_PLUGINS.has(entry.id),
  );
  const advancedSections = sections.filter(
    (section) => section.id !== "archived" && !VISIBLE_SECTIONS.has(section.id),
  );
  const advancedPlugins = pluginEntries.filter(
    (entry) => !VISIBLE_PLUGINS.has(entry.id),
  );
  const hasNativeSettings = canOpenNativeScreen();
  const hasAdvanced =
    advancedSections.length > 0 ||
    advancedPlugins.length > 0 ||
    hasNativeSettings;

  const renderSection = (section: SettingsNavSection) => (
    <SectionSidebarRow
      key={section.id}
      active={activeSection === section.id}
      label={section.label}
      to={getSettingsSectionRoutePath(section.id)}
    >
      <SectionSidebarIcon name={section.icon} />
    </SectionSidebarRow>
  );

  const renderPlugin = (entry: PluginSettingsEntry) => (
    <SectionSidebarRow
      key={entry.id}
      active={activePluginId === entry.id}
      label={entry.label}
      to={getPluginConfigurationRoutePath({ pluginId: entry.id })}
    >
      <PluginIcon
        pluginId={entry.id}
        icon={entry.icon}
        className="size-4 shrink-0"
      />
    </SectionSidebarRow>
  );

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix={testIdPrefix}
    >
      <SectionSidebarLabel>Settings</SectionSidebarLabel>
      <div className="mt-1 space-y-0.5">
        {sections
          .filter((section) => VISIBLE_SECTIONS.has(section.id))
          .map(renderSection)}
      </div>
      {visiblePlugins.length > 0 ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Plugins</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {visiblePlugins.map(renderPlugin)}
          </div>
        </>
      ) : null}
      {sections.some((section) => section.id === "archived") ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Archived</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {sections
              .filter((section) => section.id === "archived")
              .map(renderSection)}
          </div>
        </>
      ) : null}
      {hasAdvanced ? (
        <div className="mt-4">
          <SectionSidebarLabel>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
              onClick={() => setAdvancedOpen((open) => !open)}
              className="cursor-pointer rounded-sm focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Advanced
            </button>
          </SectionSidebarLabel>
          <div
            id={advancedId}
            hidden={!advancedOpen}
            className="mt-1 space-y-0.5"
          >
            {advancedSections.map(renderSection)}
            {advancedPlugins.map(renderPlugin)}
            {hasNativeSettings ? (
              <SectionSidebarActionRow
                label="This device"
                testId="settings-nav-native-device"
                onClick={() => shellOpenNative("device-settings")}
              >
                <SectionSidebarIcon name="Smartphone" />
              </SectionSidebarActionRow>
            ) : null}
          </div>
        </div>
      ) : null}
    </SectionSidebar>
  );
}

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  mobileHosted,
}: SettingsSidebarProps) {
  const navigation = useSettingsNavState();

  return (
    <SettingsSidebarContent
      appRoutePath={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
    />
  );
}
