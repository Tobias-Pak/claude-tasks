import type { DB } from "./db.js";
import { UserError } from "./errors.js";
import { detectRepo, parseRepoSlug } from "./git.js";

export interface Repo {
  id: number;
  slug: string;
  remote_url: string | null;
  local_path: string | null;
  created_at: string;
}

export interface RepoSummary extends Repo {
  open_count: number;
  done_count: number;
}

export function getRepoBySlug(db: DB, slug: string): Repo | undefined {
  return db.prepare("SELECT * FROM repos WHERE slug = ?").get(slug) as Repo | undefined;
}

/** Link a repo (or refresh its details if it's already linked). */
export function linkRepo(
  db: DB,
  input: { slug: string; remoteUrl?: string | null; localPath?: string | null },
): { repo: Repo; created: boolean } {
  const existing = getRepoBySlug(db, input.slug);
  const repo = db
    .prepare(
      `INSERT INTO repos (slug, remote_url, local_path) VALUES (@slug, @remoteUrl, @localPath)
       ON CONFLICT(slug) DO UPDATE SET
         remote_url = COALESCE(excluded.remote_url, repos.remote_url),
         local_path = COALESCE(excluded.local_path, repos.local_path)
       RETURNING *`,
    )
    .get({ slug: input.slug, remoteUrl: input.remoteUrl ?? null, localPath: input.localPath ?? null }) as Repo;
  return { repo, created: !existing };
}

/** Unlink a repo. Its tasks and PR links are deleted too (ON DELETE CASCADE). */
export function unlinkRepo(db: DB, slug: string): { taskCount: number } {
  const repo = getRepoBySlug(db, slug);
  if (!repo) throw new UserError(`Repo ${slug} isn't linked.`);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ?").get(repo.id) as { n: number };
  db.prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
  return { taskCount: n };
}

export function listRepos(db: DB): RepoSummary[] {
  return db
    .prepare(
      `SELECT r.*,
              COALESCE(SUM(t.status != 'done'), 0) AS open_count,
              COALESCE(SUM(t.status  = 'done'), 0) AS done_count
       FROM repos r LEFT JOIN tasks t ON t.repo_id = r.id
       GROUP BY r.id
       ORDER BY r.slug`,
    )
    .all() as RepoSummary[];
}

/** Figure out which repo a request means: the explicit `repo` argument, or the folder Claude is working in. */
export function resolveSlug(repoArg: string | undefined, cwd: string): { slug: string; remoteUrl?: string; root?: string } {
  if (repoArg) {
    const slug = parseRepoSlug(repoArg);
    if (!slug) throw new UserError(`"${repoArg}" doesn't look like a repo. Use "owner/repo" or a GitHub URL.`);
    return { slug };
  }
  const detected = detectRepo(cwd);
  if (!detected) {
    throw new UserError(
      `The current folder (${cwd}) isn't a git repo with an "origin" remote. Pass repo as "owner/repo", or call list_repos to see linked repos.`,
    );
  }
  return detected;
}

/** Like resolveSlug, but the repo must already be linked. */
export function resolveLinkedRepo(db: DB, repoArg: string | undefined, cwd: string): Repo {
  const { slug } = resolveSlug(repoArg, cwd);
  const repo = getRepoBySlug(db, slug);
  if (!repo) {
    throw new UserError(
      `Repo ${slug} isn't linked yet, so it has no task list. Ask the user whether to link it (link_repo), then retry.`,
    );
  }
  return repo;
}
