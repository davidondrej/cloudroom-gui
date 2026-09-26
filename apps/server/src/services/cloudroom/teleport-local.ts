import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  cloudroomCommands,
  cloudroomThreads,
  createQueuedThreadMessageInTransaction,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getThread,
  listProjectSourcesByHost,
  listProjectSourcesByProjectIds,
  threadPluginMetadata,
  threads,
} from "@bb/db";
import { PERSONAL_PROJECT_ID, type Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { provisionUnmanagedEnvironmentForPath } from "../threads/thread-environment-directory.js";
import { getLastProviderThreadId } from "../threads/thread-events.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { cloudroom } from "./commands.js";
import type { CloudroomClient } from "./client.js";
import { SKIPPED } from "./project-copy.js";
import { binding, teleportProgress } from "./store.js";

type Harness = "codex" | "pi" | "claude-code";
const VM_SESSIONS: Record<Harness, string> = {
  codex: "$HOME/.codex/sessions",
  pi: "$HOME/.pi/agent/sessions",
  "claude-code": "$HOME/.claude/projects",
};
const CHUNK = 8 * 1024 * 1024;
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const moving = new Set<string>();

export const teleportingToLocal = (threadId: string) => moving.has(threadId);

export async function teleportToLocal(deps: AppDeps, threadId: string): Promise<{ conflicts: number }> {
  if (moving.has(threadId)) throw new ApiError(409, "teleport_in_progress", "Teleport to Local is already running.");
  moving.add(threadId);
  try {
    return await run(deps, threadId);
  } finally {
    moving.delete(threadId);
  }
}

async function run(deps: AppDeps, threadId: string): Promise<{ conflicts: number }> {
  const thread = getThread(deps.db, threadId);
  const saved = binding(deps.db, threadId);
  const harness = thread?.providerId as Harness | undefined;
  const phase = teleportProgress(deps.db, threadId)?.phase;
  if (!thread || thread.executionTarget !== "cloud" || thread.parentThreadId || thread.archivedAt || thread.deletedAt
    || !saved?.sessionId || !harness || !(harness in VM_SESSIONS) || (phase && !["complete", "cancelled", "error"].includes(phase)))
    throw new ApiError(409, "teleport_unavailable", "Teleport to Local needs a Codex, Pi, or Claude Code cloud parent thread.");
  const nativeId = getLastProviderThreadId(deps, threadId);
  if (!nativeId || !/^[A-Za-z0-9_-]+$/.test(nativeId))
    throw new ApiError(409, "teleport_unavailable", "This cloud thread has no saved conversation yet.");
  const environment = await localEnvironment(deps, thread);
  const client = await cloudroom(deps).teleportClient(threadId);

  await cloudroom(deps).control(threadId, "stop");
  await waitUntilStopped(client, saved.sessionId);

  const vmPath = (await vm(client, findNative(harness, nativeId))).toString().trim();
  if (!vmPath) throw new ApiError(409, "teleport_unavailable", "The cloud conversation file was not found. The thread stays in Cloud.");
  const cloud = await client.sessionWorkspace(saved.sessionId);
  const [session, changes] = await Promise.all([
    download(client, vmPath),
    cloudChanges(client, cloud.path, await git(environment.path, ["rev-parse", "HEAD"]), thread.createdAt),
  ]);
  await installNative(harness, nativeId, vmPath, session, environment.path);
  const conflicts = await applyChanges(environment.path, changes.archive, randomUUID(), changes.proven);

  const queued = cloudroom(deps).queue(threadId);
  deps.db.transaction((tx) => {
    for (const message of queued)
      createQueuedThreadMessageInTransaction(tx, {
        threadId, content: message.content, model: message.model, reasoningLevel: message.reasoningLevel,
        permissionMode: message.permissionMode, serviceTier: message.serviceTier,
        waitingOn: null, sendAt: null, payload: { kind: "inline" }, systemNotice: null,
      });
    tx.delete(cloudroomCommands).where(eq(cloudroomCommands.threadId, threadId)).run();
    tx.delete(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).run();
    tx.delete(threadPluginMetadata).where(and(eq(threadPluginMetadata.threadId, threadId), inArray(threadPluginMetadata.pluginId, ["cloudroom.teleport", "cloudroom.project-copy"]))).run();
    tx.update(threads).set({ executionTarget: "local", environmentId: environment.id, status: "idle", updatedAt: Date.now() }).where(eq(threads.id, threadId)).run();
  });
  cloudroom(deps).detach(threadId);
  deps.hub.notifyThread(threadId, ["status-changed", "queue-changed"]);
  deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
  requestQueuedMessageDispatch(deps, { kind: "thread-ready", threadId });
  await client.close(saved.sessionId, randomUUID()).catch((error: unknown) =>
    deps.logger.warn({ threadId, error }, "Cloud session did not close after Teleport to Local"));
  return { conflicts };
}

async function localEnvironment(deps: AppDeps, thread: Thread) {
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) throw new ApiError(409, "host_unavailable", "This computer's local host is not ready.");
  const teleported = deps.db.select({ input: cloudroomCommands.input }).from(cloudroomCommands)
    .where(and(eq(cloudroomCommands.threadId, thread.id), eq(cloudroomCommands.command, "teleport")))
    .orderBy(desc(cloudroomCommands.createdAt)).get();
  const previous = teleported ? (JSON.parse(teleported.input) as { environmentId?: string }).environmentId : undefined;
  const folders = thread.projectId === PERSONAL_PROJECT_ID ? [await projectlessFolder(deps, hostId)] : listProjectSourcesByProjectIds(deps.db, [thread.projectId])
    .filter((source) => source.path && source.hostId === hostId)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((source) => source.path!);
  const candidates = [
    previous ? getEnvironment(deps.db, previous) : null,
    ...folders.map((path) => findProjectEnvironmentByHostPath(deps.db, thread.projectId, hostId, path)),
  ];
  const environment = candidates.find((candidate) => candidate && candidate.hostId === hostId && !candidate.isWorktree && candidate.path && existsSync(candidate.path));
  if (environment?.path) return { ...environment, path: environment.path };
  const folder = folders.find((path) => existsSync(path));
  if (!folder)
    throw new ApiError(409, "teleport_unavailable", "This project has no folder on this computer. Add the project folder here, then retry.");
  const created = await provisionUnmanagedEnvironmentForPath(deps, { hostId, path: folder, projectId: thread.projectId });
  if ("failure" in created) throw new ApiError(409, "teleport_unavailable", `${created.failure} The thread stays in Cloud.`);
  return created;
}

// Projectless threads run in the folder holding most of the user's repos, else ~/Developer.
async function projectlessFolder(deps: AppDeps, hostId: string): Promise<string> {
  const counts = new Map<string, number>();
  for (const source of listProjectSourcesByHost(deps.db, hostId))
    if (source.path) counts.set(dirname(source.path), (counts.get(dirname(source.path)) ?? 0) + 1);
  const parent = [...counts].sort((a, b) => b[1] - a[1]).map(([path]) => path).find((path) => path !== homedir() && existsSync(path));
  if (parent) return parent;
  const developer = join(homedir(), "Developer");
  await mkdir(developer, { recursive: true });
  return developer;
}

async function waitUntilStopped(client: CloudroomClient, sessionId: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await client.session(sessionId)).current_request === null) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ApiError(409, "teleport_stop_timeout", "The cloud agent did not stop. The thread stays in Cloud; try again.");
}

async function vm(client: CloudroomClient, command: string): Promise<Buffer> {
  const result = await client.runOnVm({ command, stdin: "" });
  if (result.code !== 0 || result.truncated)
    throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
  return Buffer.from(result.stdout, "hex");
}

function findNative(harness: Harness, nativeId: string): string {
  return `find "${VM_SESSIONS[harness]}" -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | cut -d' ' -f2- | while IFS= read -r f; do
  case "$f" in *${nativeId}*) echo "$f"; exit 0;; esac
  head -n1 "$f" | grep -qF '"id":"${nativeId}"' && { echo "$f"; exit 0; }
done; exit 0`;
}

async function download(client: CloudroomClient, path: string): Promise<Buffer> {
  const size = Number((await vm(client, `wc -c < ${quote(path)}`)).toString().trim());
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += CHUNK)
    parts.push(await vm(client, `tail -c +${offset + 1} ${quote(path)} | head -c ${CHUNK}`));
  return Buffer.concat(parts);
}

async function cloudChanges(client: CloudroomClient, workspace: string, localHead: string | null, since: number): Promise<{ archive: Buffer; proven: boolean }> {
  const head = localHead?.trim();
  const archive = `.cache/cloudroom/teleport-local-${randomUUID()}.tgz`;
  const skipped = [...SKIPPED, ".cloudroom"].map((name) => `-name ${quote(name)}`).join(" -o ");
  const created = (await vm(client, [
    `cd ${quote(workspace)} || exit 1`,
    "mkdir -p ~/.cache/cloudroom",
    "if git rev-parse --git-dir >/dev/null 2>&1; then",
    "  proven=0; base=$(git reflog --format=%H HEAD 2>/dev/null | tail -n 1); [ -n \"$base\" ] || base=HEAD",
    head && /^[0-9a-f]{40,64}$/.test(head) ? `  git cat-file -e '${head}^{commit}' 2>/dev/null && { base=${head}; proven=1; }` : "",
    `  { git diff -z --name-only --no-renames --diff-filter=d "$base"; git ls-files -z --others --exclude-standard; } | tar -czf ~/${archive} --null -T - || exit 1`,
    "else",
    `  proven=0; find . \\( ${skipped} \\) -prune -o \\( -type f -o -type l \\) -newermt @${Math.floor(since / 1000) - 600} -print0 | tar -czf ~/${archive} --null -T - || exit 1`,
    "fi",
    `echo "$proven" ~/${archive}`,
  ].join("\n"))).toString().trim();
  const [proven, path] = (created.split("\n").pop() ?? "").split(" ");
  if (!path) throw new Error("The cloud file changes could not be packed. The thread stays in Cloud.");
  try {
    return { archive: await download(client, path), proven: proven === "1" };
  } finally {
    await vm(client, `rm -f ${quote(path)}`).catch(() => {});
  }
}

async function applyChanges(root: string, archive: Buffer, id: string, proven: boolean): Promise<number> {
  const real = await realpath(root);
  const aside = join(root, ".cloudroom", "teleport", id);
  if (!(await inside(real, join(aside, "file"))))
    throw new ApiError(409, "teleport_unavailable", "This project's .cloudroom folder points outside the project. The thread stays in Cloud.");
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-teleport-local-"));
  try {
    const file = join(folder, "changes.tgz");
    const staged = join(folder, "files");
    await writeFile(file, archive);
    await mkdir(staged);
    await exec("tar", ["-xzf", file, "-C", staged]);
    const paths = (await exec("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n")
      .map((path) => path.replace(/^\.\//, "")).filter((path) => path && !path.endsWith("/") && !isAbsolute(path) && !path.split("/").includes(".."));
    const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
    const dirty = proven && top && (await realpath(top).catch(() => null)) === real ? await dirtyPaths(root) : null;
    let conflicts = 0;
    for (const path of paths) {
      const incoming = join(staged, path);
      let target = join(root, path);
      const existing = await lstat(target).catch(() => null);
      if (existing && (await same(incoming, target))) continue;
      const replace = !existing || (dirty !== null && !dirty.has(path) && !existing.isSymbolicLink());
      if (!replace || !(await inside(real, target))) {
        target = join(aside, path);
        conflicts++;
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(incoming, target, { force: true, verbatimSymlinks: true });
    }
    return conflicts;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function inside(root: string, path: string): Promise<boolean> {
  let folder = dirname(path);
  while (!(await lstat(folder).catch(() => null))) folder = dirname(folder);
  const real = await realpath(folder).catch(() => null);
  return real === root || !!real?.startsWith(root + sep);
}

async function dirtyPaths(root: string): Promise<Set<string> | null> {
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return null;
  const dirty = new Set<string>();
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    dirty.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return dirty;
}

async function same(a: string, b: string): Promise<boolean> {
  return Promise.all([readFile(a), readFile(b)]).then(([left, right]) => left.equals(right), () => false);
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((result) => result.stdout, () => null);
}

async function installNative(harness: Harness, nativeId: string, vmPath: string, bytes: Buffer, cwd: string) {
  const end = bytes.indexOf(10);
  if (end < 0) throw new Error("The cloud conversation file is empty.");
  let data = bytes;
  if (harness !== "claude-code") {
    const header = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    if (harness === "codex" && header.type === "session_meta") header.payload.cwd = cwd;
    if (harness === "pi" && header.type === "session") header.cwd = cwd;
    data = Buffer.concat([Buffer.from(JSON.stringify(header)), bytes.subarray(end)]);
  }
  const target = await nativeTarget(harness, nativeId, basename(vmPath), cwd);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) await rename(target, `${target}.before-teleport-${Date.now()}`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, target);
}

async function nativeTarget(harness: Harness, nativeId: string, name: string, cwd: string): Promise<string> {
  if (harness === "pi")
    return join(process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions"), `${nativeId}.jsonl`);
  if (harness === "claude-code")
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const existing = (await readdir(sessions, { recursive: true }).catch(() => [] as string[])).find((file) => file.endsWith(`-${nativeId}.jsonl`));
  if (existing) return join(sessions, existing);
  const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
  return join(sessions, ...(date ? date.slice(1) : ["teleport"]), name);
}
