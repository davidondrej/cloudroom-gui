// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { appToast } from "@/components/ui/app-toast";
import { CloudroomSignInButton } from "./CloudroomSignInButton";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { status: vi.fn(), signIn: vi.fn(), cancel: vi.fn() }, projects: { list: vi.fn() } } }));
vi.mock("@/lib/url-open-routing", () => ({ openUrlInExternalBrowser: vi.fn() }));
vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));
const clients: QueryClient[] = [];
const signedOut = { ready: false, account: null, projectId: null, repository: null, model: null, error: null, signingIn: false, signInError: null };
const projects = [{ id: "one", name: "First project" }, { id: "two", name: "Second project" }];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });
function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }
function mount(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={client}><TooltipProvider><ul><CloudroomSignInButton /></ul></TooltipProvider><Location /></QueryClientProvider></MemoryRouter>);
}
async function clickSignIn() {
  const button = await screen.findByRole("button", { name: "Sign in" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
it("signs in directly from the current project without navigating to settings", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.projects.list).mockResolvedValue(projects as never);
  vi.mocked(sdk.cloudroom.signIn).mockResolvedValue({ url: "https://www.cloudroom.dev/desktop" });
  mount("/projects/two");
  await clickSignIn();
  await waitFor(() => expect(sdk.cloudroom.signIn).toHaveBeenCalledWith());
  expect(openUrlInExternalBrowser).toHaveBeenCalledWith("https://www.cloudroom.dev/desktop");
  expect(screen.getByTestId("location").textContent).toBe("/projects/two");
});
it("signs in without a project and reports login failures", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.projects.list).mockResolvedValue([]);
  vi.mocked(sdk.cloudroom.signIn).mockRejectedValue(new Error("Connection unavailable"));
  mount(); await clickSignIn();
  await waitFor(() => expect(appToast.error).toHaveBeenCalledWith("Connection unavailable"));
  expect(sdk.cloudroom.signIn).toHaveBeenCalledWith();
  expect(openUrlInExternalBrowser).not.toHaveBeenCalled();
});
it("signs in from home without choosing a project", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.projects.list).mockResolvedValue(projects as never);
  vi.mocked(sdk.cloudroom.signIn).mockResolvedValue({ url: "https://www.cloudroom.dev/desktop" });
  mount(); await clickSignIn();
  expect(screen.queryByText("Choose your cloud project")).toBeNull();
  await waitFor(() => expect(sdk.cloudroom.signIn).toHaveBeenCalledWith());
  expect(screen.getByTestId("location").textContent).toBe("/");
});
it("cancels a pending browser login from the same button", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, signingIn: true });
  vi.mocked(sdk.projects.list).mockResolvedValue([]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(sdk.cloudroom.cancel).toHaveBeenCalledOnce());
  expect(sdk.cloudroom.signIn).not.toHaveBeenCalled();
});
