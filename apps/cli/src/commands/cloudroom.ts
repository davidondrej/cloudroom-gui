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
  group.command("retry-start <thread-id>").description("Explicitly retry a rejected cloud start with its saved prompt").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    await createCliBbSdk(getUrl()).cloudroom.retryStart(threadId);
    if (!outputJson(options, { ok: true })) console.log("Cloud start retried with the original request ID.");
  }));
  group.command("thread-workspace <thread-id>").description("Show a cloud thread's current checkout and branch").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    const workspace = await createCliBbSdk(getUrl()).cloudroom.threadWorkspace(threadId);
    if (!outputJson(options, workspace)) console.log(workspace ? `${workspace.path}\n${workspace.branch ?? workspace.head ?? "No Git repository"}` : "Cloud session is not ready.");
  }));
}
