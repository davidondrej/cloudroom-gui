import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { getThread } from "@bb/db";
import { z } from "zod";
import { threadGoalSetRequestSchema } from "@bb/server-contract";
import { cloudroom, isCloudThread } from "./commands.js";
import { cloudroomAccount } from "./account.js";
import { setMacAccess } from "./previews.js";
import { cloudSkills, setCloudSkills, setCopyLogins, skillInCloud } from "./sync.js";
import { teleports } from "./teleport.js";
import { binding, teleportBlocked, teleportProgress } from "./store.js";
import { browserRequestProblem } from "../../browser-request-guard.js";
import { cancelClaudeToken, claudePlan, installClaude, isClaudeApiKey, startClaudeToken, withClaudeTokenRun } from "./claude-token.js";
import { startClaudeVersionSync } from "./harness-versions.js";
import { importBbThreads } from "./bb-import.js";
import { importNativeSessions, listNativeSessions } from "./session-import.js";
import { copyToMac, openOnMac, teleportingToLocal, teleportToLocal } from "./teleport-local.js";
import { cloudEnvironmentRequestSchema, macSkills, macVariables, sandboxThread, type CloudEnvironmentRequest } from "./sandboxes.js";
import { CloudroomError } from "./client.js";
import { archiveThreadAndChildren } from "../threads/thread-archive.js";
import { reportBug } from "./bug-reports.js";
import { disconnectGithub, githubAccount, githubAuth } from "./github-login.js";
import { addGithubRepo, repoSuggestions } from "./repo-suggestions.js";
import { SETUP_ACTIONS, SETUP_DETAILS, SETUP_STEPS } from "../system/telemetry.js";

export function installCloudroomRoutes(app: Hono, deps: AppDeps): void {
  cloudroom(deps).teleportRecovery = () => teleports(deps).recover();
  cloudroom(deps).archiveRequest = (threadId) => {
    const thread = getThread(deps.db, threadId);
    if (!thread || thread.archivedAt || thread.deletedAt) return;
    try { archiveThreadAndChildren(deps, { parentThread: thread }); }
    catch (error) { deps.logger.warn({ error, threadId }, "Cloud self-archive failed"); }
  };
  startClaudeVersionSync(deps, () => cloudroom(deps).teleportClient());
  const localOnly: MiddlewareHandler = async (context, next) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    return next();
  };
  app.use("/api/v1/cloudroom", localOnly);
  app.use("/api/v1/cloudroom/*", localOnly);
  app.get("/api/v1/cloudroom/threads/:id/teleport", context => context.json(teleportProgress(deps.db, context.req.param("id"))));
  app.post("/api/v1/cloudroom/threads/:id/teleport", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const body = z.object({ action: z.enum(["start", "cancel", "local", "copy", "move"]).default("start"), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() }).strict().parse(await context.req.json());
    const id = context.req.param("id");
    if (body.action === "cancel") { await teleports(deps).cancel(id); return context.json(teleportProgress(deps.db, id), 202); }
    if (body.action === "local") return context.json(await teleportToLocal(deps, id));
    if (body.action === "copy") return context.json(await copyToMac(deps, id));
    const choice = body.model && body.reasoning ? { model: body.model, reasoning: body.reasoning } : undefined;
    if (body.action === "move") return context.json(await moveToSandbox(deps, id, choice), 202);
    return context.json(await teleports(deps).begin(id, choice), 202);
  });
  app.post("/api/v1/cloudroom/threads/:id/open-file", async context => {
    const input = z.object({ path: z.string().regex(/^\/[^\0]*$/).max(4096) }).strict().parse(await context.req.json());
    return context.json(await openOnMac(deps, context.req.param("id"), input.path));
  });
  app.post("/api/v1/cloudroom/import/bb", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const input = z.object({ hostId: z.string().min(1) }).strict().parse(await context.req.json());
    return context.json(await importBbThreads(deps, input.hostId));
  });
  app.get("/api/v1/cloudroom/import/sessions", async context => context.json({ sessions: await listNativeSessions(deps) }));
  app.post("/api/v1/cloudroom/import/sessions", async context => {
    const input = z.object({
      hostId: z.string().min(1),
      sessions: z.array(z.object({ harness: z.enum(["claude-code", "codex"]), id: z.string().min(1) }).strict()).min(1).max(2000),
    }).strict().parse(await context.req.json());
    return context.json(await importNativeSessions(deps, input.hostId, input.sessions));
  });
  app.post("/api/v1/cloudroom/account/project", async (context) => {
    const input = z.object({ projectId: z.string().min(1) }).strict().parse(await context.req.json());
    await cloudroom(deps).selectOnboardingProject(input.projectId);
    void cloudroom(deps).warmSandbox(input.projectId).catch(() => {});
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/account", async (context) => context.json(await cloudroomAccount(deps).status()));
  app.post("/api/v1/cloudroom/account/activity", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    await cloudroom(deps).noteActivity();
    return context.json({ ok: true });
  });
  let desktopUpdate: { version: string; installAt: number | null; seenAt: number; install: boolean } | null = null;
  app.post("/api/v1/cloudroom/desktop-update", async (context) => {
    const input = z.object({ version: z.string().min(1).max(40), installAt: z.number().nullable() }).strict().parse(await context.req.json());
    const install = desktopUpdate?.version === input.version && desktopUpdate.install;
    desktopUpdate = { ...input, seenAt: Date.now(), install };
    return context.json({ install });
  });
  app.get("/api/v1/cloudroom/desktop-update", (context) =>
    context.json(desktopUpdate && Date.now() - desktopUpdate.seenAt < 60_000
      ? { version: desktopUpdate.version, installAt: desktopUpdate.installAt, installing: desktopUpdate.install }
      : null));
  app.post("/api/v1/cloudroom/desktop-update/install", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    if (!desktopUpdate) throw new ApiError(409, "no_desktop_update", "No downloaded update to install.");
    desktopUpdate.install = true;
    return context.json({ ok: true }, 202);
  });
  app.post("/api/v1/cloudroom/setup-step", async (context) => {
    const parsed = z.object({ step: z.enum(SETUP_STEPS), action: z.enum(SETUP_ACTIONS), detail: z.enum(SETUP_DETAILS).nullable().default(null) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_setup_step", "Invalid setup step.");
    deps.telemetry.capture({ name: "setup_step", properties: parsed.data });
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/bug-reports", async (context) => {
    const input = z.object({ message: z.string().trim().min(1).max(4000), threadId: z.string().min(1).max(200).optional() }).strict().parse(await context.req.json());
    return context.json(await reportBug(deps, input));
  });
  app.get("/api/v1/cloudroom/account/invites", async (context) => context.json(await cloudroom(deps).sandboxes.invites("list")));
  app.post("/api/v1/cloudroom/account/invites", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.invites("create"));
  });
  app.post("/api/v1/cloudroom/account/more-usage", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.requestMoreUsage().catch((error: unknown) => {
      throw new ApiError(503, "cloud_usage_request", error instanceof Error ? error.message : String(error));
    }));
  });
  app.post("/api/v1/cloudroom/account/mac-access", async (context) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await context.req.json());
    await setMacAccess(deps, input.enabled);
    return context.json({ ok: true });
  });
  // The website's own message (say, an invalid key) reaches the user instead of "Internal server error".
  const environment = (request: CloudEnvironmentRequest) => cloudroom(deps).sandboxes.environment(request).catch((error: unknown) => {
    throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_environment", error instanceof Error ? error.message : String(error));
  });
  // Cloud environment settings live on the website, so the app and the dashboard always show the same values.
  app.get("/api/v1/cloudroom/account/environment", async (context) => context.json(await environment({ action: "get" })));
  app.post("/api/v1/cloudroom/account/environment", async (context) => context.json(await environment(cloudEnvironmentRequestSchema.parse(await context.req.json()))));
  // Import from this Mac: the list shows names only, and values go straight to the website.
  app.get("/api/v1/cloudroom/account/environment/mac", async (context) => context.json({ names: Object.keys(await macVariables()).sort() }));
  app.post("/api/v1/cloudroom/account/environment/mac", async (context) => {
    const { names } = z.object({ names: z.array(z.string()).min(1).max(100) }).strict().parse(await context.req.json());
    const found = await macVariables();
    const variables = Object.fromEntries(names.flatMap(name => found[name] ? [[name, found[name]]] : []));
    if (!Object.keys(variables).length) throw new ApiError(404, "mac_variables_missing", "Those variables are no longer set in your shell on this Mac.");
    return context.json(await environment({ action: "set", variables }));
  });
  // Skills from this Mac that every new cloud thread gets. A change saves at once; the upload runs in the background.
  const skillList = async () => {
    const choice = await cloudSkills(deps);
    const inCloud = skillInCloud(choice);
    const skills = (await macSkills()).map(({ name, description }) => ({ name, description, cloud: inCloud(name) }));
    return { auto: choice.auto, skills, issue: cloudroom(deps).sandboxes.configIssue };
  };
  let skillChange = Promise.resolve();
  app.get("/api/v1/cloudroom/account/skills", async (context) => context.json(await skillList()));
  app.post("/api/v1/cloudroom/account/skills", async (context) => {
    const input = z.union([
      z.object({ names: z.array(z.string().min(1)).min(1).max(1000), cloud: z.boolean() }).strict(),
      z.object({ auto: z.boolean() }).strict(),
    ]).parse(await context.req.json());
    // One change at a time, so quick clicks never overwrite each other.
    const change = skillChange.then(async () => {
      const choice = await cloudSkills(deps);
      if ("auto" in input) {
        // Skills already on this Mac keep their place; only skills added later follow the new setting.
        const inCloud = skillInCloud(choice);
        for (const { name } of await macSkills()) choice.chosen[name] = inCloud(name);
        choice.auto = input.auto;
      } else for (const name of input.names) choice.chosen[name] = input.cloud;
      await setCloudSkills(deps, choice);
      void cloudroom(deps).sandboxes.copyMacConfig(skillInCloud(choice), true).catch((error: unknown) => deps.logger.warn({ error }, "Skills could not be copied to cloud sandboxes"));
    });
    skillChange = change.catch(() => {});
    await change;
    return context.json(await skillList());
  });
  app.post("/api/v1/cloudroom/account/copy-logins", async (context) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await context.req.json());
    await setCopyLogins(deps, input.enabled);
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/vm/run", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const { threadId, ...input } = z.object({ command: z.string().min(1).max(65536), stdin: z.string().max(32 * 1024 * 1024).regex(/^(?:[0-9a-f]{2})*$/).optional(), cwd: z.string().min(1).max(4096).optional(), threadId: z.string().min(1).max(200).optional() }).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).runOnVm(input, threadId, context.req.raw.signal));
  });
  const claudeStatus = async () => withClaudeTokenRun(await cloudroom(deps).claudeAuth());
  app.get("/api/v1/cloudroom/account/claude", async context => context.json(await claudeStatus()));
  for (const action of ["setup-token", "install"] as const) {
    app.post(`/api/v1/cloudroom/account/claude/${action}`, async context => {
      const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
      if (problem) return context.json({ message: "Use the local Cloudroom app." }, problem.status);
      const { requestId } = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
      if (action === "install") await installClaude();
      await startClaudeToken(requestId, async token => cloudroom(deps).claudeAuth("token", requestId, token, await claudePlan()));
      return context.json(await claudeStatus());
    });
  }
  app.post("/api/v1/cloudroom/account/claude/key", async context => {
    const parsed = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), apiKey: z.string().refine(isClaudeApiKey) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_claude_key", "Paste an Anthropic API key from the Claude Console. It starts with sk-ant-.");
    return context.json(await cloudroom(deps).claudeAuth("key", parsed.data.requestId, parsed.data.apiKey));
  });
  for (const action of ["login", "cancel", "complete"] as const) {
    app.post(`/api/v1/cloudroom/account/claude/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...(action === "complete" ? { code: z.string().min(1).max(2048), state: z.string().min(1).max(512) } : {}) }).strict().parse(await context.req.json());
      if (action === "cancel" && cancelClaudeToken()) return context.json(await claudeStatus());
      return context.json(await cloudroom(deps).claudeAuth(action, input.requestId, "code" in input ? String(input.code) : undefined, "state" in input ? String(input.state) : undefined));
    });
  }
  app.get("/api/v1/cloudroom/account/cursor", async context => context.json(await cloudroom(deps).cursorAuth()));
  for (const action of ["login", "cancel", "key"] as const) {
    app.post(`/api/v1/cloudroom/account/cursor/${action}`, async context => {
      const schema = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...(action === "key" ? { apiKey: z.string().min(1).max(4096).regex(/^[!-~]+$/) } : {}) }).strict();
      const parsed = schema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) throw new ApiError(400, "invalid_cursor_auth", "Invalid Cursor account request.");
      const input = parsed.data;
      return context.json(await cloudroom(deps).cursorAuth(action, input.requestId, "apiKey" in input ? String(input.apiKey) : undefined));
    });
  }
  app.post("/api/v1/cloudroom/account/pi/key", async context => {
    const parsed = z.object({ provider: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), apiKey: z.string().min(1).max(8192).regex(/^[!-~]+$/) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_pi_auth", "Invalid Pi key request.");
    return context.json(await cloudroom(deps).piApiKey(parsed.data.provider, parsed.data.apiKey));
  });
  app.get("/api/v1/cloudroom/account/codex", async context => context.json(await cloudroom(deps).codexAuth()));
  for (const action of ["login", "cancel"] as const) {
    app.post(`/api/v1/cloudroom/account/codex/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
      return context.json(await cloudroom(deps).codexAuth(action, input.requestId));
    });
  }
  app.get("/api/v1/cloudroom/account/github", async context => context.json(await githubAuth(deps)));
  app.get("/api/v1/cloudroom/account/github/account", async context => context.json(await githubAccount(deps)));
  app.post("/api/v1/cloudroom/account/github/disconnect", async context => { await disconnectGithub(deps); return context.json({ ok: true }); });
  app.get("/api/v1/cloudroom/account/repo-suggestions", async context => context.json(await repoSuggestions(deps)));
  app.post("/api/v1/cloudroom/account/repo-suggestions/github", async context => {
    const input = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict().parse(await context.req.json());
    return context.json(addGithubRepo(deps, input.repo));
  });
  for (const action of ["login", "cancel"] as const) {
    app.post(`/api/v1/cloudroom/account/github/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
      return context.json(await githubAuth(deps, action, input.requestId));
    });
  }
  app.post("/api/v1/cloudroom/account/sign-in", async (context) => context.json(await cloudroomAccount(deps).signIn(await context.req.json())));
  app.post("/api/v1/cloudroom/account/cancel", (context) => { cloudroomAccount(deps).cancel(); return context.json({ ok: true }); });
  app.post("/api/v1/cloudroom/account/logout", async (context) => { await cloudroomAccount(deps).logout(); return context.json({ ok: true }); });
  app.get("/api/v1/cloudroom", async (context) => context.json(await cloudroom(deps).status()));
  app.post("/api/v1/cloudroom", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    await cloudroom(deps).configure(await context.req.json());
    return context.json(await cloudroom(deps).status());
  });
  app.get("/api/v1/cloudroom/threads/:id", async (context) => {
    const id = context.req.param("id");
    const status = cloudroom(deps).threadStatus(id);
    const thread = getThread(deps.db, id);
    if (!status || !thread) return context.json(null);
    return context.json(status);
  });
  app.get("/api/v1/cloudroom/threads/:id/workspace", async (context) => context.json(await cloudroom(deps).threadWorkspace(context.req.param("id"), context.req.raw.signal)));
  app.post("/api/v1/cloudroom/threads/:id/retry-start", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    await cloudroom(deps).retryStart(context.req.param("id"));
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/threads/:id/wake", async (context) => {
    const { reason } = await context.req.json<{ reason?: unknown }>().catch(() => ({ reason: undefined }));
    void cloudroom(deps).wakeAhead(context.req.param("id"), reason === "view" ? "thread_view" : "thread_typing").catch(() => {});
    return context.json({ ok: true }, 202);
  });
  const guard: MiddlewareHandler = async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
    const id = context.req.param("id");
    if (!id) return next();
    const thread = getThread(deps.db, id);
    if (teleportingToLocal(id)) return context.json({ message: "Teleport to Local is in progress.", code: "teleport_in_progress" }, 409);
    if (teleportBlocked(deps.db, id)) {
      const suffix = context.req.path.slice(`/api/v1/threads/${id}`.length);
      const rename = context.req.method === "PATCH" && suffix === "" && await context.req.json<unknown>().then((body) => Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).join() === "title"), () => false);
      if (!rename && !["/read", "/unread", "/tabs", "/archive-all"].includes(suffix) && !(suffix === "/stop" && teleportProgress(deps.db, id)?.cloudStarted)) return context.json({ message: "Teleport is in progress. Wait for completion, or use Cancel before cloud execution starts.", code: "teleport_in_progress" }, 409);
    }
    if (!thread || !isCloudThread(thread)) return next();
    const path = context.req.path.slice(`/api/v1/threads/${thread.id}`.length);
    if (context.req.method === "PATCH" && path === "") {
      const body = await context.req.json<unknown>();
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => ["title", "reasoningLevel", "model"].includes(key))) {
        const model = (body as { model?: unknown }).model;
        if (model === undefined || model === binding(deps.db, thread.id)?.model) return next();
        return context.json({ message: "Model is fixed for this cloud thread. Start a new thread to change it.", code: "cloudroom_launch_settings" }, 409);
      }
    }
    if (["/tabs", "/read", "/unread", "/pin", "/unpin", "/pin-order"].includes(path)) return next();
    if (context.req.method === "POST" && ["/archive-all", "/unarchive"].includes(path)) return next();
    if (context.req.method === "POST" && ["/send", "/queued-messages", "/stop", "/compact", "/edit-message"].includes(path)) return next();
    if (context.req.method === "PATCH" && /^\/queued-messages\/[^/]+$/.test(path)) return next();
    if (context.req.method === "DELETE" && /^\/queued-messages\/[^/]+$/.test(path)) return next();
    if (context.req.method === "POST" && /^\/interactions\/[^/]+\/(respond|cancel)$/.test(path)) return next();
    if (context.req.method === "POST" && (path === "/goal" || path === "/goal/clear")) {
      const goal = path === "/goal" ? threadGoalSetRequestSchema.parse(await context.req.json()) : { clear: true };
      await cloudroom(deps).goal(thread, goal);
      return context.json({ ok: true });
    }
    if (context.req.method === "POST" && /^\/queued-messages\/[^/]+\/send$/.test(path)) {
      return context.json(await cloudroom(deps).sendQueued(thread, path.split("/")[2]!));
    }
    return context.json({ message: "This action is not enabled for Cloud threads. Native execution is blocked.", code: "cloudroom_unsupported" }, 409);
  };
  app.use("/api/v1/threads/:id", guard);
  app.use("/api/v1/threads/:id/*", guard);
}

/** Moves a VM thread into its own sandbox (moving off the VM): Teleport to Local, then Teleport to Cloud, which picks a
 *  sandbox. The VM keeps its copy, so moving back only needs the account switch (docs/scopes/sandboxes.md). */
async function moveToSandbox(deps: AppDeps, threadId: string, choice?: { model: string; reasoning: string }) {
  const saved = binding(deps.db, threadId);
  if (!saved || sandboxThread(saved.coreUrl)) throw new ApiError(409, "cloudroom_move_unavailable", "Only a thread on your cloud VM can move to its own sandbox.");
  if (!await cloudroom(deps).newThreadsInSandboxes()) throw new ApiError(409, "cloudroom_move_unavailable", "Cloud sandboxes are off for this account.");
  await teleportToLocal(deps, threadId);
  return teleports(deps).begin(threadId, choice);
}
