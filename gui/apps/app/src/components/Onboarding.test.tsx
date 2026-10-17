// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { Onboarding } from "./Onboarding";

const navigation = vi.hoisted(() => ({ projects: [{ id: "existing" }] }));
vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { status: vi.fn(), connect: vi.fn() } } }));
vi.mock("@/components/ClaudeConnection", () => ({ useClaudeConnection: () => ({ data: { state: "disconnected" } }), ClaudeConnectionButton: () => null }));
vi.mock("@/components/CodexConnectionPanel", () => ({ openCodexConnection: vi.fn() }));
vi.mock("@/components/promptbox/NewThreadComposer", () => ({ selectCloudForNewThreads: vi.fn() }));
vi.mock("@/components/settings/ImportChats", () => ({ ImportChats: () => null }));
vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({ useSidebarNavigation: () => ({ data: navigation }) }));
vi.mock("@/hooks/queries/system-queries", () => ({ useSystemConfig: () => ({ data: { generalSettings: { defaultProviderId: null } } }), useSystemProviders: () => ({ data: [] }) }));
vi.mock("@/hooks/mutations/settings-mutations", () => ({ useUpdateGeneralSettings: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/thread-creation-options/persisted-selection-fields", () => ({ usePromptBoxProviderPreference: () => ({ setValue: vi.fn() }) }));
vi.mock("@/hooks/useQuickCreateProject", () => ({ useQuickCreateProjectController: vi.fn() }));
vi.mock("@/hooks/useLocalPathPicker", () => ({ usePathPickerHost: vi.fn() }));
vi.mock("@/hooks/useHostDaemon", () => ({ useHostDaemon: vi.fn() }));
vi.mock("@/hooks/mutations/project-mutations", () => ({ useCreateProject: vi.fn() }));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: vi.fn().mockResolvedValue(new Response("{}")) }));

const signedOut = { ready: false, account: null, selfHosted: false, projectId: null, repository: null, model: null, error: "Sign in to Cloudroom", signingIn: false, signInError: null };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.clearAllMocks(); });

function mount(fresh = false) {
  navigation.projects = fresh ? [] : [{ id: "existing" }];
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<Provider><QueryClientProvider client={client}><MemoryRouter><Onboarding /></MemoryRouter></QueryClientProvider></Provider>);
}

async function connect(token: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Core URL" }), { target: { value: " http://127.0.0.1:9840 " } });
  fireEvent.change(screen.getByLabelText("Core API token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

it("lets a signed-out user connect their own Core from locked setup and leave setup", async () => {
  vi.mocked(sdk.cloudroom.connect).mockImplementation(async () => {
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, selfHosted: true, ready: true, error: null });
    return {} as never;
  });
  mount();
  expect(await screen.findByRole("dialog", { name: "Set up Cloudroom" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
  await connect(" test-token ");
  await waitFor(() => expect(sdk.cloudroom.connect).toHaveBeenCalledWith({ url: "http://127.0.0.1:9840", token: "test-token" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set up Cloudroom" })).toBeNull());
});

it("keeps connection errors and a retry visible inside locked setup", async () => {
  vi.mocked(sdk.cloudroom.connect).mockRejectedValue(new Error("Core rejected the API token"));
  mount();
  await connect("bad-token");
  expect((await screen.findByRole("alert")).textContent).toBe("Core rejected the API token");
  expect(screen.getByRole("dialog", { name: "Set up Cloudroom" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false);
});

it("lets a user with no projects skip setup after connecting their own Core", async () => {
  vi.mocked(sdk.cloudroom.connect).mockImplementation(async () => {
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, selfHosted: true, ready: true, error: null });
    return {} as never;
  });
  mount(true);
  await connect("test-token");
  fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set up Cloudroom" })).toBeNull());
});
