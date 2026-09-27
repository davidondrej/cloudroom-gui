import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { cloudroomThreads } from "@bb/db";

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
};
const body = async (req: import("node:http").IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
const waitFor = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  if (!check()) throw new Error(`timed out: ${label}`);
};

it("gives each cloud thread its own sandbox, wakes it only for work, and archives it through the website", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const capture = vi.spyOn(harness.deps.telemetry, "capture");
  const website: { action: string; thread?: string; auth?: string }[] = [];
  const core: { path: string; auth?: string }[] = [];
  let state: "new" | "awake" | "asleep" | "archived" = "new";
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push({ path: req.url!, auth: req.headers.authorization });
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push({ action: input.action ?? input.name, thread: input.thread, auth: req.headers.authorization });
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "wake") state = "awake";
    if (input.action === "archive") state = "archived";
    const view = { thread: input.thread, state, generation: state === "awake" ? 1 : 0, issue: null };
    return json(state === "awake" ? { ...view, origin: coreUrl, token: "t".repeat(64) } : view);
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const request = (path: string, value?: unknown) => harness.app.request(`/api/v1${path}`, { method: value === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    const account = { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" };
    await service.configure(null, account, undefined, websiteUrl, "a".repeat(64));
    const status = await (await request("/cloudroom")).json();
    expect(status).toMatchObject({ ready: true, account });
    expect(JSON.stringify(status)).not.toContain("a".repeat(64));

    const created = await request("/threads", { executionTarget: "cloud", requestId: "sandbox-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "Work in your own sandbox", mentions: [] }] });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as { id: string };
    const saved = () => harness.deps.db.select().from(cloudroomThreads).get()!;
    expect(saved().coreUrl).toBe(`sandbox:${thread.id}`);
    await waitFor(() => saved().sessionId === "cr_one", "cloud start");
    expect(website.map(call => call.action)).toEqual(expect.arrayContaining(["register", "wake"]));
    expect(website.every(call => call.auth === `Basic ${Buffer.from(`${account.id}:${"a".repeat(64)}`).toString("base64")}`)).toBe(true);
    expect(core.find(call => call.path === "/v1/sessions")?.auth).toBe(`Bearer ${"t".repeat(64)}`);

    // The sandbox falls asleep. Idle delivery ticks must not wake it.
    state = "asleep";
    service.sandboxes.forget(thread.id);
    const wakes = () => website.filter(call => call.action === "wake").length;
    const before = wakes();
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(wakes()).toBe(before);

    // New work wakes it, and the message reaches the sandbox's Core.
    const sent = await request(`/threads/${thread.id}/send`, { requestId: "follow-up", mode: "auto", input: [{ type: "text", text: "Follow-up", mentions: [] }] });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => wakes() > before, "wake for new work");
    await waitFor(() => core.some(call => call.path.startsWith("/v1/sessions/cr_one/prompts")), "prompt delivery");
    // Cloud threads and messages count in anonymous usage, tagged with where they run.
    expect(capture).toHaveBeenCalledWith({ name: "thread_created", properties: { execution: "cloud_sandbox", is_child_thread: false, provider: "codex" } });
    expect(capture).toHaveBeenCalledWith({ name: "user_message_sent", properties: { execution: "cloud_sandbox", is_child_thread: false, message_source: "thread_create", provider: "codex" } });
    expect(capture).toHaveBeenCalledWith({ name: "user_message_sent", properties: { execution: "cloud_sandbox", is_child_thread: false, message_source: "thread_send", provider: "codex" } });

    // Archive goes to the website, which stops the sandbox even mid-task.
    expect((await harness.app.request(`/api/v1/threads/${thread.id}/archive-all`, { method: "POST" })).status).toBeLessThan(300);
    await waitFor(() => website.some(call => call.action === "archive" && call.thread === thread.id), "archive");
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("moving back to the VM: new threads start on the VM while sandbox threads stay put", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let sandboxesOn = true;
  const savedLogins: string[] = [];
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    // The VM runs Cursor; sandboxes (token t…) do not.
    const vm = req.headers.authorization === `Bearer ${"v".repeat(64)}`;
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }, ...(vm ? [{ id: "cursor", model: "default" }] : [])] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: `cr_${input.request_id}`, receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const coreUrl = await listen(coreServer);
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") { if (input.name) savedLogins.push(input.name); return res.end(JSON.stringify({ saved: true, claude: false, codex: false, pi: false, github: false, cursor: false })); }
    if (input.action === "mode") return res.end(JSON.stringify({ sandboxes: sandboxesOn }));
    res.end(JSON.stringify({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) }));
  });
  const websiteUrl = await listen(websiteServer);
  const request = (path: string, value: unknown) => harness.app.request(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const start = async (id: string) => {
    const created = await request("/threads", { executionTarget: "cloud", requestId: id, projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "Hi", mentions: [] }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = (await created.json()) as { id: string };
    return harness.deps.db.select().from(cloudroomThreads).all().find(row => row.threadId === thread.id)!;
  };
  try {
    await service.configure({ url: coreUrl, token: "v".repeat(64) }, { id: "11111111-1111-4111-8111-111111111111", email: "vm@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const inSandbox = await start("with-sandboxes");
    expect(inSandbox.coreUrl).toBe(`sandbox:${inSandbox.threadId}`);
    // An account that still has a VM connects Claude for its sandboxes too, where its new threads run.
    await service.claudeAuth("token", undefined, "sk-ant-oat01-test", "max");
    expect(savedLogins).toContain("claude");
    // Cursor too, with an API key. The picker offers what sandboxes run, never the VM's harnesses.
    expect(await service.cursorAuth()).toMatchObject({ state: "limited" });
    await service.cursorAuth("key", undefined, "key_cursor");
    expect(savedLogins).toContain("cursor");
    await vi.waitFor(async () => expect((await service.status()).harnesses?.map(h => h.id)).toEqual(["codex"]));
    sandboxesOn = false;
    (service.sandboxes as unknown as { mode: null }).mode = null;
    const onVm = await start("moved-back");
    expect(onVm.coreUrl).toBe(coreUrl);
    // Only VM threads can move into a sandbox, and only while sandboxes are on.
    expect((await request(`/cloudroom/threads/${inSandbox.threadId}/teleport`, { action: "move" })).status).toBe(409);
    expect((await request(`/cloudroom/threads/${onVm.threadId}/teleport`, { action: "move" })).status).toBe(409);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});
