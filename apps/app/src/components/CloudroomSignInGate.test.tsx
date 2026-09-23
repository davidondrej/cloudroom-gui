// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CloudroomSignInGate } from "./CloudroomSignInGate";

vi.mock("@/lib/sdk", () => ({
  sdk: { cloudroom: { status: vi.fn(), signIn: vi.fn(), cancel: vi.fn() } },
}));
vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: vi.fn(),
}));

const signedOut = {
  ready: false,
  account: null,
  projectId: null,
  repository: null,
  model: null,
  error: null,
  signingIn: false,
  signInError: null,
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.resetAllMocks();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CloudroomSignInGate />
    </QueryClientProvider>,
  );
  return client;
}

it("does not block the app while checking the account, then keeps the prompt open after Escape or a backdrop click", async () => {
  let resolveStatus!: (value: typeof signedOut) => void;
  vi.mocked(sdk.cloudroom.status).mockReturnValue(
    new Promise((resolve) => {
      resolveStatus = resolve;
    }),
  );
  mount();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector("[data-persistent-drawer-backdrop]")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Sign in to Cloudroom" }),
  ).toBeNull();
  resolveStatus(signedOut);
  await screen.findByRole("button", { name: "Sign in to Cloudroom" });
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(document.querySelector("[data-persistent-drawer-backdrop]")!);
  expect(
    screen.getByRole("dialog", { name: "Welcome to Cloudroom" }),
  ).toBeDefined();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Sign in to Cloudroom" }),
  );
});

it("opens external login, supports reopening and cancellation, then unlocks on account confirmation even with an offline VM", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.signIn).mockImplementation(async () => {
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({
      ...signedOut,
      signingIn: true,
    });
    return { url: "https://www.cloudroom.dev/desktop?challenge=public" };
  });
  vi.mocked(sdk.cloudroom.cancel).mockImplementation(async () => {
    vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  });
  const client = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in to Cloudroom" }),
  );
  const reopen = await screen.findByRole("button", {
    name: "Open browser again",
  });
  expect(sdk.cloudroom.signIn).toHaveBeenCalledWith();
  expect(openUrlInExternalBrowser).toHaveBeenCalledWith(
    "https://www.cloudroom.dev/desktop?challenge=public",
  );
  fireEvent.click(reopen);
  expect(openUrlInExternalBrowser).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await screen.findByRole("button", { name: "Sign in to Cloudroom" });
  expect(sdk.cloudroom.cancel).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Cloudroom" }));
  await screen.findByRole("button", { name: "Open browser again" });
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({
    ...signedOut,
    account: { id: "account", email: "member@example.invalid" },
    error: "VM is offline",
  });
  await client.invalidateQueries({ queryKey: ["cloudroom-account"] });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    document.querySelector("[data-persistent-drawer-backdrop]"),
  ).toBeNull();
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  await client.invalidateQueries({ queryKey: ["cloudroom-account"] });
  await screen.findByRole("dialog");
});

it("offers recovery for unavailable status, failed starts, and expired browser sign-in", async () => {
  vi.mocked(sdk.cloudroom.status)
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.signIn).mockRejectedValue(
    new Error("Connection unavailable"),
  );
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in to Cloudroom" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Connection unavailable",
    ),
  );
  expect(openUrlInExternalBrowser).not.toHaveBeenCalled();
  vi.mocked(sdk.cloudroom.signIn).mockResolvedValue({
    url: "https://www.cloudroom.dev/desktop",
  });
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({
    ...signedOut,
    signingIn: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Cloudroom" }));
  await screen.findByRole("button", { name: "Cancel sign-in" });
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({
    ...signedOut,
    signInError: "Sign-in expired. Try again.",
  });
  await client.invalidateQueries({ queryKey: ["cloudroom-account"] });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Sign-in expired. Try again.",
    ),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Sign in to Cloudroom",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
