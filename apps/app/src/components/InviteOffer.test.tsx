// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/hooks/queries/cloudroom-queries", () => ({ useCloudroomAccount: () => ({ data: { account: { id: "user" } } }) }));
vi.mock("@/lib/app-surface", () => ({
  fetchWithAppSurface: async () => new Response(JSON.stringify({ codes: [], left: 3, created: null }), { status: 200 }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("waits for a typing pause, stays open while typing, and does not focus a button", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  localStorage.setItem("cloudroom.invites.startedAt", JSON.stringify(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const { InviteOffer } = await import("./InviteOffer");
  render(<QueryClientProvider client={new QueryClient()}><InviteOffer /></QueryClientProvider>);

  for (let i = 0; i < 10; i++) {
    fireEvent.keyDown(window, { key: "a" });
    await wait(2_000);
  }
  expect(screen.queryByRole("dialog")).toBeNull();

  await wait(12_000);
  const dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(dialog);

  for (let i = 0; i < 10; i++) {
    fireEvent.keyDown(document.activeElement!, { key: " " });
    await wait(2_000);
  }
  expect(screen.getByRole("dialog")).toBe(dialog);
});
