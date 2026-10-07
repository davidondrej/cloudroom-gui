import { z } from "zod";
import { createRemoteProject, listProjectSourcesByProjectIds, listPublicProjects, setProjectHidden } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
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
const repoName = (key: string) => key.split("/").pop() ?? key;

/** Where a remote's repo lives now. GitHub's API follows a moved or renamed repo's old URL to its current `owner/name`. */
async function currentRepoKey(remote: string | null, token: string): Promise<string | null> {
  const key = repoKey(remote);
  if (!key) return null;
  const response = await fetch(key.replace("https://github.com/", "https://api.github.com/repos/"), {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const repo = response?.ok ? z.object({ full_name: z.string() }).safeParse(await response.json().catch(() => null)) : null;
  return repo?.success ? `https://github.com/${repo.data.full_name}`.toLowerCase() : null;
}

/** Current repo of each project named like one of `names`, mapped to its project id. A moved repo keeps working under its old URL, so a project may still save that one. */
async function movedRepos(projects: { id: string; name: string; gitRemoteUrl: string | null }[], names: Set<string>): Promise<Map<string, string>> {
  const clashing = projects.filter((project) => {
    const key = repoKey(project.gitRemoteUrl);
    return key && (names.has(project.name.toLowerCase()) || names.has(repoName(key)));
  });
  if (clashing.length === 0) return new Map();
  const token = await macGithubToken();
  const found = await Promise.all(clashing.map(async (project) => [await currentRepoKey(project.gitRemoteUrl, token), project.id] as const));
  return new Map(found.filter((entry): entry is [string, string] => entry[0] !== null));
}

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
  const moved = await movedRepos(projects, new Set(githubOnly.map(({ repo }) => repoName(repo.toLowerCase()))));
  const notMoved = githubOnly.filter(({ repo }) => !moved.has(`https://github.com/${repo}`.toLowerCase()));
  return {
    githubConnected: github.connected,
    repos: [
      ...macRepos.slice(0, LIMIT).map(({ name, path, updatedAt }) => ({ source: "mac" as const, name, path, updatedAt })),
      ...notMoved.slice(0, LIMIT).map(({ repo, updatedAt }) => ({ source: "github" as const, name: repo.split("/")[1] ?? repo, repo, updatedAt })),
    ],
  };
}

/** Makes a GitHub repo a project right away, with no clone. Each machine or sandbox clones it when a thread there first needs it.
 *  Returns the existing project if one already uses the repo, even under its old URL from before a move. */
export async function addGithubRepo(deps: AppDeps, repo: string): Promise<{ projectId: string }> {
  const url = `https://github.com/${repo}`, key = url.toLowerCase();
  const projects = listPublicProjects(deps.db, "all");
  const existing = projects.find((project) => repoKey(project.gitRemoteUrl) === key)?.id ?? (await movedRepos(projects, new Set([repoName(key)]))).get(key);
  if (existing) {
    setProjectHidden(deps.db, deps.hub, existing, false);
    return { projectId: existing };
  }
  return { projectId: createRemoteProject(deps.db, deps.hub, { name: repo.split("/")[1] ?? repo, gitRemoteUrl: `${url}.git` }).id };
}
