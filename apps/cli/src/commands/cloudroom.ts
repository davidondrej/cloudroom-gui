import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { resolveLocalHostId } from "../daemon.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

/** VM paths may start with ~ (the agent home); everything else stays literal. */
function quote(path: string): string {
  const [prefix, rest] = path === "~" ? ['"$HOME"', ""] : path.startsWith("~/") ? ['"$HOME"/', path.slice(2)] : ["", path];
  return rest ? `${prefix}'${rest.replaceAll("'", "'\\''")}'` : prefix;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Runs on the VM and fails with its error output unless the command succeeds. */
async function runOnVm(url: string, command: string, stdin = Buffer.alloc(0)): Promise<Buffer> {
  const result = await createCliBbSdk(url).cloudroom.runOnVm({ command, stdin: stdin.toString("hex") });
  if (result.truncated) throw new Error("Transfer exceeded the 16 MiB limit.");
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString() || `VM command failed (${result.code})`);
  return Buffer.from(result.stdout, "hex");
}

export function registerVmCommands(program: Command, getUrl: () => string): void {
  const vm = program.command("vm").description("Run commands and copy files on your cloud VM, as its agent account");
  vm.command("run <command>").description("Run a shell command on the VM (quote it). Exits with its code.")
    .option("--cwd <dir>", "VM folder, relative to the agent home")
    .option("--stdin", "Forward standard input")
    .action(action(async (command: string, options: { cwd?: string; stdin?: boolean }) => {
      const stdin = options.stdin ? await readStdin() : Buffer.alloc(0);
      const result = await createCliBbSdk(getUrl()).cloudroom.runOnVm({ command, stdin: stdin.toString("hex"), cwd: options.cwd });
      process.stdout.write(Buffer.from(result.stdout, "hex"));
      process.stderr.write(Buffer.from(result.stderr, "hex"));
      if (result.truncated) process.stderr.write("Output exceeded 16 MiB and was truncated.\n");
      process.exitCode = result.code ?? 1;
    }));
  vm.command("pull <vm-path> [local-folder]").description("Copy a VM file or folder to this Mac (default: current folder)")
    .action(action(async (source: string, target = ".") => {
      const archive = await runOnVm(getUrl(), `p=${quote(source)}; cd -- "$(dirname -- "$p")" && tar -czf - -- "$(basename -- "$p")"`);
      await mkdir(target, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const tar = spawn("tar", ["-xzf", "-", "-C", target], { stdio: ["pipe", "inherit", "inherit"] });
        tar.on("error", reject).on("close", (code) => code === 0 ? resolve() : reject(new Error("Could not unpack the copied files.")));
        tar.stdin.end(archive);
      });
      console.log(JSON.stringify({ copied: source, to: target }));
    }));
  vm.command("push <local-path> [vm-folder]").description("Copy a file or folder from this Mac to the VM (default: agent home)")
    .action(action(async (source: string, target = "~") => {
      const { stdout } = await promisify(execFile)("tar", ["--no-xattrs", "-czf", "-", "-C", dirname(source), "--", basename(source)],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
      await runOnVm(getUrl(), `d=${quote(target)}; mkdir -p -- "$d" && tar -xzf - -C "$d"`, stdout);
      console.log(JSON.stringify({ copied: source, to: target }));
    }));
}

export function registerImportCommands(program: Command, getUrl: () => string): void {
  const group = program.command("import").description("Bring work over from other agent apps");
  group.command("bb").description("Copy open BB threads into idle Local threads with full history. Sends no prompts; BB is never changed.")
    .option("--json", "Print JSON")
    .action(action(async (options: JsonOutputOptions) => {
      const result = await createCliBbSdk(getUrl()).cloudroom.importBb(await resolveLocalHostId());
      if (outputJson(options, result)) return;
      for (const thread of result.imported) console.log(`Imported  ${thread.title} → ${thread.threadId}`);
      for (const thread of result.skipped) console.log(`Skipped   ${thread.title}: ${thread.reason}`);
      if (!result.imported.length && !result.skipped.length) console.log("No open BB threads found.");
    }));
}

export function registerCloudCommands(program: Command, getUrl: () => string): void {
  const group = program.command("cloud").description("Connect this app to your Cloudroom account and VM");
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
    if (!outputJson(options, result)) console.log(result.state === "waiting" ? `Open ${result.verification_url}\nEnter code: ${result.user_code}\nRun cloudroom cloud codex status to verify.` : result.message ?? result.state);
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
    if (!outputJson(options, result)) console.log(result.verification_url ? `Open ${result.verification_url}` : `${result.message ?? result.state}\nRun cloudroom cloud cursor status for the sign-in link.`);
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
  const pi = group.command("pi").description("Connect Pi providers on your cloud VM");
  pi.command("key <provider>").description("Read a provider API key from stdin, never a command argument").option("--json", "Print JSON").action(action(async (provider: string, options: JsonOutputOptions) => {
    if (process.stdin.isTTY) throw new Error(`Pipe your ${provider} API key into this command.`);
    const result = await createCliBbSdk(getUrl()).cloudroom.piApiKey(provider, (await readStdin()).toString().trim());
    if (!outputJson(options, result)) console.log(`Saved. Pi on your VM has logins for: ${result.providers.join(", ")}`);
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
  group.command("teleport <thread-id>").description("Move a local Codex, Pi, Claude Code, or Cursor thread to Cloud without changing its conversation. Checks first that Cloud can run the same model and effort. Use --to-local to bring a Cloud Codex, Pi, or Claude Code thread back to this Mac")
    .option("--to-local", "Move a Cloud thread back to this Mac with its conversation and code changes")
    .option("--cancel", "Cancel before cloud execution starts")
    .option("--status", "Read transfer progress without changing it")
    .option("--model <model>", "Run in Cloud on this model instead (requires --reasoning)")
    .option("--reasoning <level>", "Reasoning level for --model")
    .option("--json", "Print JSON")
    .action(action(async (threadId: string, options: JsonOutputOptions & { cancel?: boolean; status?: boolean; model?: string; reasoning?: string; toLocal?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      if (options.toLocal) {
        const moved = await sdk.cloudroom.teleportLocal(threadId);
        if (!outputJson(options, moved)) console.log(`Moved to this Mac.${moved.conflicts ? ` ${moved.conflicts} changed files were kept in both versions; cloud copies are in .cloudroom/teleport/.` : ""}`);
        return;
      }
      if (Boolean(options.model) !== Boolean(options.reasoning)) throw new Error("Use --model and --reasoning together.");
      const choice = options.model && options.reasoning ? { model: options.model, reasoning: options.reasoning } : undefined;
      const result = options.status ? await sdk.cloudroom.teleportStatus(threadId) : await sdk.cloudroom.teleport(threadId, options.cancel ? "cancel" : "start", choice);
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
