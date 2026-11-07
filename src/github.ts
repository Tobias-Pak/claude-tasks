import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRepoSlug } from "./git.js";
import { UserError } from "./errors.js";

const execFileAsync = promisify(execFile);

export type ChecksState = "passing" | "failing" | "pending" | "none";

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: ChecksState;
}

/** Looks up live PR info. Returns null when it can't (gh missing, offline, PR not found). */
export type PrFetcher = (repoSlug: string, prNumber: number) => Promise<PrInfo | null>;

interface GhCheck {
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | ...
  state?: string; // StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
}

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function summarizeChecks(checks: GhCheck[] | null | undefined): ChecksState {
  if (!checks || checks.length === 0) return "none";
  let pending = false;
  for (const c of checks) {
    const result = (c.conclusion || c.state || "").toUpperCase();
    if (FAILED.has(result)) return "failing";
    const running = c.status !== undefined && c.status.toUpperCase() !== "COMPLETED";
    if (running || result === "PENDING" || result === "EXPECTED" || result === "") pending = true;
  }
  return pending ? "pending" : "passing";
}

/** Default fetcher: shells out to the GitHub CLI, reusing the user's existing `gh auth login`. */
export const ghFetchPr: PrFetcher = async (repoSlug, prNumber) => {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(prNumber), "--repo", repoSlug, "--json", "number,title,url,state,isDraft,statusCheckRollup"],
      { timeout: 10_000, windowsHide: true },
    );
    const pr = JSON.parse(stdout) as {
      number: number;
      title: string;
      url: string;
      state: string;
      isDraft: boolean;
      statusCheckRollup: GhCheck[] | null;
    };
    const state = pr.state.toUpperCase();
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
      checks: summarizeChecks(pr.statusCheckRollup),
    };
  } catch {
    return null;
  }
};

/**
 * Accepts "42", "#42", 42, or "https://github.com/owner/repo/pull/42".
 * If a URL names a different repo than the task's, that's an error.
 */
export function parsePrRef(input: string | number, taskRepoSlug: string): number {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input > 0) return input;
    throw new UserError(`Invalid PR number: ${input}`);
  }
  const text = input.trim();
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return Number(bare[1]);

  const url = /^(.*)\/pull\/(\d+)(?:[/?#].*)?$/.exec(text);
  if (url) {
    const slug = parseRepoSlug(url[1]);
    if (slug && slug !== taskRepoSlug) {
      throw new UserError(`That PR belongs to ${slug}, but the task is in ${taskRepoSlug}.`);
    }
    return Number(url[2]);
  }
  throw new UserError(`Couldn't read a PR number from "${input}". Use a number like 42 or a PR URL.`);
}

export function prUrl(repoSlug: string, prNumber: number): string {
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}
