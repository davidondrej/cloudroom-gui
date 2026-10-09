import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "@cloudroom/tunnel-contract";
import { GATE_AUTH_HEADER, SESSION_COOKIE, TUNNEL_TARGET_HEADER } from "./protocol-headers";
import { parseVisitorHost, safeReturnPath } from "./worker";

type ClientWebSocket = NonNullable<
  Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
>;

const BASE = "cloudroom.test";
const INSTALL_ID = "0123456789abcdef0123456789abcdef";
const DESKTOP_AUTH = `Basic ${Buffer.from("user:token").toString("base64")}`;
const HTML = { accept: "text/html" };
const seen: { path: string; headers: Record<string, string>; target?: string }[] = [];
let website: () => MiniflareResponse = () => MiniflareResponse.json({ userId: "user-1" });
let mf: Miniflare;
let tunnel: ClientWebSocket;
let handle: string;
let credential: string;

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    target: "esnext",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });
  return result.outputFiles[0].text;
}

function fetchRelay(url: string, init: RequestInit = {}) {
  return mf.dispatchFetch(url, { redirect: "manual", ...init } as never);
}

async function register() {
  const response = await fetchRelay(`https://${BASE}/api/register`, {
    method: "POST",
    headers: { authorization: DESKTOP_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ installId: INSTALL_ID }),
  });
  if (response.status !== 200) throw new Error(`register ${response.status}: ${await response.text()}`);
  return (await response.json()) as { handle: string; credential: string; serverUrl: string };
}

async function dial(secret: string) {
  return fetchRelay(`https://${handle}.${BASE}/__tunnel?v=1`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${secret}` },
  });
}

function serveMac(ws: ClientWebSocket): void {
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const frame = decodeFrame(event.data as ArrayBuffer);
    if (frame.type !== "open-http") return;
    seen.push({
      path: frame.path,
      headers: Object.fromEntries(frame.headers.map(([k, v]) => [k.toLowerCase(), v])),
      ...(frame.target ? { target: frame.target } : {}),
    });
    const send = (out: Frame) => ws.send(new Uint8Array(encodeFrame(out)));
    send({
      type: "resp-head",
      streamId: frame.streamId,
      status: 200,
      headers: [["content-type", "text/plain"], ["cache-control", "no-store"]],
    });
    send({
      type: "body-chunk",
      streamId: frame.streamId,
      data: new TextEncoder().encode(`mac:${frame.target ?? "app"}:${frame.path}`),
    });
    send({ type: "body-end", streamId: frame.streamId });
  });
}

async function phoneCode(): Promise<string> {
  const response = await fetchRelay(`https://${BASE}/api/phone-code`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { code: string; url: string };
  expect(body.url).toBe(`https://${BASE}/pair?code=${body.code}`);
  return body.code;
}

function cookieFrom(response: { headers: { get(name: string): string | null } }): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  return setCookie.split(";")[0];
}

async function signInPhone(): Promise<string> {
  const code = await phoneCode();
  const apex = await fetchRelay(`https://${BASE}/pair?code=${code}`);
  expect(apex.status).toBe(302);
  const next = apex.headers.get("location")!;
  expect(new URL(next).host).toBe(`${handle}.${BASE}`);
  const paired = await fetchRelay(next);
  expect(paired.status).toBe(302);
  expect(paired.headers.get("location")).toBe("/");
  return cookieFrom(paired);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "/worker.js", contents: await bundle() }],
    modulesRoot: "/",
    scriptPath: "/worker.js",
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TUNNEL_DO: "TunnelDO" },
    d1Databases: { DB: "relay-test" },
    bindings: { BASE_DOMAIN: BASE, WEBSITE_URL: "https://website.test" },
    outboundService: () => website(),
  });
  const db = await mf.getD1Database("DB");
  const migration = readFileSync(
    fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)),
    "utf8",
  );
  for (const statement of migration.replace(/--.*$/gm, "").split(";")) {
    if (statement.trim()) await db.prepare(statement).run();
  }
  ({ handle, credential } = await register());
  const dialed = await dial(credential);
  if (!dialed.webSocket) throw new Error(`tunnel dial failed: ${dialed.status}`);
  tunnel = dialed.webSocket;
  serveMac(tunnel);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("Cloudroom Connect relay", () => {
  it("asks the website who the Mac belongs to before registering it", async () => {
    website = () => new MiniflareResponse("no", { status: 403 });
    const rejected = await fetchRelay(`https://${BASE}/api/register`, {
      method: "POST",
      headers: { authorization: DESKTOP_AUTH },
      body: JSON.stringify({ installId: INSTALL_ID }),
    });
    expect(rejected.status).toBe(401);
    website = () => MiniflareResponse.json({ userId: "user-1" });
    const unsigned = await fetchRelay(`https://${BASE}/api/register`, {
      method: "POST",
      body: JSON.stringify({ installId: INSTALL_ID }),
    });
    expect(unsigned.status).toBe(401);
  });

  it("keeps the address when the same Mac registers again and retires the old credential", async () => {
    const again = await register();
    expect(again.handle).toBe(handle);
    expect(again.credential).not.toBe(credential);
    expect((await dial(credential)).status).toBe(401);
    credential = again.credential;
    const dialed = await dial(credential);
    expect(dialed.status).toBe(101);
    tunnel.close();
    tunnel = dialed.webSocket!;
    serveMac(tunnel);
  });

  it("shows the code page to a phone that is not signed in", async () => {
    const page = await fetchRelay(`https://${handle}.${BASE}/`, { headers: HTML });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('action="/__pair"');
    const api = await fetchRelay(`https://${handle}.${BASE}/api/v1/threads`);
    expect(api.status).toBe(401);
  });

  it("signs a phone in with one code and relays it to the Mac", async () => {
    const cookie = await signInPhone();
    const response = await fetchRelay(`https://${handle}.${BASE}/api/v1/threads`, {
      headers: { cookie: `${cookie}; theme=dark` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mac:app:/api/v1/threads");
    const forwarded = seen.at(-1)!;
    expect(forwarded.headers[GATE_AUTH_HEADER]).toBe("session");
    expect(forwarded.headers.cookie).toBe("theme=dark");
  });

  it("refuses a code twice and rejects wrong codes", async () => {
    const code = await phoneCode();
    const first = await fetchRelay(`https://${handle}.${BASE}/__pair?code=${code}`);
    expect(first.status).toBe(302);
    const second = await fetchRelay(`https://${handle}.${BASE}/__pair?code=${code}`);
    expect(second.status).toBe(400);
    const wrong = await fetchRelay(`https://${BASE}/pair?code=AAAA-AAAA`);
    expect(wrong.status).toBe(400);
  });

  it("opens a shared port after a hop through the signed-in app", async () => {
    const cookie = await signInPhone();
    const share = `https://${handle}--3000.${BASE}`;
    const first = await fetchRelay(`${share}/page?x=1`, { headers: HTML });
    expect(first.status).toBe(302);
    const hop = first.headers.get("location")!;
    expect(hop).toBe(
      `https://${handle}.${BASE}/__share?port=3000&return=%2Fpage%3Fx%3D1`,
    );
    const ticket = await fetchRelay(hop, { headers: { cookie } });
    expect(ticket.status).toBe(302);
    const pair = await fetchRelay(ticket.headers.get("location")!);
    expect(pair.headers.get("location")).toBe("/page?x=1");
    const shareCookie = cookieFrom(pair);
    const page = await fetchRelay(`${share}/page?x=1`, { headers: { cookie: shareCookie } });
    expect(await page.text()).toBe("mac:3000:/page?x=1");
    expect(seen.at(-1)!.headers[TUNNEL_TARGET_HEADER]).toBeUndefined();
    const app = await fetchRelay(`https://${handle}.${BASE}/`, { headers: { cookie: shareCookie } });
    expect(app.status).toBe(401);
  });

  it("signs every phone out when the Mac asks", async () => {
    const cookie = await signInPhone();
    const revoke = await fetchRelay(`https://${BASE}/api/phone-sessions/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(((await revoke.json()) as { revoked: number }).revoked).toBeGreaterThan(0);
    const after = await fetchRelay(`https://${handle}.${BASE}/x`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("shows the offline page when the Mac is not connected", async () => {
    const cookie = await signInPhone();
    tunnel.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const page = await fetchRelay(`https://${handle}.${BASE}/`, {
      headers: { ...HTML, cookie },
    });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Your Mac is offline");
  });
});

describe("host and path parsing", () => {
  it("accepts handles and port shares only", () => {
    expect(parseVisitorHost(`abc.${BASE}`, BASE)).toEqual({ handle: "abc", target: null });
    expect(parseVisitorHost(`abc--8080.${BASE}`, BASE)).toEqual({ handle: "abc", target: "8080" });
    expect(parseVisitorHost(`abc--99999.${BASE}`, BASE)).toBeNull();
    expect(parseVisitorHost(`a.b.${BASE}`, BASE)).toBeNull();
    expect(parseVisitorHost(`evil.com`, BASE)).toBeNull();
  });

  it("only returns to paths on the same host", () => {
    expect(safeReturnPath("/thread/1?x=2")).toBe("/thread/1?x=2");
    expect(safeReturnPath("//evil.com")).toBe("/");
    expect(safeReturnPath("/\\evil.com")).toBe("/");
    expect(safeReturnPath("https://evil.com")).toBe("/");
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
  });
});
