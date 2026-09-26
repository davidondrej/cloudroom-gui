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
import type { CloudroomClient } from "./client.js";
import { saveProjectCopyProgress } from "./store.js";

type Deps = Pick<AppDeps, "db" | "hub">;
export type ProjectCopyJob = { threadId: string; workspace: string; localPath: string; repository: string | null };

const exec = promisify(execFile);
const CHUNK = 16 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
export const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", ".next", ".turbo", ".cache", "__pycache__", "target", "dist", "build", ".DS_Store"]);
const copying = new Set<string>();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function githubRepository(remote: string | null): string | null {
  const repository = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/)?.[1];
  return repository ? `https://github.com/${repository}` : null;
}

export async function planProjectCopy(deps: Deps, client: CloudroomClient, threadId: string, workspace: string, localPath?: string): Promise<ProjectCopyJob | null> {
  try {
    const project = getProject(deps.db, getThread(deps.db, threadId)?.projectId ?? "");
    if (!project || copying.has(workspace)) return null;
    const sources = listProjectSourcesByProjectIds(deps.db, [project.id]).filter((source) => existsSync(source.path));
    const path = localPath ?? (sources.find((source) => source.isDefault) ?? sources[0])?.path;
    if (!path) return null;
    const existing = await client.workspace(workspace);
    if (existing && (await client.runOnVm({ command: `[ -z "$(ls -A -- ${quote(existing.path)} 2>/dev/null | grep -Fvx .cloudroom)" ]`, stdin: "" })).code !== 0) return null;
    return { threadId, workspace, localPath: path, repository: githubRepository(project.gitRemoteUrl) };
  } catch {
    return null;
  }
}

export function copyProject(deps: Deps, client: CloudroomClient, job: ProjectCopyJob): void {
  if (copying.has(job.workspace)) return;
  copying.add(job.workspace);
  const report = (progress: ProjectCopyProgress) => {
    saveProjectCopyProgress(deps.db, job.threadId, progress);
    deps.hub.notifyThread(job.threadId, ["status-changed"]);
    const projectId = getThread(deps.db, job.threadId)?.projectId;
    if (projectId) deps.hub.notifyProject(projectId, ["threads-changed"]);
  };
  report({ phase: job.repository ? "cloning" : "uploading", completed: 0, total: 0 });
  void run(client, job, report)
    .then(() => report({ phase: "complete", completed: 0, total: 0 }))
    .catch((error: unknown) => report({ phase: "error", completed: 0, total: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }))
    .finally(() => copying.delete(job.workspace));
}

async function run(client: CloudroomClient, job: ProjectCopyJob, report: (progress: ProjectCopyProgress) => void): Promise<void> {
  const target = (await client.workspace(job.workspace))?.path;
  if (!target) throw new Error("The cloud project folder is unavailable.");
  const cloned = job.repository ? await clone(client, target, job.repository, job.localPath) : false;
  if (!cloned) report({ phase: "uploading", completed: 0, total: 0 });
  const files = await localFiles(job.localPath, cloned);
  if (files.length) await upload(client, job.localPath, target, files, !cloned, report);
}

async function vm(client: CloudroomClient, command: string, stdin = Buffer.alloc(0)): Promise<void> {
  const result = await client.runOnVm({ command, stdin: stdin.toString("hex") });
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return await exec("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((result) => result.stdout, () => null);
}

async function clone(client: CloudroomClient, target: string, repository: string, localPath: string): Promise<boolean> {
  const token = await exec("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 15_000 }).then((result) => result.stdout.trim(), () => "");
  const branch = (await git(localPath, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
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
      `test -e ${quote(`${target}/.git`)}`,
    ].join("\n"),
    stdin: Buffer.from(token).toString("hex"),
  });
  return result.code === 0;
}

async function localFiles(root: string, cloned: boolean): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", cloned ? "--modified" : "--cached", "--others", "--exclude-standard"]);
  const ignored = listed === null ? "" : await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) ?? "";
  const env = ignored.split("\0").filter((path) => path && !path.endsWith("/") && basename(path).startsWith(".env"));
  const candidates = listed === null ? await walk(root, "") : [...new Set([...listed.split("\0").filter(Boolean), ...env])];
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
    await vm(client, `mkdir -p .cache/cloudroom && : > ${remote}`);
    const handle = await open(archive);
    try {
      for (let offset = 0; offset < size; offset += CHUNK) {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(CHUNK, size - offset)), 0, Math.min(CHUNK, size - offset), offset);
        await vm(client, `cat >> ${remote}`, buffer.subarray(0, bytesRead));
        report({ phase: "uploading", completed: offset + bytesRead, total: size });
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
