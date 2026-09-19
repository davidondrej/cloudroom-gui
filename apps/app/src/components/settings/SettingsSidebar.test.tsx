// @vitest-environment jsdom

import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import * as nativeShell from "@/lib/native-shell";
import { SETTINGS_NAV_SECTIONS } from "./settings-sections";
import { SettingsSidebarContent } from "./SettingsSidebar";

const visiblePlugins = [
  { id: "bb-guide", label: "BB guide" },
  { id: "provider-claude-code", label: "Claude Code provider" },
  { id: "provider-codex", label: "Codex provider" },
  { id: "concurrency-limit", label: "Concurrency limit" },
  { id: "custom-instructions", label: "Custom instructions" },
  { id: "keep-awake", label: "Keep Awake" },
  { id: "provider-retry", label: "Provider retry" },
  { id: "provider-usage", label: "Provider usage" },
  { id: "connect", label: "Remote access" },
];

const advancedPlugins = [
  { id: "provider-acp", label: "ACP providers" },
  { id: "push-notifications", label: "Push notifications" },
  { id: "linear", label: "Linear" },
];

const pluginEntries = [...visiblePlugins, ...advancedPlugins].map((entry) => ({
  ...entry,
  icon: null,
}));

function renderSidebar(
  navigation: Partial<
    ComponentProps<typeof SettingsSidebarContent>["navigation"]
  > = {},
) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SettingsSidebarContent
          appRoutePath="/"
          isResizing={false}
          mobileHosted
          navigation={{
            activePluginId: null,
            activeSection: "general",
            pluginEntries,
            sections: SETTINGS_NAV_SECTIONS,
            ...navigation,
          }}
          onResizeMouseDown={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsSidebarContent navigation", () => {
  it("keeps only the requested settings, plugins, and archived threads visible", () => {
    renderSidebar();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      [
        "Back to app",
        "General",
        "Providers",
        "Appearance",
        "Keyboard",
        "Machines",
        "Updates",
        "Installed plugins",
        ...visiblePlugins.map((entry) => entry.label),
        "Archived threads",
      ],
    );
    expect(
      screen
        .getByRole("button", { name: "Advanced" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("places Advanced after Archived threads and reveals every remaining destination only on click", () => {
    renderSidebar();
    const toggle = screen.getByRole("button", { name: "Advanced" });
    const archived = screen.getByRole("link", { name: "Archived threads" });
    expect(
      archived.compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panelId = toggle.getAttribute("aria-controls")!;
    const panel = document.getElementById(panelId)!;
    expect(
      within(panel)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Browser",
      "Files",
      "Projects",
      "Plugin marketplaces",
      "Experiments",
      "Community",
      ...advancedPlugins.map((entry) => entry.label),
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(
      1 + SETTINGS_NAV_SECTIONS.length + pluginEntries.length,
    );
    expect(
      screen.getByRole("link", { name: "Projects" }).getAttribute("href"),
    ).toBe("/settings/projects");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Linear" })).toBeNull();
    expect(screen.getByRole("link", { name: "Archived threads" })).toBeTruthy();
  });

  it("offers installed-plugin management and configurable plugin settings", () => {
    renderSidebar();
    expect(
      screen
        .getByRole("link", { name: "Installed plugins" })
        .getAttribute("href"),
    ).toBe("/settings/plugins");
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("href"),
    ).toBe("/settings/plugins/linear");
    expect(
      screen.queryByRole("button", { name: /Other installed plugins/ }),
    ).toBeNull();
    for (const entry of visiblePlugins) {
      expect(
        screen.getByRole("link", { name: entry.label }).getAttribute("href"),
      ).toBe(`/settings/plugins/${entry.id}`);
    }
  });

  it("keeps Advanced collapsed on direct plugin links and preserves the active page when opened", () => {
    renderSidebar({ activePluginId: "linear", activeSection: null });
    expect(screen.queryByRole("link", { name: "Linear" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("preserves the active built-in section inside Advanced", () => {
    renderSidebar({ activeSection: "browser" });
    expect(screen.queryByRole("link", { name: "Browser" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen
        .getByRole("link", { name: "Browser" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("does not show an empty Plugins heading or unavailable sections", () => {
    renderSidebar({
      pluginEntries: [],
      sections: SETTINGS_NAV_SECTIONS.filter(
        (section) => section.id !== "files",
      ),
    });
    expect(screen.queryByText("Plugins", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.queryByRole("link", { name: "Files" })).toBeNull();
  });

  it("matches plugins by ID rather than their configurable display names", () => {
    renderSidebar({
      pluginEntries: [
        { id: "connect", label: "Renamed remote access", icon: null },
        { id: "new-plugin", label: "BB guide", icon: null },
      ],
    });
    expect(
      screen.getByRole("link", { name: "Renamed remote access" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "BB guide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByRole("link", { name: "BB guide" }).getAttribute("href"),
    ).toBe("/settings/plugins/new-plugin");
  });

  it("keeps native device settings accessible under Advanced", () => {
    vi.spyOn(nativeShell, "canOpenNativeScreen").mockReturnValue(true);
    const openNative = vi
      .spyOn(nativeShell, "shellOpenNative")
      .mockReturnValue(true);
    renderSidebar();
    expect(screen.queryByRole("button", { name: "This device" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "This device" }));
    expect(openNative).toHaveBeenCalledWith("device-settings");
  });
});
