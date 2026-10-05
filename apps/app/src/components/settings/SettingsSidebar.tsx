import { type MouseEvent as ReactMouseEvent, type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarActionRow,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { InviteSidebarRow } from "@/components/InviteOffer";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import {
  findSettingsNavGroup,
  getSettingsGroupLinks,
  getSettingsSectionRoutePath,
  matchesSettingsSearch,
  SETTINGS_NAV_GROUPS,
} from "./settings-sections";

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
  account?: ReactNode;
  invite?: ReactNode;
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  account,
  invite,
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  mobileHosted,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const [query, setQuery] = useState("");
  const activeGroup = findSettingsNavGroup(
    navigation.activeSection,
    navigation.activePluginId,
  );
  const rows = SETTINGS_NAV_GROUPS.flatMap((group) => {
    const links = getSettingsGroupLinks(group, navigation);
    return links.length > 0 && matchesSettingsSearch(group, links, query)
      ? [{ group, to: links[0]!.to }]
      : [];
  });
  const listRows = rows.filter(({ group }) => group.id !== "advanced");
  const advancedRow = rows.find(({ group }) => group.id === "advanced");

  const footer = (
    <div className="space-y-2">
      {canOpenNativeScreen() ? (
        <SectionSidebarActionRow
          label="This device"
          testId="settings-nav-native-device"
          onClick={() => shellOpenNative("device-settings")}
        >
          <SectionSidebarIcon name="Smartphone" />
        </SectionSidebarActionRow>
      ) : null}
      {advancedRow ? (
        <SectionSidebarRow
          active={activeGroup.id === "advanced"}
          className="border border-sidebar-border"
          label="Advanced"
          to={advancedRow.to}
        >
          <SectionSidebarIcon name={advancedRow.group.icon} />
        </SectionSidebarRow>
      ) : null}
      {account}
    </div>
  );

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      footer={footer}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix={testIdPrefix}
    >
      {invite}
      <div className="relative mb-2">
        <Icon
          name="Search"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search settings"
          className="h-8 pl-8 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            const first = rows[0];
            if (event.key !== "Enter" || !first) return;
            navigate(first.to);
            setQuery("");
            closeOnMobile();
          }}
          placeholder="Search settings"
          value={query}
        />
      </div>
      <div className="space-y-0.5">
        {listRows.map(({ group, to }) => (
          <SectionSidebarRow
            key={group.id}
            active={activeGroup.id === group.id}
            label={group.label}
            to={to}
          >
            <SectionSidebarIcon name={group.icon} />
          </SectionSidebarRow>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          No settings match.
        </p>
      ) : null}
    </SectionSidebar>
  );
}

function SettingsAccountCard() {
  const status = useCloudroomAccount().data;
  const email = status?.account?.email;
  const closeOnMobile = useCloseMobileSidebar();
  return (
    <Link
      to={getSettingsSectionRoutePath("machines")}
      onClick={closeOnMobile}
      data-testid="settings-account-card"
      className="flex items-center gap-2.5 rounded-md border-t border-sidebar-border px-2 pt-3 pb-1 text-sidebar-foreground hover:bg-sidebar-accent"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {email ? email[0]!.toUpperCase() : <Icon name="UserRound" className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {email ?? "Sign in to Cloudroom"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {!email
            ? "Local threads only"
            : status?.ready
              ? "Cloud connected"
              : "Cloud unavailable"}
        </span>
      </span>
      <Icon name="ChevronRight" className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
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
      account={<SettingsAccountCard />}
      invite={<InviteSidebarRow />}
      appRoutePath={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
    />
  );
}
