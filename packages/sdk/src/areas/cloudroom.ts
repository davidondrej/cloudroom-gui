import type { CreateSdkAreaArgs } from "./common.js";
import type { TeleportProgress } from "@bb/domain";

export interface CloudroomStorage {
  enabled: boolean;
  level: "normal" | "low_space" | "blocked";
  reason: "disk_capacity" | "measurement_unavailable" | "unprotected_test_mode";
  workspace_available_bytes: number | null;
  history_available_bytes: number | null;
  workspace_total_bytes: number | null;
  history_total_bytes: number | null;
  sampled_at: number | null;
}

export interface CloudroomStatus {
  storage?: CloudroomStorage | null;
  ready: boolean;
  account: { id: string; email: string } | null;
  /** Connected to a core the user hosts, by URL and token, without a Cloudroom account. */
  selfHosted?: boolean;
  projectId: string | null;
  repository: string | null;
  model: string | null;
  error: string | null;
  sync?: { state: "synced" | "syncing" | "offline" | "conflict"; conflicts: number; issue: string | null } | null;
  previews?: { state: "connected" | "offline"; count: number; message: string | null; issue: string | null } | null;
  /** Cloud agents may run commands on this computer (ADR 0113); null until first-run setup asks. */
  macAccess?: boolean | null;
  /** Copy this computer's logins, API keys, and model providers to the VM (ADR 0130); null until first-run setup asks. */
  copyLogins?: boolean | null;
  /** Agent logins found on this computer. Claude's is checked through its provider plugin. */
  localLogins?: { codex: boolean };
  signingIn: boolean;
  signInError: string | null;
}

export interface CloudroomCodexAuth {
  state: "missing" | "waiting" | "connected" | "limited" | "unavailable" | "error" | "expired";
  email: string | null;
  plan: string | null;
  message: string | null;
  login_id: string | null;
  verification_url: string | null;
  user_code: string | null;
}

/** The GitHub account cloud sandboxes clone and push as. */
export interface CloudroomGithubAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Every new cloud thread starts with these (synced with the website). Values are never returned; `hint` is the
 *  last 4 characters of long values. */
export interface CloudEnvironment {
  variables: { name: string; hint: string }[];
  setup: string;
  /** `owner/name` GitHub repos every sandbox clones into /repos/<name>. */
  repos: string[];
  /** The account's GitHub repos, newest first; only answered to `githubRepos`. */
  available?: string[];
  /** Last push time of each `available` repo, in ms. */
  pushed?: Record<string, number>;
}

/** A repo that is not a Cloudroom project yet: a Git folder on this Mac, or a GitHub repo. */
export type RepoSuggestion =
  | { source: "mac"; name: string; path: string; updatedAt: number }
  | { source: "github"; name: string; repo: string; updatedAt: number | null };
export type CloudEnvironmentChange =
  | { action: "set"; variables: Record<string, string> }
  | { action: "remove"; name: string }
  | { action: "setup"; setup: string }
  | { action: "addRepo"; repo: string }
  | { action: "removeRepo"; repo: string }
  | { action: "githubRepos" };

/** A skill on this Mac. `cloud` means every new cloud thread gets it. */
export interface CloudSkill {
  name: string;
  description: string;
  cloud: boolean;
}
/** `auto`: skills added to this Mac later go to the cloud too. `issue`: why the last upload failed. */
export interface CloudSkills {
  auto: boolean;
  skills: CloudSkill[];
  issue: string | null;
}
export type CloudSkillsChange = { names: string[]; cloud: boolean } | { auto: boolean };

export interface ClaudeAccountInput { action?: "login" | "cancel" | "complete" | "setup-token" | "install" | "key"; requestId?: string; code?: string; state?: string; apiKey?: string }

export interface CloudroomArea {
  claudeAuth(input?: ClaudeAccountInput, signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cursorApiKey(requestId: string, apiKey: string): Promise<CloudroomCodexAuth>;
  piApiKey(provider: string, apiKey: string): Promise<{ providers: string[] }>;
  codexAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  codexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCodexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  /** GitHub for cloud sandboxes: connected when this Mac's `gh` is signed in or the website holds a login. Login runs GitHub's device flow. */
  githubAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  githubLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelGithubLogin(requestId: string): Promise<CloudroomCodexAuth>;
  /** Null when GitHub can't tell right now. */
  githubAccount(signal?: AbortSignal): Promise<CloudroomGithubAccount | null>;
  /** Removes the cloud GitHub login and stops copying this Mac's `gh` login. */
  disconnectGithub(): Promise<void>;
  /** Recently updated repos on this Mac and GitHub that no project uses yet. */
  repoSuggestions(signal?: AbortSignal): Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }>;
  /** Makes an `owner/name` GitHub repo a project right away. Machines and sandboxes clone it when first needed. */
  addGithubRepo(input: { repo: string }): Promise<{ projectId: string }>;
  status(signal?: AbortSignal): Promise<CloudroomStatus>;
  /** `provider` opens that provider's sign-in directly instead of the website's sign-in page. */
  signIn(input?: { projectId?: string; websiteUrl?: string; provider?: "github" | "google" }): Promise<{ url: string }>;
  /** Connects a self-hosted core by its HTTPS URL and API token. The backend checks it before saving. */
  connect(input: { url: string; token: string }): Promise<void>;
  setMacAccess(enabled: boolean): Promise<void>;
  setCopyLogins(enabled: boolean): Promise<void>;
  environment(signal?: AbortSignal): Promise<CloudEnvironment>;
  updateEnvironment(change: CloudEnvironmentChange): Promise<CloudEnvironment>;
  /** Names of API keys and tokens set in this Mac's login shell, never their values. */
  macVariables(signal?: AbortSignal): Promise<{ names: string[] }>;
  /** Copies the named variables from this Mac's login shell into the Cloud environment. */
  importMacVariables(names: string[]): Promise<CloudEnvironment>;
  /** This Mac's skills and which of them new cloud threads get. */
  cloudSkills(signal?: AbortSignal): Promise<CloudSkills>;
  /** Adds or removes skills, or sets whether new skills go to the cloud. Uploads in the background. */
  setCloudSkills(change: CloudSkillsChange): Promise<CloudSkills>;
  /** Mac → cloud: runs a shell command as the agent account of the VM, or of `threadId`'s sandbox. Input and output bytes are hex. */
  runOnVm(input: { command: string; stdin?: string; cwd?: string; threadId?: string }): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  threadWorkspace(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadWorkspace | null>;
  /** A Cloud thread's model and current effort, or null when it has no cloud session. */
  threadStatus(threadId: string, signal?: AbortSignal): Promise<{ model: string; reasoning: string } | null>;
  retryStart(threadId: string): Promise<void>;
  /** `choice` runs the cloud thread on another model when the cloud cannot offer the local one. */
  teleport(threadId: string, action?: "start" | "cancel", choice?: { model: string; reasoning: string }): Promise<TeleportProgress>;
  teleportStatus(threadId: string, signal?: AbortSignal): Promise<TeleportProgress | null>;
  /** Moves a Cloud thread back to this Mac. `conflicts` counts cloud files saved under `.cloudroom/teleport/` because the local copy also changed. */
  teleportLocal(threadId: string): Promise<{ conflicts: number }>;
  /** Copies a cloud thread's branch into the Mac project without stopping its agent. */
  copyToMac(threadId: string): Promise<{ branch: string }>;
  /** Downloads a file from a cloud thread's machine into ~/Downloads and opens it. */
  openCloudFile(threadId: string, path: string): Promise<{ path: string }>;
  /** Moves a thread from the cloud VM into its own sandbox (moving off the VM). Returns Teleport progress. */
  moveToSandbox(threadId: string): Promise<TeleportProgress>;
  /** Copies open BB threads into idle Local threads by forking their native sessions. Sends no prompts. */
  importBb(hostId: string): Promise<BbImportResult>;
  /** Claude Code and Codex chats on this Mac that are not in Cloudroom yet, newest first. */
  nativeSessions(signal?: AbortSignal): Promise<{ sessions: NativeSession[] }>;
  /** Copies chosen chats into idle Local threads by forking their native sessions. Sends no prompts. */
  importSessions(hostId: string, sessions: { harness: NativeSession["harness"]; id: string }[]): Promise<SessionImportResult>;
  /** Sends a Local agent's Cloudroom bug report. `sent` is false while bug reports are off in Settings. */
  reportBug(input: { message: string; threadId?: string }): Promise<{ sent: boolean }>;
}

export interface BbImportResult {
  imported: { bbThreadId: string; threadId: string; title: string }[];
  skipped: { bbThreadId: string; title: string; reason: string }[];
}

export interface NativeSession {
  harness: "claude-code" | "codex";
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
}

export interface SessionImportResult {
  imported: { harness: NativeSession["harness"]; id: string; threadId: string; title: string }[];
  skipped: { harness: NativeSession["harness"]; id: string; title: string; reason: string }[];
}

export interface CloudroomThreadWorkspace {
  path: string;
  branch: string | null;
  head: string | null;
}

export function createCloudroomArea({ transport }: CreateSdkAreaArgs): CloudroomArea {
  const request = (path: string, body?: object, signal?: AbortSignal) => transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/account${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return {
    claudeAuth: (input, signal) => transport.readJson(request(`/claude${input?.action ? `/${input.action}` : ""}`, input?.action ? { requestId: input.requestId, ...(input.action === "complete" ? { code: input.code, state: input.state } : {}), ...(input.action === "key" ? { apiKey: input.apiKey } : {}) } : undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorAuth: (signal) => transport.readJson(request("/cursor", undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorLogin: (requestId) => transport.readJson(request("/cursor/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCursorLogin: (requestId) => transport.readJson(request("/cursor/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    cursorApiKey: (requestId, apiKey) => transport.readJson(request("/cursor/key", { requestId, apiKey })) as Promise<CloudroomCodexAuth>,
    piApiKey: (provider, apiKey) => transport.readJson(request("/pi/key", { provider, apiKey })) as Promise<{ providers: string[] }>,
    codexAuth: (signal) => transport.readJson(request("/codex", undefined, signal)) as Promise<CloudroomCodexAuth>,
    codexLogin: (requestId) => transport.readJson(request("/codex/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCodexLogin: (requestId) => transport.readJson(request("/codex/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    githubAuth: (signal) => transport.readJson(request("/github", undefined, signal)) as Promise<CloudroomCodexAuth>,
    repoSuggestions: (signal) => transport.readJson(request("/repo-suggestions", undefined, signal)) as Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }>,
    addGithubRepo: (input) => transport.readJson(request("/repo-suggestions/github", input)) as Promise<{ projectId: string }>,
    githubLogin: (requestId) => transport.readJson(request("/github/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelGithubLogin: (requestId) => transport.readJson(request("/github/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    githubAccount: (signal) => transport.readJson(request("/github/account", undefined, signal)) as Promise<CloudroomGithubAccount | null>,
    disconnectGithub: () => transport.readVoid(request("/github/disconnect", {})),
    status: (signal) => transport.readJson(request("", undefined, signal)) as Promise<CloudroomStatus>,
    signIn: (input = {}) => transport.readJson(request("/sign-in", input)) as Promise<{ url: string }>,
    connect: (input) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })),
    cancel: () => transport.readVoid(request("/cancel", {})),
    setMacAccess: (enabled) => transport.readVoid(request("/mac-access", { enabled })),
    setCopyLogins: (enabled) => transport.readVoid(request("/copy-logins", { enabled })),
    environment: (signal) => transport.readJson(request("/environment", undefined, signal)) as Promise<CloudEnvironment>,
    updateEnvironment: (change) => transport.readJson(request("/environment", change)) as Promise<CloudEnvironment>,
    macVariables: (signal) => transport.readJson(request("/environment/mac", undefined, signal)) as Promise<{ names: string[] }>,
    importMacVariables: (names) => transport.readJson(request("/environment/mac", { names })) as Promise<CloudEnvironment>,
    cloudSkills: (signal) => transport.readJson(request("/skills", undefined, signal)) as Promise<CloudSkills>,
    setCloudSkills: (change) => transport.readJson(request("/skills", change)) as Promise<CloudSkills>,
    runOnVm: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/vm/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>,
    logout: () => transport.readVoid(request("/logout", {})),
    threadStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}`, { signal })) as Promise<{ model: string; reasoning: string } | null>,
    threadWorkspace: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/workspace`, { signal })) as Promise<CloudroomThreadWorkspace | null>,
    teleport: (threadId, action = "start", choice) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...choice }) })) as Promise<TeleportProgress>,
    teleportStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { signal })) as Promise<TeleportProgress | null>,
    teleportLocal: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "local" }) })) as Promise<{ conflicts: number }>,
    moveToSandbox: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move" }) })) as Promise<TeleportProgress>,
    copyToMac: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "copy" }) })) as Promise<{ branch: string }>,
    openCloudFile: (threadId, path) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/open-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })) as Promise<{ path: string }>,
    importBb: (hostId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/bb`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId }) })) as Promise<BbImportResult>,
    nativeSessions: (signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/sessions`, { signal })) as Promise<{ sessions: NativeSession[] }>,
    importSessions: (hostId, sessions) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId, sessions }) })) as Promise<SessionImportResult>,
    reportBug: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/bug-reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ sent: boolean }>,
    retryStart: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
  };
}
