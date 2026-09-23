import { randomUUID } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { getThread } from "@bb/db";
import { z } from "zod";
import { cloudroom, isCloudThread } from "./commands.js";
import { cloudroomAccount } from "./account.js";
import { teleports } from "./teleport.js";
import { teleportBlocked, teleportProgress } from "./store.js";
import { browserRequestProblem } from "../../browser-request-guard.js";

export function installCloudroomRoutes(app: Hono, deps: AppDeps): void {
  cloudroom(deps).teleportRecovery = () => teleports(deps).recover();
  app.get("/api/v1/cloudroom/threads/:id/teleport", context => context.json(teleportProgress(deps.db, context.req.param("id"))));
  app.post("/api/v1/cloudroom/threads/:id/teleport", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const body = z.object({ action: z.enum(["start", "cancel"]).default("start") }).strict().parse(await context.req.json());
    const id = context.req.param("id");
    if (body.action === "cancel") { await teleports(deps).cancel(id); return context.json(teleportProgress(deps.db, id), 202); }
    return context.json(await teleports(deps).begin(id), 202);
  });
  app.use("/api/v1/cloudroom/account/*", async (context, next) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    return next();
  });
  app.post("/api/v1/cloudroom/account/project", async (context) => {
    const input = z.object({ projectId: z.string().min(1) }).strict().parse(await context.req.json());
    await cloudroom(deps).selectOnboardingProject(input.projectId);
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/account", async (context) => context.json(await cloudroomAccount(deps).status()));
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
    if (teleportBlocked(deps.db, id)) {
      const suffix = context.req.path.slice(`/api/v1/threads/${id}`.length);
      if (!["/read", "/unread"].includes(suffix) && !(suffix === "/stop" && teleportProgress(deps.db, id)?.cloudStarted)) return context.json({ message: "Teleport is in progress. Wait for completion, or use Cancel before cloud execution starts.", code: "teleport_in_progress" }, 409);
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
      const head = cloudroom(deps).queue(thread.id)[0];
      if (!head || path.split("/")[2] !== head.id) return context.json({ message: "Cloud resumes queued messages in their original order" }, 409);
      const body = await context.req.json();
      if (body.mode === "steer") {
        await cloudroom(deps).send(thread, { mode: "steer-if-active", input: head.content, requestId: randomUUID() });
        return context.json({ ok: true, delivery: "sent" });
      }
      await cloudroom(deps).control(thread.id, "resume");
      return context.json({ ok: true, delivery: "queued", queuedMessage: head });
    }
    return context.json({ message: "This action is not enabled for Cloud threads. Native execution is blocked.", code: "cloudroom_unsupported" }, 409);
  };
  app.use("/api/v1/threads/:id", guard);
  app.use("/api/v1/threads/:id/*", guard);
}
