import { Command } from "commander";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

export function registerCloudroomCommands(program: Command, getUrl: () => string): void {
  const group = program.command("cloudroom").description("Connect this local app to your existing Cloudroom VM");
  group.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const status = await createCliBbSdk(getUrl()).cloudroom.status();
    if (!outputJson(options, status)) console.log(`${status.account?.email ?? "Signed out"}\n${status.signingIn ? "Waiting for browser confirmation" : status.ready ? "Cloud connected" : status.error ?? "Cloud unavailable"}${status.signInError ? `\n${status.signInError}` : ""}`);
  }));
  const codex = group.command("codex").description("Connect Codex on your cloud VM");
  codex.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.codexAuth();
    if (!outputJson(options, result)) console.log(`${result.state}${result.email ? ` · ${result.email}` : ""}${result.message ? `\n${result.message}` : ""}`);
  }));
  codex.command("login").requiredOption("--request-id <id>", "Reuse this ID after an uncertain response").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions & { requestId: string }) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.codexLogin(options.requestId);
    if (!outputJson(options, result)) console.log(result.state === "waiting" ? `Open ${result.verification_url}\nEnter code: ${result.user_code}\nRun room cloudroom codex status to verify.` : result.message ?? result.state);
  }));
  codex.command("cancel <request-id>").option("--json", "Print JSON").action(action(async (id: string, options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cancelCodexLogin(id);
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  const cursor = group.command("cursor").description("Connect Cursor on your cloud VM");
  cursor.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorAuth();
    if (!outputJson(options, result)) console.log(`${result.state}${result.email ? ` · ${result.email}` : ""}${result.verification_url ? `\nOpen ${result.verification_url}` : result.message ? `\n${result.message}` : ""}`);
  }));
  cursor.command("login").requiredOption("--request-id <id>", "Reuse this ID after an uncertain response").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions & { requestId: string }) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorLogin(options.requestId);
    if (!outputJson(options, result)) console.log(result.verification_url ? `Open ${result.verification_url}` : `${result.message ?? result.state}\nRun room cloudroom cursor status for the sign-in link.`);
  }));
  cursor.command("cancel <request-id>").option("--json", "Print JSON").action(action(async (id: string, options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cancelCursorLogin(id);
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  cursor.command("key").description("Read a Cursor API key from stdin, never a command argument").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    if (process.stdin.isTTY) throw new Error("Pipe your Cursor API key into this command.");
    let key = "";
    for await (const chunk of process.stdin) { key += String(chunk); if (key.length > 4097) throw new Error("Cursor key is too long"); }
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorApiKey(crypto.randomUUID(), key.trim());
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  group.command("sign-in").option("--project <id>", "Legacy prepared-project binding (optional)")
    .option("--website-url <url>", "Loopback website for local development")
    .option("--json", "Print JSON")
    .action(action(async (options: JsonOutputOptions & { project?: string; websiteUrl?: string }) => {
      const result = await createCliBbSdk(getUrl()).cloudroom.signIn({ projectId: options.project, websiteUrl: options.websiteUrl });
      if (!outputJson(options, result)) console.log(`Open this link in your browser:\n${result.url}`);
    }));
  for (const name of ["cancel", "logout"] as const) {
    group.command(name).option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
      await createCliBbSdk(getUrl()).cloudroom[name]();
      if (!outputJson(options, { ok: true })) console.log(name === "logout" ? "Signed out of this app. Cloud agents keep running." : "Sign-in cancelled.");
    }));
  }
  group.command("teleport <thread-id>").description("Move a local Codex or Pi thread to Cloud without changing its conversation")
    .option("--cancel", "Cancel before cloud execution starts")
    .option("--status", "Read transfer progress without changing it")
    .option("--json", "Print JSON")
    .action(action(async (threadId: string, options: JsonOutputOptions & { cancel?: boolean; status?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      const result = options.status ? await sdk.cloudroom.teleportStatus(threadId) : await sdk.cloudroom.teleport(threadId, options.cancel ? "cancel" : "start");
      if (!outputJson(options, result)) console.log(result ? `${result.phase}: ${result.completed}/${result.total} files${result.error ? `\n${result.error}` : ""}${result.phase === "complete" ? "\nRunning in cloud. You can close your laptop." : ""}` : "No Teleport transfer.");
    }));
  group.command("retry-start <thread-id>").description("Explicitly retry a rejected cloud start with its saved prompt").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    await createCliBbSdk(getUrl()).cloudroom.retryStart(threadId);
    if (!outputJson(options, { ok: true })) console.log("Cloud start retried with the original request ID.");
  }));
  group.command("thread-workspace <thread-id>").description("Show a cloud thread's current checkout and branch").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    const workspace = await createCliBbSdk(getUrl()).cloudroom.threadWorkspace(threadId);
    if (!outputJson(options, workspace)) console.log(workspace ? `${workspace.path}\n${workspace.branch ?? workspace.head ?? "No Git repository"}` : "Cloud session is not ready.");
  }));
}
