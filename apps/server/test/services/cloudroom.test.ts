import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as sync from "../../src/services/cloudroom/sync.js";
import { listQueuedCommands } from "../helpers/commands.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedEnvironment, seedHostSession, seedPrimaryHost, seedProjectWithSource, seedThread } from "../helpers/seed.js";
import { createThread, getThread, events, cloudroomThreads, cloudroomCommands } from "@bb/db";

it("reads checkout metadata from the thread's cloud session, never its local project", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let branch = "cloud-only";
  let unavailable = false;
  const core = createServer((req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    expect(req.headers.authorization).toBe(`Bearer ${"x".repeat(40)}`);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, harnesses: [] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/sessions/cr_checkout/workspace") return unavailable ? json({}, 404) : json({ path: "/code/test", branch, head: "a".repeat(40) });
    json({}, 404);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await service.configure({ url, token: "x".repeat(40) });
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "checkout", sessionId: "cr_checkout", model: "test-model", reasoning: "medium" }).run();
    const read = () => harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/workspace`);
    expect(await (await read()).json()).toEqual({ path: "/code/test", branch, head: "a".repeat(40) });
    branch = "changed-in-cloud";
    expect(await (await read()).json()).toMatchObject({ branch });
    unavailable = true;
    expect((await read()).ok).toBe(false);
    expect(listQueuedCommands(harness, "workspace.status")).toHaveLength(0);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
});

it("validates cloud reasoning, holds rejected starts across restart, and retries only on request", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const attempts: Record<string, number> = {};
  const prompts: object[] = [];
  let reject = true;
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["high", "xhigh", "max"] }] }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      attempts[body.request_id] = (attempts[body.request_id] ?? 0) + 1;
      expect(body.reasoning).toBe("max");
      if (body.request_id === "temporary" && attempts.temporary === 1) return json({ code: "storage_blocked" }, 409);
      if (body.request_id === "lost-reply" && attempts["lost-reply"] === 1) { req.socket.destroy(); return; }
      if (reject) return json({ code: "invalid_reasoning_effort", error: "SECRET-CANARY" }, 409);
      return json({ session_id: `cr_${body.request_id}`, receipt: { request_id: body.request_id, command: "start", state: "accepted", input: {} }, saving: {} }, 202);
    }
    prompts.push(body);
    json({ session_id: req.url!.split("/")[3], receipt: { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } }, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const input = { executionTarget: "cloud", requestId: "max-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "max", environment: { type: "project-default" }, input: [{ type: "text", text: "Keep this exact prompt", mentions: [] }] };
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const invalid = await request("/threads", { ...input, reasoningLevel: "ultra" });
    expect(invalid.status).toBe(400);
    expect(attempts).toEqual({});
    expect(harness.deps.db.select().from(cloudroomThreads).all()).toHaveLength(0);
    expect((await request("/threads", input)).status).toBe(201);
    const saved = harness.deps.db.select().from(cloudroomThreads).get()!;
    await expect.poll(() => service.threadStatus(saved.threadId)).toMatchObject({ failedStart: true, sessionId: null, pendingDelivery: 0 });
    expect(getThread(harness.deps.db, saved.threadId)?.status).toBe("error");
    expect(service.threadStatus(saved.threadId)?.error).not.toContain("SECRET-CANARY");
    expect((await request(`/threads/${saved.threadId}/send`, { mode: "auto", input: [{ type: "text", text: "Must not be accepted", mentions: [] }] })).status).toBe(409);
    reject = false;
    service.stop(); service.start();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(attempts["max-start"]).toBe(1);
    expect(prompts).toEqual([]);
    expect((await request(`/cloudroom/threads/${saved.threadId}/retry-start`, {})).status).toBe(200);
    expect(attempts["max-start"]).toBe(2);
    expect(prompts).toEqual([expect.objectContaining({ text: "Keep this exact prompt" })]);
    expect((await request("/threads", input)).status).toBe(201);
    expect(attempts["max-start"]).toBe(2);
    expect(prompts).toHaveLength(1);
    expect((await request("/threads", { ...input, requestId: "temporary" })).status).toBe(201);
    await expect.poll(() => attempts.temporary, { timeout: 4000 }).toBe(2);
    expect((await request("/threads", { ...input, requestId: "lost-reply" })).status).toBe(201);
    await expect.poll(() => attempts["lost-reply"], { timeout: 4000 }).toBe(2);
    expect(harness.deps.db.select().from(cloudroomThreads).all().filter(row => row.startRequestId === "lost-reply")).toHaveLength(1);
    const legacy = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "pending" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: legacy.id, coreUrl: `http://127.0.0.1:${address.port}`, startRequestId: "legacy", model: "test-model", reasoning: "max", error: "Cloudroom rejected the request (HTTP 409)" }).run();
    harness.deps.db.insert(cloudroomCommands).values({ id: `first_${legacy.id}`, threadId: legacy.id, command: "prompt", input: JSON.stringify({ text: "Saved old prompt" }), createdAt: Date.now() }).run();
    service.stop(); service.start();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(attempts.legacy).toBeUndefined();
    expect(service.threadStatus(legacy.id)).toMatchObject({ failedStart: true, pendingDelivery: 0 });
    expect((await request(`/cloudroom/threads/${legacy.id}/retry-start`, {})).status).toBe(200);
    expect(attempts.legacy).toBe(1);
    expect(prompts).toContainEqual(expect.objectContaining({ text: "Saved old prompt" }));
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 15000);

it("routes Cloud through the core, projects conversations, pauses queues, and replays after detach without native hosts", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const token = "fixture-" + "x".repeat(40);
  const gateToken = "synthetic-boat-gate";
  let coreRequests = 0;
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const receipts = new Map<string, object>();
  let sid = "";
  let stopped = false;
  let active: string | null = null;
  const pending: string[] = [];
  let starts = 0;
  let droppedReply = false;
  const record = (kind: string, data: object, native?: object) => {
    const sequence = records.length + 1;
    const value = { sequence, timestamp_ms: 1700000000000 + sequence, session_id: sid, kind, data, ...(native ? { native: JSON.stringify(native) } : {}) };
    records.push(value);
    const frame = `id: ${sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const receipt = (id: string, command: string, state: string, input: object = {}) => {
    const value = { request_id: id, command, state, input };
    receipts.set(id, value);
    record("receipt", value);
    return value;
  };
  const native = (method: string, params: object) => record("native_event", {}, { method, params: { threadId: "native", ...params } });
  const begin = (id: string) => {
    active = id;
    record("state", { state: "starting_turn", request_id: id });
    native("turn/started", { turn: { id, status: "inProgress" } });
    native("item/started", { item: { id: "tool", type: "commandExecution", command: "pwd", cwd: "/code/test", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null }, turnId: id });
    native("item/completed", { item: { id: "tool", type: "commandExecution", command: "pwd", cwd: "/code/test", status: "completed", aggregatedOutput: "/code/test", exitCode: 0, durationMs: 1 }, turnId: id });
    native("item/started", { item: { id: "answer", type: "agentMessage", text: "" }, turnId: id });
    native("item/agentMessage/delta", { itemId: "answer", turnId: id, delta: "Working in Cloud" });
    record("state", { state: "running", request_id: id, turn_id: id });
  };
  const finish = () => {
    native("item/completed", { item: { id: "answer", type: "agentMessage", text: "Cloud result" }, turnId: active });
    native("turn/completed", { turn: { id: active, status: "completed" } });
    receipt(active!, "prompt", "completed");
    active = null;
    record("state", { state: "idle" });
  };
  const core = createServer(async (req, res) => {
    coreRequests++;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.cookie !== `_port_auth=${gateToken}`) return json({}, 403);
    if (req.headers.authorization !== `Bearer ${token}`) return json({}, 401);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (let i = after; i < records.length; i++) res.write(`id: ${i + 1}\nevent: record\ndata: ${JSON.stringify(records[i])}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const id = body.request_id;
    if (receipts.has(id)) return json({ session_id: sid, receipt: receipts.get(id), saving: {} }, 202);
    if (req.url === "/v1/sessions") {
      starts++;
      sid = `cr_${id}`;
      expect(body.model).toBe("test-model");
      expect(body.reasoning).toBe("high");
      const accepted = receipt(id, "start", "completed");
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: accepted, saving: {} }, 202);
    }
    const action = req.url!.split("/").at(-1);
    const command = action === "prompts" ? "prompt" : action!;
    const accepted = receipt(id, command, "accepted", command === "prompt" ? { text: body.text } : {});
    if (command === "prompt") {
      if (!active && !stopped) begin(id); else pending.push(id);
    }
    if (command === "stop") { stopped = true; if (active) finish(); receipt(id, command, "completed"); }
    if (command === "resume") { stopped = false; receipt(id, command, "completed"); if (pending.length) begin(pending.shift()!); }
    if (id === "follow" && !droppedReply) { droppedReply = true; res.destroy(); return; }
    json({ session_id: sid, receipt: accepted, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const connection = { url: `http://127.0.0.1:${address.port}`, token, gateToken, projectId: project.id };
    const malformed = await request("/cloudroom", { ...connection, token: `${token}\t` });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(coreRequests).toBe(0);
    await expect(service.configure({ ...connection, gateToken: undefined })).rejects.toThrow("authentication");
    await expect(service.configure({ ...connection, gateToken: "wrong-gate" })).rejects.toThrow("authentication");
    await service.configure(connection);
    const status = await (await request("/cloudroom")).text();
    expect(status).not.toContain(token);
    expect(status).not.toContain(gateToken);
    const input = { executionTarget: "cloud", requestId: "create", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "first\n\nRead at least 15 sources.", mentions: [] }] };
    const response = await request("/threads", input);
    expect(response.status, await response.clone().text()).toBe(201);
    const thread = await response.json();
    expect(thread.executionTarget).toBe("cloud");
    expect(thread.titleFallback).toBe("first Read at least 15 sources.");
    expect(thread.environmentId).toBeNull();
    const initialMessage = harness.db.select().from(events).all().find(event => event.type === "client/turn/requested");
    expect(initialMessage).toBeDefined();
    expect(initialMessage?.createdAt).toBe(harness.db.select().from(cloudroomCommands).all().find(row => row.id === `first_${thread.id}`)?.createdAt);
    await expect.poll(() => ({ status: getThread(harness.db, thread.id)?.status, error: service.threadStatus(thread.id)?.error })).toEqual({ status: "active", error: null });
    expect(records).toContainEqual(expect.objectContaining({ kind: "receipt", data: expect.objectContaining({ command: "prompt", input: { text: "first\n\nRead at least 15 sources." } }) }));
    expect((await request("/threads", input)).status).toBe(201);
    expect(starts).toBe(1);
    const followUp = { requestId: "follow", mode: "auto", input: [{ type: "text", text: "follow up", mentions: [] }] };
    expect((await request(`/threads/${thread.id}/send`, followUp)).status).toBe(503);
    expect((await request(`/threads/${thread.id}/send`, followUp)).status).toBe(200);
    expect(pending).toEqual(["follow"]);
    await expect.poll(() => service.queue(thread.id).length).toBe(1);
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    expect(harness.db.select().from(events).all().filter((event) => JSON.parse(event.data).input?.[0]?.text === "follow up")).toHaveLength(0);
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    expect(service.queue(thread.id)).toHaveLength(1);
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    const count = harness.db.select().from(events).all().length;
    service.stop();
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(harness.db.select().from(events).all()).toHaveLength(count);
    expect((await request(`/cloudroom/threads/${thread.id}/resume`, { requestId: "resume" })).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    const stored = harness.db.select().from(events).all();
    expect(stored.some((event) => event.type === "item/agentMessage/delta")).toBe(true);
    expect(stored.filter((event) => event.type === "turn/started")).toHaveLength(2);
    expect(stored.filter((event) => event.type === "client/turn/requested")).toHaveLength(2);
    expect(stored.some((event) => JSON.parse(event.data).item?.type === "userMessage")).toBe(false);
    expect(stored.filter((event) => JSON.parse(event.data).item?.type === "commandExecution")).toHaveLength(4);
    expect(stored.find((event) => event.type === "client/turn/requested")).toEqual(initialMessage);
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    const tabs = await (await request(`/threads/${thread.id}/tabs`)).json();
    const savedTabs = await harness.app.request(`/api/v1/threads/${thread.id}/tabs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: tabs.revision, tabs: tabs.tabs }) });
    expect(savedTabs.status).toBe(200);
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "archive-active" })).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "archive-queued" })).status).toBe(200);
    const archived = await request(`/threads/${thread.id}/archive-all`, {});
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, archivedThreadIds: [thread.id] });
    expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(pending).toEqual(["archive-queued"]);
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    expect((await request(`/threads/${thread.id}/unarchive`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    expect(service.threadStatus(thread.id)?.paused).toBe(true);
    expect((await request(`/cloudroom/threads/${thread.id}/resume`, { requestId: "after-archive" })).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect(starts).toBe(1);
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect((await request(`/threads/${thread.id}/compact`, {})).status).toBe(409);
    expect((await request("/threads", { ...input, requestId: "bad", environment: { type: "host", hostId: host.id, workspace: { type: "personal" } } })).status).toBe(400);
    expect(starts).toBe(1);
    expect(harness.db.select().from(cloudroomThreads).all()).toHaveLength(1);
    await expect(service.configure({ ...connection, token: "wrong-" + token })).rejects.toThrow("authentication");
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "offline" })).status).toBe(503);
    expect(getThread(harness.db, thread.id)?.executionTarget).toBe("cloud");
    expect(starts).toBe(1);
    expect((await request(`/threads/${thread.id}/archive-all`, {})).status).toBe(200);
    expect((await request(`/threads/${thread.id}/archive-all`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
    const pendingStops = harness.db.select().from(cloudroomCommands).all().filter((command) => command.command === "stop" && command.state === "sending");
    expect(pendingStops).toHaveLength(1);
    service.stop();
    core.listen(address.port, "127.0.0.1");
    await once(core, "listening");
    service.start();
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find((command) => command.id === pendingStops[0]!.id)?.state, { timeout: 5000 }).toBe("completed");
    expect(stopped).toBe(true);
    expect(starts).toBe(1);
    expect((await request(`/threads/${thread.id}/unarchive`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
}, 20000);

it.each([true, false])("starts without copying local files or waiting for sync (external target exists: %s)", async (targetExists) => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const { host } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  const root = join(harness.config.dataDir, "project");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "file"), "project contents");
  const target = join(harness.config.dataDir, "private-target");
  if (targetExists) await writeFile(target, "synthetic-secret");
  await symlink(target, join(root, "runtime/workspace"));
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: root });
  const workspace = { id: `bb_${project.id}`, path: "/code/project" };
  let available = true;
  let direct = false;
  let starts = 0;
  const paths: string[] = [];
  let requestText = "";
  const setup = vi.spyOn(sync, "setupSync").mockRejectedValue(new Error("Sync is broken"));
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!available) return json({}, 503);
    paths.push(req.url ?? "");
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: direct, sync: true, harnesses: [{ id:"codex", model:"test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    requestText += body;
    const input = JSON.parse(body || "{}");
    if (req.url === "/v1/sessions") {
      starts++;
      expect(input).toMatchObject({ workspace: workspace.id, workspace_name: expect.any(String) });
      return json({session_id:"cr_waiting",receipt:{request_id:input.request_id, command:"start", input, state:"accepted"}, saving:{}}, 202);
    }
    if (req.url === "/v1/sessions/cr_waiting/prompts") return json({session_id:"cr_waiting",receipt:{request_id:input.request_id,command:"prompt",input,state:"accepted"},saving:{}},202);
    return json({},404);
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "fixture-" + "x".repeat(40), projectId: project.id });
    available = false;
    const created = await harness.app.request('/api/v1/threads', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ executionTarget:'cloud', requestId:'background-start', projectId:project.id, providerId:'codex', origin:'app', model:'test-model', reasoningLevel:'high', environment:{type:'project-default'}, input:[{type:'text',text:'Keep my message',mentions:[]}] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    expect(starts).toBe(0);
    expect(harness.db.select().from(cloudroomCommands).all().some(row => row.threadId === thread.id && row.input.includes('Keep my message'))).toBe(true);
    expect(await (await harness.app.request(`/api/v1/threads/${thread.id}/queued-messages`)).json()).toEqual([]);
    const firstMessages = () => harness.db.select().from(events).all().filter(event => event.threadId === thread.id && event.type === "client/turn/requested");
    expect(firstMessages()).toHaveLength(1);
    expect(JSON.stringify(await (await harness.app.request(`/api/v1/threads/${thread.id}/timeline`)).json())).toContain("Keep my message");
    const originalMessage = firstMessages()[0];
    await expect.poll(() => service.threadStatus(thread.id)?.error).toBeTruthy();
    service.stop();
    available = true;
    service.start();
    await expect.poll(() => service.threadStatus(thread.id)?.error, { timeout: 4000 }).toContain("Update the cloud core");
    expect(starts).toBe(0);
    direct = true;
    await expect.poll(() => starts, { timeout: 5000 }).toBe(1);
    expect(requestText).not.toContain(target);
    expect(requestText).not.toContain('synthetic-secret');
    await expect.poll(() => service.threadStatus(thread.id)?.pendingDelivery).toBe(0);
    const state = await (await harness.app.request(`/api/v1/cloudroom/threads/${thread.id}`)).json();
    expect(state).toMatchObject({ sessionId: "cr_waiting", error: null, starting: true });
    service.stop(); service.start();
    expect(firstMessages()).toEqual([originalMessage]);
    expect(service.queue(thread.id)).toEqual([]);
    expect(state).not.toHaveProperty("syncProgress");
    expect(paths.some(path => path.startsWith("/v1/workspaces"))).toBe(false);
    expect(requestText).toContain("Keep my message");
    expect(requestText).not.toContain("project contents");
    expect(setup).toHaveBeenCalled();
    expect(listQueuedCommands(harness, "workspace.status")).toHaveLength(0);
  } finally {
    setup.mockRestore();
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
});

it.each(["starting", "stopping"] as const)("archives and restores a %s Cloud child without a native environment or connection", async (status) => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const parent = seedThread(harness.deps, { projectId: project.id });
    const child = createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status });
    const response = await harness.app.request(`/api/v1/threads/${parent.id}/archive-all`, { method: "POST" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, archivedThreadIds: [child.id, parent.id] });
    for (const id of [parent.id, child.id]) {
      expect(getThread(harness.db, id)?.archivedAt).not.toBeNull();
      expect((await harness.app.request(`/api/v1/threads/${id}/unarchive`, { method: "POST" })).status).toBe(200);
      expect(getThread(harness.db, id)?.archivedAt).toBeNull();
    }
  } finally {
    await harness.cleanup();
  }
});


it.each(["codex", "pi"])("renames a Cloud %s thread offline without native execution or execution-setting changes", async (providerId) => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const environment = seedEnvironment(harness.deps, { projectId: project.id, hostId: host.id, status: "ready" });
    for (const environmentId of [null, environment.id]) {
      const thread = createThread(harness.db, harness.hub, { projectId: project.id, environmentId, executionTarget: "cloud", providerId, status: "active", title: "Before" });
      const patch = (body: unknown) => harness.app.request(`/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const renamed = await patch({ title: "Queue test" });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: thread.id, title: "Queue test", executionTarget: "cloud" });
      expect(getThread(harness.db, thread.id)).toMatchObject({ title: "Queue test", status: "active" });
      const fetched = await harness.app.request(`/api/v1/threads/${thread.id}`);
      expect(await fetched.json()).toMatchObject({ title: "Queue test" });
      for (const body of [{ title: "" }, { title: 42 }]) expect((await patch(body)).status).toBe(400);
      for (const body of [{ title: "Blocked", model: "other-model" }, { title: "Blocked", reasoningLevel: "high" }, { title: "Blocked", parentThreadId: "other-thread" }]) {
        expect((await patch(body)).status).toBe(409);
        expect(getThread(harness.db, thread.id)?.title).toBe("Queue test");
      }
      expect((await patch({ title: null })).status).toBe(200);
      expect(getThread(harness.db, thread.id)?.title).toBeNull();
    }
    expect(listQueuedCommands(harness, "thread.rename")).toEqual([]);
    expect(harness.db.select().from(cloudroomCommands).all()).toEqual([]);
  } finally { await harness.cleanup(); }
});

it("keeps each queued follow-up's reasoning and rejects locked or conflicting changes", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: object[] = [];
  let promptReasoning = false;
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let sid = "";
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, ...(promptReasoning ? { prompt_reasoning: true } : {}), harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["medium", "high", "xhigh", "max"] }] }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      sid = "cr_reasoning";
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    prompts.push(body);
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text, ...(body.reasoning ? { reasoning: body.reasoning } : {}) } };
    record("receipt", receipt);
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const send = (threadId: string, body: object) => harness.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "reason-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    const text = [{ type: "text", text: "queued", mentions: [] }];
    expect((await send(thread.id, { requestId: "same-launch", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(200);
    expect(prompts.at(-1)).toEqual({ request_id: "same-launch", text: "queued" });
    expect((await send(thread.id, { requestId: "needs-core", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    expect(prompts.some((body) => (body as { request_id?: string }).request_id === "needs-core")).toBe(false);
    promptReasoning = true;
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(200);
    expect((await send(thread.id, { requestId: "xhigh-turn", mode: "auto", reasoningLevel: "xhigh", input: text })).status).toBe(200);
    expect(prompts.map((body) => (body as { reasoning?: string }).reasoning)).toEqual([undefined, undefined, "max", "xhigh"]);
    expect(service.queue(thread.id).map((item) => item.reasoningLevel)).toEqual(["high", "max", "xhigh"]);
    expect(service.threadStatus(thread.id)?.reasoning).toBe("xhigh");
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(200);
    expect(prompts).toHaveLength(4);
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(409);
    expect((await send(thread.id, { mode: "auto", model: "other-model", reasoningLevel: "max", input: text })).status).toBe(409);
    expect((await send(thread.id, { mode: "auto", reasoningLevel: "low", input: text })).status).toBe(400);
    expect((await send(thread.id, { requestId: "plain", mode: "auto", input: text })).status).toBe(200);
    expect(prompts.at(-1)).toEqual({ request_id: "plain", text: "queued" });
    record("state", { state: "starting_turn", request_id: "max-turn" });
    record("state", { state: "starting_turn", request_id: "xhigh-turn" });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).execution.reasoningLevel)).toEqual(["high", "max", "xhigh"]);
    expect(service.threadStatus(thread.id)?.reasoning).toBe("high");
    expect(harness.db.select().from(cloudroomThreads).get()?.reasoning).toBe("high");
    harness.deps.db.insert(cloudroomCommands).values({ id: "legacy-launch", threadId: thread.id, command: "prompt", input: JSON.stringify({ text: "queued", reasoning: "high" }), state: "sending", createdAt: Date.now() }).run();
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(200);
    expect(prompts.at(-1)).toMatchObject({ request_id: "legacy-launch", text: "queued", reasoning: "high" });
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    record("receipt", { request_id: "plain", command: "prompt", state: "failed", error: "Pi model does not support the selected thinking level" });
    await expect.poll(() => harness.db.select().from(events).all().some((event) => event.type === "system/error" && JSON.parse(event.data).message.includes("thinking level"))).toBe(true);
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("edits and cancels queued Cloud prompts, then steers, compacts, and rewinds through core", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const commands: object[] = [];
  const sid = "cr_features";
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/capabilities") return json({
      version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true,
      structured_prompt: true, queue_edit: true, queue_cancel: true, steer: true, rewind: true, compact: true,
      harnesses: [{ id: "codex", model: "test-model", service_tier: true, steer: true, compact: true, rewind: true }],
    });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    commands.push({ url: req.url, ...body });
    if (req.url === "/v1/sessions") {
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    if (String(req.url).endsWith("/edit") && body.text === "rejected edit") return json({ error: "already dispatched" }, 409);
    const path = String(req.url ?? "");
    const command = path.endsWith("/prompts") ? "prompt" : path.split("/").pop() ?? "unknown";
    const receipt = { request_id: body.request_id, command, state: "accepted", input: body };
    record("receipt", receipt);
    if (command === "prompt" && String(body.request_id).startsWith("first_")) {
      record("state", { state: "starting_turn", request_id: body.request_id });
      record("checkpoint", { kind: "turn", id: `turn-${body.request_id}`, request_id: body.request_id });
      record("state", { state: "running", request_id: body.request_id });
    }
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown, method = "POST") => harness.app.request(`/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await request("/threads", { executionTarget: "cloud", requestId: "feature-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect((await request(`/threads/${thread.id}/send`, { requestId: "queued-1", mode: "auto", input: [{ type: "text", text: "old", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([expect.objectContaining({ id: "queued-1", content: [{ type: "text", text: "old", mentions: [] }] })]);
    const queued = service.queue(thread.id)[0]!;
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: [{ type: "text", text: "rejected edit", mentions: [] }], expectedUpdatedAt: queued.updatedAt }, "PATCH")).status).toBeGreaterThanOrEqual(400);
    expect(service.queue(thread.id)[0]).toMatchObject({ content: queued.content, updatedAt: queued.updatedAt });
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: [{ type: "text", text: "new", mentions: [] }], expectedUpdatedAt: queued.updatedAt - 1 }, "PATCH")).status).toBe(409);
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: [{ type: "text", text: "new", mentions: [] }], expectedUpdatedAt: queued.updatedAt }, "PATCH")).status).toBe(200);
    expect(service.queue(thread.id)[0]?.content).toEqual([{ type: "text", text: "new", mentions: [] }]);
    const confirmedRevision = service.queue(thread.id)[0]!.updatedAt;
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: [{ type: "text", text: "new", mentions: [] }], expectedUpdatedAt: queued.updatedAt }, "PATCH")).status).toBe(200);
    expect(service.queue(thread.id)[0]!.updatedAt).toBe(confirmedRevision);
    expect((await request(`/threads/${thread.id}/send`, { requestId: "queued-1", mode: "auto", input: queued.content })).status).toBe(200);
    expect(service.queue(thread.id)[0]?.content).toEqual([{ type: "text", text: "new", mentions: [] }]);
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/cancel"))).toBe(true);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    expect((await request(`/threads/${thread.id}/send`, { requestId: "steer-1", mode: "steer", input: [{ type: "text", text: "course correct", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/steer"))).toBe(true);
    record("state", { state: "idle" });
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect((await request(`/threads/${thread.id}/compact`, {})).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/compact"))).toBe(true);
    const requested = harness.db.select().from(events).all().find((event) => event.type === "client/turn/requested");
    expect((await request(`/threads/${thread.id}/edit-message`, { operationId: "edit-1", input: [{ type: "text", text: "rewritten", mentions: [] }], expectedRequestSequence: requested?.sequence })).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/rewind"))).toBe(true);
    expect(commands.some((item) => (item as { url?: string; text?: string }).url?.endsWith("/prompts") && (item as { text?: string }).text === "rewritten")).toBe(false);
    const rewind = commands.find((item) => (item as { url?: string }).url?.endsWith("/rewind")) as { request_id: string; before: string; replacement: { request_id: string; text: string; content: unknown } };
    expect(rewind.replacement.text).toBe("rewritten");
    record("rewind", { id: "corrected-native", request_id: rewind.request_id, before: rewind.before, replacement: { request_id: rewind.replacement.request_id, input: rewind.replacement } });
    record("state", { state: "starting_turn", request_id: rewind.replacement.request_id });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).input[0].text)).toEqual(["rewritten"]);
    expect((await request(`/threads/${thread.id}/edit-message`, { operationId: "edit-1", input: [{ type: "text", text: "rewritten", mentions: [] }], expectedRequestSequence: requested?.sequence })).status).toBe(200);
    expect(commands.filter((item) => (item as { url?: string }).url?.endsWith("/rewind"))).toHaveLength(1);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
});
