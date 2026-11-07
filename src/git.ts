import { execFileSync } from "node:child_process";

/**
 * Turn any way of naming a repo into one canonical slug: "owner/repo", lowercase.
 *
 *   "TobiasPak/Wtake"                          -> "tobiaspak/wtake"
 *   "https://github.com/TobiasPak/Wtake.git"   -> "tobiaspak/wtake"
 *   "git@github.com:TobiasPak/Wtake.git"       -> "tobiaspak/wtake"
 *   "ssh://git@github.com/TobiasPak/Wtake"     -> "tobiaspak/wtake"
 *
 * Returns null if the input doesn't look like a repo.
 */
export function parseRepoSlug(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!trimmed) return null;

  const name = "[A-Za-z0-9_.-]+";

  // Plain "owner/repo"
  const plain = new RegExp(`^(${name})/(${name})$`).exec(trimmed);
  if (plain) return `${plain[1]}/${plain[2]}`.toLowerCase();

  // URL or scp-style remote: take the last two path segments.
  const remote = new RegExp(`[:/](${name})/(${name})$`).exec(trimmed);
  if (remote && /[:@]|github\.com\//i.test(trimmed)) return `${remote[1]}/${remote[2]}`.toLowerCase();

  return null;
}

export interface DetectedRepo {
  slug: string;
  remoteUrl: string;
  root: string;
}

/** Find the repo for a folder by asking git for its "origin" remote. */
export function detectRepo(cwd: string): DetectedRepo | null {
  try {
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const remoteUrl = run(["remote", "get-url", "origin"]);
    const slug = parseRepoSlug(remoteUrl);
    if (!slug) return null;
    const root = run(["rev-parse", "--show-toplevel"]);
    return { slug, remoteUrl, root };
  } catch {
    return null; // not a git repo, no origin remote, or git not installed
  }
}
