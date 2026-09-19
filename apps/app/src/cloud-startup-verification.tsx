import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { makeThreadWithRuntime } from "@bb/test-helpers/domain-fixtures";
import { ThreadDetailPromptArea } from "./views/thread-detail/ThreadDetailPromptArea";
import { sidebarNavigationQueryKey } from "./hooks/queries/query-keys";
import "./app.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } });
const noop = () => {};
client.setQueryData(sidebarNavigationQueryKey(), { sections: [], projects: [{ id: "proj_startup", name: "Startup test", threads: [], sections: [] }], personalProject: { id: "proj_personal", name: "Personal", threads: [], sections: [] } });
createRoot(document.getElementById("root")!).render(<BrowserRouter><QueryClientProvider client={client}><TooltipProvider><div style={{ maxWidth: 840, margin: "80px auto" }}>
<ThreadDetailPromptArea
 activeBackgroundAgentCount={0} activeBackgroundCommands={[]} activePromptMode={null} activeWorkflows={[]} canUseGitUi={false} childPendingInteractions={[]} childThreadsSection={null} composerFocusRequestNonce={0} contextBannerMergeBase={null} environmentGoneStatus={null} goal={null} modelFallback={null} isEnvironmentActionPending={false} onChangedFileClick={noop} parentThreadSection={null} pendingInteractions={[]} pendingInteractionsInitialLoading={false} queuedMessageCount={0} pendingTodos={null} projectId="proj_startup" pullRequest={null} pullRequestMergeMethod="squash" resolveMentionLink={() => null} sendMessage={{ isPending: false, mutateAsync: async () => ({ ok: true, delivery: "sent" }) }} steerActiveThreadOnEnter={false}
 thread={makeThreadWithRuntime({ id: "thr_startup", projectId: "proj_startup", executionTarget: "cloud", environmentId: null, status: "pending" })} workspaceChangedFilesSection={null} workspaceStatusPending={false}
/>
</div></TooltipProvider></QueryClientProvider></BrowserRouter>);
