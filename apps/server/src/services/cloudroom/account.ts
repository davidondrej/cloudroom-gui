import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { getProject, type DbConnection } from "@bb/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { cloudroom } from "./commands.js";

const website = "https://www.cloudroom.dev";
const signInSchema = z.object({ projectId: z.string().min(1).optional(), websiteUrl: z.string().url().optional() }).strict();
const handoffSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  connection: z.object({ url: z.string().url(), token: z.string().min(32), gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional() }).strict(),
}).strict();
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry">;
type Pending = { server: Server; abort: AbortController; timer: ReturnType<typeof setTimeout>; claimed: boolean };
const accounts = new WeakMap<DbConnection, CloudroomAccountService>();

function callbackPage(success: boolean, message: string, nonce: string): string {
  const title = success ? "Account connected" : "Sign-in not completed";
  const escaped = message.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} | Cloudroom</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px;background:#0a0a0a;color:#fafafa;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:560px;padding:48px;border:1px solid #303030;background:#141414}.brand{color:inherit;text-decoration:none;font-size:28px;font-weight:700;letter-spacing:-1px}.brand span{color:#fd360e}.brand:focus-visible{outline:2px solid #fd360e;outline-offset:8px}
.status{display:flex;align-items:center;gap:12px;margin:44px 0 24px;color:#b5b5b5;font-size:12px;letter-spacing:1.5px;text-transform:uppercase}.symbol{display:grid;place-items:center;width:36px;height:36px;background:#fd360e;color:#0a0a0a}.symbol svg{width:22px;height:22px}
h1{margin:0 0 20px;font-size:clamp(28px,5vw,40px);font-weight:500;letter-spacing:-1.5px;line-height:1.15}p{margin:0;color:#b5b5b5;font-size:17px;line-height:1.65;overflow-wrap:anywhere}.next{margin-top:32px;padding-top:28px;border-top:1px solid #303030}.next strong{display:block;margin-bottom:8px;font-size:16px;font-weight:500}.next p{font-size:14px}.local{margin-top:32px;font-size:12px;color:#999}
@media(max-width:480px){main{padding:32px 24px}.status{margin-top:32px}}
</style></head><body><main>
<a class="brand" href="https://www.cloudroom.dev">cloudroom<span>.</span></a>
<div class="status"><span class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${success ? '<path d="m5 12 4 4L19 6"/>' : '<path d="M12 5v9m0 3v2"/>'}</svg></span>${success ? "Sign-in complete" : "Please try again"}</div>
<h1>${title}</h1><p>${escaped}</p>
<div class="next"><strong>${success ? "Return to the Cloudroom app" : "Start sign-in again from the Cloudroom app"}</strong><p>You can close this browser tab.</p></div>
<p class="local">This page is served by Cloudroom on your Mac.</p>
</main></body></html>`;
}

export function cloudroomAccount(deps: Deps) {
  let service = accounts.get(deps.db);
  if (!service) { service = new CloudroomAccountService(deps); accounts.set(deps.db, service); }
  return service;
}

export class CloudroomAccountService {
  private pending: Pending | null = null;
  private error: string | null = null;
  private attempt = 0;
  constructor(private readonly deps: Deps) {}

  async status() {
    return { ...await cloudroom(this.deps).status(), signingIn: this.pending !== null, signInError: this.error };
  }

  cancel(): void {
    this.attempt++;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.abort.abort();
      pending.server.close();
      pending.server.closeAllConnections();
    }
    this.error = null;
  }

  async logout(): Promise<void> {
    this.cancel();
    await cloudroom(this.deps).disconnect();
  }

  async signIn(raw: unknown): Promise<{ url: string }> {
    const input = signInSchema.parse(raw);
    if (input.projectId && !getProject(this.deps.db, input.projectId)) throw new ApiError(404, "project_not_found", "Project not found.");
    const origin = new URL(input.websiteUrl ?? website);
    if (origin.href !== `${origin.origin}/` || (origin.origin !== website && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port))) throw new ApiError(400, "invalid_request", "Use the Cloudroom website or an explicit loopback development server.");
    this.cancel();
    const attempt = this.attempt;
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("hex");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    const abort = new AbortController();
    let callback = "";
    const server = createServer(async (request, response) => {
      const reply = (status: number, message: string) => {
        const nonce = randomBytes(16).toString("hex");
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        response.end(callbackPage(status === 200, message, nonce));
      };
      if (request.method !== "POST" || request.url !== "/cloudroom/callback" || request.headers.host !== new URL(callback).host || request.headers.origin !== origin.origin || !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return reply(400, "Invalid sign-in callback. Return to Cloudroom.");
      let claimed = false;
      try {
        let text = "";
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 1024) return reply(413, "Invalid sign-in callback.");
        }
        const form = new URLSearchParams(text);
        const receivedState = form.get("state") ?? "";
        const code = form.get("code") ?? "";
        const pending = this.pending;
        if (!/^[a-f0-9]{64}$/.test(receivedState) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state)) || !/^[a-f0-9]{64}$/.test(code) || pending?.server !== server || pending.claimed) return reply(400, "Sign-in expired or did not match this app.");
        pending.claimed = true;
        claimed = true;
        const exchanged = await fetch(`${origin.origin}/api/desktop/redeem`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, verifier }),
          redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        if (!exchanged.ok) {
          await exchanged.body?.cancel();
          throw new ApiError(503, "cloudroom_signin_failed", exchanged.status === 401 ? "Sign-in expired or was already used. Try again." : "Cloudroom could not verify your account and existing VM. Try again or contact your administrator.");
        }
        const reader = exchanged.body?.getReader();
        if (!reader) throw new Error("Empty handoff");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16384) throw new Error("Invalid handoff");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const handoff = handoffSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        abort.signal.throwIfAborted();
        await cloudroom(this.deps).configure({ ...handoff.connection, projectId: input.projectId }, handoff.account, abort.signal);
        reply(200, "Your account is connected. Check your cloud connection in the app to continue.");
      } catch (error) {
        if (!abort.signal.aborted) {
          this.error = error instanceof ApiError ? error.message : "Sign-in could not complete. Start again from Cloudroom.";
          reply(400, this.error);
        }
      } finally {
        if (claimed && this.pending?.server === server) {
          clearTimeout(this.pending.timer);
          this.pending = null;
          server.close();
        }
      }
    });
    server.requestTimeout = 20_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (attempt !== this.attempt) { server.close(); throw new ApiError(409, "cloudroom_signin_cancelled", "Sign-in was cancelled or replaced."); }
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Sign-in callback unavailable"); }
    callback = `http://127.0.0.1:${address.port}/cloudroom/callback`;
    const timer = setTimeout(() => { if (this.pending?.server === server) { this.cancel(); this.error = "Sign-in expired. Try again."; } }, 5 * 60_000);
    timer.unref();
    this.pending = { server, abort, timer, claimed: false };
    return { url: `${origin.origin}/desktop?${new URLSearchParams({ callback, state, challenge })}` };
  }
}
