// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import * as nativeShell from "@/lib/native-shell";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_SECTIONS,
} from "./settings-sections";
import { SettingsSidebarContent } from "./SettingsSidebar";

const pluginEntries = [
  "bb-guide",
  "connect",
  "custom-instructions",
  "keep-awake",
  "linear",
  "provider-acp",
  "provider-claude-code",
  "provider-codex",
  "provider-retry",
  "provider-usage",
  "push-notifications",
].map((id) => ({ id, label: id, icon: null }));

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

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
        <LocationProbe />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

const rowLabels = () =>
  screen
    .getAllByRole("link")
    .map((link) => link.textContent)
    .filter((label) => label !== "Back to app");

const currentRow = () =>
  screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsSidebarContent navigation", () => {
  it("shows one flat row per group, with Advanced last", () => {
    renderSidebar();
    expect(rowLabels()).toEqual([
      "General",
      "Agents",
      "Instructions",
      "Cloud",
      "Machines",
      "Projects",
      "Appearance",
      "Keyboard",
      "Plugins",
      "Updates",
      "Advanced",
    ]);
    expect(
      screen.getByRole("link", { name: "Instructions" }).getAttribute("href"),
    ).toBe("/settings/plugins/custom-instructions");
    expect(
      screen.getByRole("link", { name: "Advanced" }).getAttribute("href"),
    ).toBe("/settings/command-guard");
  });

  it("puts every built-in settings page in exactly one group", () => {
    for (const section of SETTINGS_NAV_SECTIONS) {
      const owners = SETTINGS_NAV_GROUPS.filter((group) =>
        group.members.some(
          (member) => member.kind === "section" && member.id === section.id,
        ),
      );
      expect(owners, section.id).toHaveLength(1);
    }
  });

  it("highlights the row that owns the open page", () => {
    renderSidebar({ activeSection: "browser" });
    expect(currentRow()).toEqual(["General"]);
    cleanup();
    renderSidebar({ activeSection: null, activePluginId: "provider-codex" });
    expect(currentRow()).toEqual(["Agents"]);
    cleanup();
    renderSidebar({ activeSection: "command-guard" });
    expect(currentRow()).toEqual(["Advanced"]);
  });

  it("files plugins without a group under Plugins", () => {
    renderSidebar({ activeSection: null, activePluginId: "linear" });
    expect(currentRow()).toEqual(["Plugins"]);
  });

  it("links a row to its first available page", () => {
    renderSidebar({
      pluginEntries: pluginEntries.filter(
        ({ id }) => id !== "custom-instructions",
      ),
      sections: SETTINGS_NAV_SECTIONS.filter(({ id }) => id !== "files"),
    });
    expect(
      screen.getByRole("link", { name: "Instructions" }).getAttribute("href"),
    ).toBe("/settings/system-prompt");
  });

  it("filters rows by page names and keywords, and Enter opens the first match", () => {
    renderSidebar();
    const search = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "codex" } });
    expect(rowLabels()).toEqual(["Agents"]);
    fireEvent.change(search, { target: { value: "command guard" } });
    expect(rowLabels()).toEqual(["Advanced"]);
    fireEvent.change(search, { target: { value: "archived" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/projects",
    );
    expect((search as HTMLInputElement).value).toBe("");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(rowLabels()).toEqual([]);
    expect(screen.getByText("No settings match.")).toBeTruthy();
  });

  it("keeps native device settings reachable", () => {
    vi.spyOn(nativeShell, "canOpenNativeScreen").mockReturnValue(true);
    const openNative = vi
      .spyOn(nativeShell, "shellOpenNative")
      .mockReturnValue(true);
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "This device" }));
    expect(openNative).toHaveBeenCalledWith("device-settings");
  });
});
