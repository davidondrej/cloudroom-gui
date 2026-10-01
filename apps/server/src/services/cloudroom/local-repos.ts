import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalRepo { name: string; path: string; updatedAt: number }

const MAC_PRIVACY_FOLDERS = new Set(["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
const ROOTS = ["", "code", "Code", "Projects", "projects", "Developer", "dev", "src", "repos", "GitHub", "work"];

const mtime = (path: string) => stat(path).then((info) => info.mtimeMs, () => 0);

export async function localRepos(limit = 8): Promise<LocalRepo[]> {
  const home = homedir();
  const found = new Map<string, LocalRepo>();
  await Promise.all(ROOTS.map(async (root) => {
    const folder = join(home, root);
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".") || (root === "" && MAC_PRIVACY_FOLDERS.has(entry.name))) return;
      const path = join(folder, entry.name), git = join(path, ".git");
      const updatedAt = Math.max(await mtime(join(git, "index")), await mtime(join(git, "logs", "HEAD")), await mtime(git));
      if (updatedAt > 0) found.set(path.toLowerCase(), { name: entry.name, path, updatedAt });
    }));
  }));
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
