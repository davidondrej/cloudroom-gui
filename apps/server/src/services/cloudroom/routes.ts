import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { getThread } from "@bb/db";
import { z } from "zod";
import { cloudroom, isCloudThread } from "./commands.js";
import { cloudroomAccount } from "./account.js";
import { setMacAccess } from "./previews.js";
import { setCopyLogins } from "./sync.js";
import { teleports } from "./teleport.js";
import { teleportBlocked, teleportProgress } from "./store.js";
import { browserRequestProblem } from "../../browser-request-guard.js";
import { claudePlan, createClaudeToken } from "./claude-token.js";
import { startClaudeVersionSync } from "./claude-version.js";
import { importBbThreads } from "./bb-import.js";
import { teleportingToLocal, teleportToLocal } from "./teleport-local.js";
import { archiveThreadAndChildren } from "../threads/thread-archive.js";

export function installCloudroomRoutes(app: Hono, deps: AppDeps): void {
  cloudroom(deps).teleportRecovery = () => teleports(deps).recover();
  cloudroom(deps).archiveRequest = (threadId) => {
    const thread = getThread(deps.db, threadId);
    if (!thread || thread.archivedAt || thread.deletedAt) return;
    try { archiveThreadAndChildren(deps, { parentThread: thread }); }
    catch (error) { deps.logger.warn({ error, threadId }, "Cloud self-archive failed"); }
  };
  startClaudeVersionSync(deps);
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
    const body = z.object({ action: z.enum(["start", "cancel", "local"]).default("start"), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() }).strict().parse(await context.req.json());
    const id = context.req.param("id");
    if (body.action === "cancel") { await teleports(deps).cancel(id); return context.json(teleportProgress(deps.db, id), 202); }
    if (body.action === "local") return context.json(await teleportToLocal(deps, id));
    const choice = body.model && body.reasoning ? { model: body.model, reasoning: body.reasoning } : undefined;
    return context.json(await teleports(deps).begin(id, choice), 202);
  });
  app.post("/api/v1/cloudroom/import/bb", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const input = z.object({ hostId: z.string().min(1) }).strict().parse(await context.req.json());
    return context.json(await importBbThreads(deps, input.hostId));
  });
  app.post("/api/v1/cloudroom/account/project", async (context) => {
    const input = z.object({ projectId: z.string().min(1) }).strict().parse(await context.req.json());
    await cloudroom(deps).selectOnboardingProject(input.projectId);
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/account", async (context) => context.json(await cloudroomAccount(deps).status()));
  app.post("/api/v1/cloudroom/account/mac-access", async (context) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await context.req.json());
    await setMacAccess(deps, input.enabled);
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/account/copy-logins", async (context) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await context.req.json());
    await setCopyLogins(deps, input.enabled);
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/vm/run", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const input = z.object({ command: z.string().min(1).max(65536), stdin: z.string().max(32 * 1024 * 1024).regex(/^(?:[0-9a-f]{2})*$/).optional(), cwd: z.string().min(1).max(4096).optional() }).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).runOnVm(input, context.req.raw.signal));
  });
  app.get("/api/v1/cloudroom/account/claude", async context => context.json(await cloudroom(deps).claudeAuth()));
  app.post("/api/v1/cloudroom/account/claude/setup-token", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app." }, problem.status);
    const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
    const token = await createClaudeToken(context.req.raw.signal);
    return context.json(await cloudroom(deps).claudeAuth("token", input.requestId, token, await claudePlan()));
  });
  app.post("/api/v1/cloudroom/account/claude/key", async context => {
    const parsed = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), apiKey: z.string().regex(/^sk-ant-api[A-Za-z0-9_-]{1,1014}$/) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_claude_key", "Paste an Anthropic API key. It starts with sk-ant-api.");
    return context.json(await cloudroom(deps).claudeAuth("key", parsed.data.requestId, parsed.data.apiKey));
  });
  for (const action of ["login", "cancel", "complete"] as const) {
    app.post(`/api/v1/cloudroom/account/claude/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...(action === "complete" ? { code: z.string().min(1).max(2048), state: z.string().min(1).max(512) } : {}) }).strict().parse(await context.req.json());
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
  app.post("/api/v1/cloudroom/threads/:id/resume", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const id = context.req.param("id");
    const thread = getThread(deps.db, id);
    if (!thread || !isCloudThread(thread) || thread.deletedAt || thread.archivedAt) return context.json({ message: "Cloud thread is not writable" }, 409);
    const body = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).parse(await context.req.json());
    await cloudroom(deps).control(id, "resume", body.requestId);
    return context.json({ ok: true });
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
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "title" || key === "reasoningLevel")) return next();
    }
    if (["/tabs", "/read", "/unread", "/pin", "/unpin", "/pin-order"].includes(path)) return next();
    if (context.req.method === "POST" && ["/archive-all", "/unarchive"].includes(path)) return next();
    if (context.req.method === "POST" && ["/send", "/queued-messages", "/stop", "/compact", "/edit-message"].includes(path)) return next();
    if (context.req.method === "PATCH" && /^\/queued-messages\/[^/]+$/.test(path)) return next();
    if (context.req.method === "DELETE" && /^\/queued-messages\/[^/]+$/.test(path)) return next();
    if (context.req.method === "POST" && /^\/queued-messages\/[^/]+\/send$/.test(path)) {
      return context.json(await cloudroom(deps).sendQueued(thread, path.split("/")[2]!));
    }
    return context.json({ message: "This action is not enabled for Cloud threads. Native execution is blocked.", code: "cloudroom_unsupported" }, 409);
  };
  app.use("/api/v1/threads/:id", guard);
  app.use("/api/v1/threads/:id/*", guard);
}
