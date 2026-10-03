import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalRepo { name: string; path: string; updatedAt: number; remote: string | null }

const MAC_PRIVACY_FOLDERS = new Set(["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
const ROOTS = ["", "code", "Code", "Projects", "projects", "Developer", "dev", "src", "repos", "GitHub", "work"];

const mtime = (path: string) => stat(path).then((info) => info.mtimeMs, () => 0);
const originUrl = (git: string) => readFile(join(git, "config"), "utf8").then((config) => config.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1] ?? null, () => null);

export async function localRepos(limit = 8): Promise<LocalRepo[]> {
  const home = homedir();
  const found = new Map<string, LocalRepo>();
  // On a Mac, ~/code and ~/Code are one folder; the real path gives each repo one spelling.
  const roots = new Set(await Promise.all(ROOTS.map((root) => realpath(join(home, root)).catch(() => ""))));
  roots.delete("");
  await Promise.all([...roots].map(async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".") || (folder === home && MAC_PRIVACY_FOLDERS.has(entry.name))) return;
      const path = join(folder, entry.name), git = join(path, ".git");
      const updatedAt = Math.max(await mtime(join(git, "index")), await mtime(join(git, "logs", "HEAD")), await mtime(git));
      if (updatedAt > 0) found.set(path.toLowerCase(), { name: entry.name, path, updatedAt, remote: await originUrl(git) });
    }));
  }));
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
