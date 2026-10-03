import { randomUUID } from "node:crypto";
import { z } from "zod";
import { findOrCreateProjectByLocalPathSource, listProjectSourcesByProjectIds, listPublicProjects, setProjectGitRemoteUrlIfMissing } from "@bb/db";
import type { AppDeps } from "../../types.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import { resolveHostEnvironment } from "../hosts/host-environment.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { cloudroom } from "./commands.js";
import { localRepos } from "./local-repos.js";
import { githubRepository } from "./project-copy.js";
import { macGithubToken } from "./sandboxes.js";

/** A repo the user works on that is not a Cloudroom project yet: a Git folder on this Mac, or an `owner/name` GitHub repo. */
export type RepoSuggestion =
  | { source: "mac"; name: string; path: string; updatedAt: number }
  | { source: "github"; name: string; repo: string; updatedAt: number | null };

const LIMIT = 20;
const listSchema = z.array(z.object({ full_name: z.string(), pushed_at: z.string().nullable() }));
/** `https://github.com/owner/name` in lower case, so SSH, HTTPS, and `.git` remotes of one repo match. */
const repoKey = (remote: string | null) => githubRepository(remote)?.replace(/\.git$/, "").toLowerCase() ?? null;

/** The account's repos, newest push first. This Mac's `gh` login answers with push times; otherwise the website's GitHub login does. */
async function githubRepos(deps: AppDeps): Promise<{ connected: boolean; repos: { repo: string; updatedAt: number | null }[] }> {
  const token = await macGithubToken();
  if (token) {
    const response = await fetch("https://api.github.com/user/repos?sort=pushed&per_page=50", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const list = response?.ok ? listSchema.safeParse(await response.json().catch(() => null)) : null;
    if (list?.success) return { connected: true, repos: list.data.map((repo) => ({ repo: repo.full_name, updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : null })) };
  }
  const view = await cloudroom(deps).sandboxes.environment({ action: "githubRepos" }).catch(() => null);
  const names = view?.available ?? [];
  return { connected: Boolean(token) || names.length > 0, repos: names.map((repo) => ({ repo, updatedAt: view?.pushed?.[repo] ?? null })) };
}

/** Recently updated repos on this Mac and GitHub that no project uses yet. A repo on both shows once, as the Mac folder, since it needs no clone. */
export async function repoSuggestions(deps: AppDeps): Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }> {
  const projects = listPublicProjects(deps.db);
  const paths = new Set(listProjectSourcesByProjectIds(deps.db, projects.map((project) => project.id)).map((source) => source.path.toLowerCase()));
  const used = new Set(projects.map((project) => repoKey(project.gitRemoteUrl)));
  const [mac, github] = await Promise.all([localRepos(LIMIT * 2), githubRepos(deps)]);
  const onMac = new Set(mac.map((repo) => repoKey(repo.remote)));
  const macRepos = mac.filter((repo) => !paths.has(repo.path.toLowerCase()) && !(repo.remote && used.has(repoKey(repo.remote))));
  const githubOnly = github.repos.filter(({ repo }) => {
    const key = `https://github.com/${repo}`.toLowerCase();
    return !used.has(key) && !onMac.has(key);
  });
  return {
    githubConnected: github.connected,
    repos: [
      ...macRepos.slice(0, LIMIT).map(({ name, path, updatedAt }) => ({ source: "mac" as const, name, path, updatedAt })),
      ...githubOnly.slice(0, LIMIT).map(({ repo, updatedAt }) => ({ source: "github" as const, name: repo.split("/")[1] ?? repo, repo, updatedAt })),
    ],
  };
}

/** Clones a GitHub repo into Cloudroom's checkouts folder on the host and makes it a project. Returns the existing project if one already uses the repo. */
export async function addGithubRepo(deps: AppDeps, hostId: string, repo: string): Promise<{ projectId: string }> {
  requireNonDestroyedHostWithStatus(deps, hostId);
  assertUsableHostId(deps, { hostId });
  const url = `https://github.com/${repo}`;
  const existing = listPublicProjects(deps.db).find((project) => repoKey(project.gitRemoteUrl) === url.toLowerCase());
  if (existing) return { projectId: existing.id };
  const name = repo.split("/")[1] ?? repo;
  const cloned = await runLiveHostCommand(deps, {
    hostId,
    timeoutMs: 20 * 60 * 1000,
    command: {
      type: "project.clone",
      operationId: `project-clone-${randomUUID()}`,
      contributedEnv: await resolveHostEnvironment(deps, { hostId, projectId: null }),
      remoteUrl: `${url}.git`,
      projectSlug: name,
    },
  });
  const { project } = findOrCreateProjectByLocalPathSource(deps.db, deps.hub, { name, source: { type: "local_path", hostId, path: cloned.path } });
  if (cloned.gitRemoteUrl) setProjectGitRemoteUrlIfMissing(deps.db, deps.hub, project.id, cloned.gitRemoteUrl);
  return { projectId: project.id };
}
