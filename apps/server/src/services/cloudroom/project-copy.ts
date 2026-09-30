import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getProject, getThread, listProjectSourcesByProjectIds } from "@bb/db";
import type { ProjectCopyProgress } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { CloudroomError, UPLOAD_PART, type CloudroomClient } from "./client.js";
import { saveProjectCopyProgress } from "./store.js";

type Deps = Pick<AppDeps, "db" | "hub">;
// `key` is the copy target: one folder on a shared VM, or one per thread sandbox.
// New threads get a default-branch clone and `.env` files; Teleport also brings the local branch and uncommitted work.
export type ProjectCopyJob = { threadId: string; workspace: string; key: string; localPath: string; repository: string | null; clone: boolean; teleport: boolean };

const exec = promisify(execFile);
// A stalled piece counts as dropped, so the retry sends it again.
const PIECE_TIMEOUT = 120_000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
export const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", ".next", ".turbo", ".cache", "__pycache__", "target", "dist", "build", ".DS_Store"]);
const copying = new Set<string>();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function githubRepository(remote: string | null): string | null {
  const repository = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/)?.[1];
  return repository ? `https://github.com/${repository}` : null;
}

function localProjectPath(deps: Deps, projectId: string): string | undefined {
  const sources = listProjectSourcesByProjectIds(deps.db, [projectId]).filter((source) => existsSync(source.path));
  return (sources.find((source) => source.isDefault) ?? sources[0])?.path;
}

/** Tells a new cloud thread where a project without GitHub lives, since its files stay on the Mac. */
export function localProjectNote(deps: Deps, projectId: string): string | undefined {
  const project = getProject(deps.db, projectId);
  const path = project && !githubRepository(project.gitRemoteUrl) ? localProjectPath(deps, project.id) : undefined;
  return path && `This project is not on GitHub, so only its \`.env\` files were copied here. The rest is on the user's Mac at \`${path}\`. Pull only what the task needs with \`cloudroom mac pull\`.`;
}

export async function planProjectCopy(deps: Deps, client: CloudroomClient, threadId: string, workspace: string, { localPath, key = workspace, teleport = false }: { localPath?: string; key?: string; teleport?: boolean } = {}): Promise<ProjectCopyJob | null> {
  try {
    const project = getProject(deps.db, getThread(deps.db, threadId)?.projectId ?? "");
    if (!project || copying.has(key)) return null;
    const path = localPath ?? localProjectPath(deps, project.id);
    if (!path) return null;
    const existing = await client.workspace(workspace);
    const empty = !existing || (await client.runOnVm({ command: `[ -z "$(ls -A -- ${quote(existing.path)} 2>/dev/null | grep -Fvx .cloudroom)" ]`, stdin: "" })).code === 0;
    if (!empty && teleport) return null;
    const repository = githubRepository(project.gitRemoteUrl);
    const job = { threadId, workspace, key, localPath: path, repository, clone: empty && Boolean(repository), teleport };
    return job.clone || teleport || (await localFiles(path, "env")).length ? job : null;
  } catch {
    return null;
  }
}

export function copyProject(deps: Deps, client: CloudroomClient, job: ProjectCopyJob, done?: (error?: string) => void): void {
  if (copying.has(job.key)) return;
  copying.add(job.key);
  const report = (progress: ProjectCopyProgress) => {
    if (!job.clone && !job.teleport && progress.phase !== "error") return;
    saveProjectCopyProgress(deps.db, job.threadId, progress);
    deps.hub.notifyThread(job.threadId, ["status-changed"]);
    const projectId = getThread(deps.db, job.threadId)?.projectId;
    if (projectId) deps.hub.notifyProject(projectId, ["threads-changed"]);
  };
  report({ phase: job.clone ? "cloning" : "uploading", completed: 0, total: 0 });
  void run(client, job, report)
    .then(() => { report({ phase: "complete", completed: 0, total: 0 }); done?.(); })
    .catch((error: unknown) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      report({ phase: "error", completed: 0, total: 0, error: message });
      done?.(message);
    })
    .finally(() => copying.delete(job.key));
}

async function run(client: CloudroomClient, job: ProjectCopyJob, report: (progress: ProjectCopyProgress) => void): Promise<void> {
  const target = (await client.workspace(job.workspace))?.path;
  if (!target) throw new Error("The cloud project folder is unavailable.");
  // A failed Teleport clone falls back to uploading the files, so the agent can still work, then reports why Git is missing.
  let cloneError: string | null = null;
  if (job.clone && job.repository) {
    const branch = job.teleport ? (await git(job.localPath, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() : undefined;
    cloneError = await clone(client, target, job.repository, branch);
    if (cloneError) cloneError = await clone(client, target, job.repository, branch);
  }
  const cloned = job.clone && !cloneError;
  if (!cloned) report({ phase: "uploading", completed: 0, total: 0 });
  const scope = !job.teleport ? "env" : cloned ? "changed" : "all";
  const files = await localFiles(job.localPath, scope);
  if (files.length) await upload(client, job.localPath, target, files, scope !== "changed", report);
  if (cloneError) throw new Error(job.teleport ? `The GitHub clone failed, so your files were copied without Git history: ${cloneError}` : `The GitHub clone failed: ${cloneError}`);
}

async function vm(client: CloudroomClient, command: string, bytes?: Buffer<ArrayBuffer>, raw = false): Promise<void> {
  const signal = bytes && AbortSignal.timeout(PIECE_TIMEOUT);
  const result = raw ? await client.runOnVm({ command }, signal, bytes) : await client.runOnVm({ command, stdin: bytes?.toString("hex") ?? "" }, signal);
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
}

/** Retries dropped connections and busy clouds for about 90 seconds, so a network blip doesn't end the copy. */
async function retry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries === 7 || !(error instanceof CloudroomError && error.retryable)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000 * 2 ** (tries - 1), 30_000)));
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return await exec("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((result) => result.stdout, () => null);
}

/** Returns null once the clone is in place, or why it failed. */
async function clone(client: CloudroomClient, target: string, repository: string, branch?: string): Promise<string | null> {
  const token = await exec("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 15_000 }).then((result) => result.stdout.trim(), () => "");
  const temporary = quote(`${target}.cloudroom-clone`);
  const result = await client.runOnVm({
    command: [
      "export GIT_TERMINAL_PROMPT=0",
      token ? "{ { gh auth status --hostname github.com || gh auth login --hostname github.com --with-token; } && gh auth setup-git --hostname github.com; } >/dev/null 2>&1 || true" : "",
      `rm -rf -- ${temporary}`,
      `git clone --quiet --filter=blob:none -- ${quote(repository)} ${temporary} || exit 1`,
      branch && branch !== "HEAD" ? `git -C ${temporary} checkout --quiet ${quote(branch)} 2>/dev/null || true` : "",
      `mkdir -p -- ${quote(target)} && (shopt -s dotglob && mv -n -- ${temporary}/* ${quote(target)}/) || true`,
      `rm -rf -- ${temporary}`,
      `test -e ${quote(`${target}/.git`)} || { echo 'The clone did not reach the project folder.' >&2; exit 1; }`,
    ].join("\n"),
    stdin: Buffer.from(token).toString("hex"),
  });
  if (result.code === 0) return null;
  return Buffer.from(result.stderr, "hex").toString().trim().slice(-300) || `git clone exited with code ${result.code}`;
}

const isEnv = (path: string) => basename(path).startsWith(".env");

/** `all`: every project file; `changed`: uncommitted and untracked files; `env`: only `.env` files. Ignored `.env` files always count. */
async function localFiles(root: string, scope: "all" | "changed" | "env"): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", scope === "all" ? "--cached" : "--modified", "--others", "--exclude-standard"]);
  const ignored = listed === null ? "" : await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) ?? "";
  const env = ignored.split("\0").filter((path) => path && !path.endsWith("/") && isEnv(path));
  const found = listed === null ? await walk(root, "") : [...new Set([...listed.split("\0").filter(Boolean), ...env])];
  const candidates = scope === "env" ? found.filter(isEnv) : found;
  const files: string[] = [];
  let total = 0;
  for (const path of candidates) {
    const info = await lstat(join(root, path)).catch(() => null);
    if (!info || !(info.isFile() || info.isSymbolicLink()) || info.size > MAX_FILE) continue;
    total += info.size;
    if (total > MAX_TOTAL) throw new Error("This project is over 1 GB without ignored and large files, so it was not copied. Push it to GitHub to use it in Cloud.");
    files.push(path);
  }
  return files;
}

async function walk(root: string, folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else files.push(path);
  }
  return files;
}

async function upload(client: CloudroomClient, root: string, target: string, files: string[], keepExisting: boolean, report: (progress: ProjectCopyProgress) => void): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-"));
  const archive = join(folder, "project.tgz");
  const remote = `.cache/cloudroom/copy-${randomUUID()}.tgz`;
  try {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["--no-xattrs", "-czf", archive, "--null", "-T", "-"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["pipe", "ignore", "ignore"] });
      tar.on("error", reject).on("close", (code) => code === 0 ? resolve() : reject(new Error("Could not pack the project files.")));
      tar.stdin.end(files.map((path) => `${path}\0`).join(""));
    });
    const size = (await stat(archive)).size;
    // Older cores lack raw input (404) and take hex, which doubles the upload.
    const raw = await retry(() => client.runOnVm({ command: "true" }, AbortSignal.timeout(PIECE_TIMEOUT), new Uint8Array()).then(() => true, (error: unknown) => {
      if (error instanceof CloudroomError && error.status === 404) return false;
      throw error;
    }));
    const chunk = raw ? UPLOAD_PART : UPLOAD_PART / 2;
    const started = Date.now();
    const handle = await open(archive);
    try {
      for (let offset = 0; offset < size; offset += chunk) {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(chunk, size - offset)), 0, Math.min(chunk, size - offset), offset);
        // Truncating first lets a resent piece replace itself instead of repeating.
        await retry(() => vm(client, `mkdir -p .cache/cloudroom && truncate -s ${offset} ${remote} && cat >> ${remote}`, buffer.subarray(0, bytesRead), raw));
        const sent = offset + bytesRead;
        report({ phase: "uploading", completed: sent, total: size, secondsLeft: Math.round(((Date.now() - started) / sent) * (size - sent) / 1000) });
      }
    } finally {
      await handle.close();
    }
    await vm(client, `mkdir -p -- ${quote(target)} && tar -xzf ${remote} -C ${quote(target)}${keepExisting ? " --skip-old-files" : ""}; code=$?; rm -f ${remote}; exit $code`);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await client.runOnVm({ command: `rm -f ${remote}`, stdin: "" }).catch(() => {});
  }
}
