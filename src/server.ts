import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DB } from "./db.js";
import { UserError } from "./errors.js";
import { formatRepoList, formatTaskDetail, formatTaskList, type PrInfoMap } from "./format.js";
import { ghFetchPr, parsePrRef, prUrl, type PrFetcher } from "./github.js";
import { linkRepo, listRepos, resolveLinkedRepo, resolveSlug, unlinkRepo } from "./repos.js";
import {
  STATUSES,
  addTask,
  attachPr,
  detachPr,
  getTask,
  listTasks,
  prsForTasks,
  removeTask,
  updateTask,
  type TaskPr,
} from "./tasks.js";

export const SERVER_NAME = "claude-tasks";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `This server is the user's task list (checklist / todo list). Each linked GitHub repo has its own list.
- When the user asks to see, bring up or check their tasks, call list_tasks and show its Markdown output as-is.
- Leave out the repo argument to use the repo of the folder you're working in.
- If a tool says a repo isn't linked, ask the user before calling link_repo.
- Only add a description when the user gives one or asks for one.
- Ask for confirmation before remove_task or unlink_repo.`;

export interface ServerOptions {
  db: DB;
  /** Looks up live PR status. Defaults to the GitHub CLI. */
  fetchPr?: PrFetcher;
  /** The folder Claude is working in. Defaults to the client's first root, then process.cwd(). */
  getCwd?: () => Promise<string>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Run a tool body, turning expected problems (UserError) into a readable error result for Claude. */
async function run(body: () => string | Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await body() }] };
  } catch (err) {
    if (err instanceof UserError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

const repoArg = z
  .string()
  .optional()
  .describe('Repo as "owner/repo" or a GitHub URL. Leave out to use the repo of the current folder.');
const taskId = z.number().int().positive().describe("Task id, e.g. 7 for task #7");

export function createTaskServer(options: ServerOptions): McpServer {
  const { db, fetchPr = ghFetchPr } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const getCwd =
    options.getCwd ??
    (async () => {
      if (server.server.getClientCapabilities()?.roots) {
        try {
          const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
          const root = roots.find((r) => r.uri.startsWith("file:"));
          if (root) return fileURLToPath(root.uri);
        } catch {
          // fall through to process.cwd()
        }
      }
      return process.cwd();
    });

  async function liveInfo(repoSlug: string, prs: TaskPr[]): Promise<PrInfoMap> {
    const numbers = [...new Set(prs.map((p) => p.pr_number))];
    const results = await Promise.all(numbers.map((n) => fetchPr(repoSlug, n)));
    return new Map(numbers.map((n, i) => [n, results[i]]));
  }

  // ---------- Repos ----------

  server.registerTool(
    "link_repo",
    {
      title: "Link repo",
      description: "Link a GitHub repo so it gets its own task list. Defaults to the repo of the current folder.",
      inputSchema: { repo: repoArg },
    },
    ({ repo }) =>
      run(async () => {
        const found = resolveSlug(repo, await getCwd());
        const { repo: linked, created } = linkRepo(db, {
          slug: found.slug,
          remoteUrl: found.remoteUrl,
          localPath: found.root,
        });
        return created
          ? `Linked ${linked.slug}. It now has its own task list.`
          : `${linked.slug} was already linked.`;
      }),
  );

  server.registerTool(
    "unlink_repo",
    {
      title: "Unlink repo",
      description:
        "Unlink a repo and permanently delete its task list. Confirm with the user first, then pass confirm: true.",
      inputSchema: {
        repo: z.string().describe('Repo as "owner/repo" or a GitHub URL'),
        confirm: z.literal(true).describe("Must be true; only set after the user confirms"),
      },
      annotations: { destructiveHint: true },
    },
    ({ repo }) =>
      run(async () => {
        const { slug } = resolveSlug(repo, await getCwd());
        const { taskCount } = unlinkRepo(db, slug);
        return `Unlinked ${slug} and deleted its ${taskCount} task${taskCount === 1 ? "" : "s"}.`;
      }),
  );

  server.registerTool(
    "list_repos",
    {
      title: "List repos",
      description: "List every linked repo with its open and done task counts.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => formatRepoList(listRepos(db))),
  );

  // ---------- Tasks ----------

  server.registerTool(
    "add_task",
    {
      title: "Add task",
      description: "Add a task to a repo's task list.",
      inputSchema: {
        title: z.string().min(1).describe("Short task title"),
        description: z.string().optional().describe("Longer details. Only include if the user gave or asked for one."),
        repo: repoArg,
      },
    },
    ({ title, description, repo }) =>
      run(async () => {
        const target = resolveLinkedRepo(db, repo, await getCwd());
        const task = addTask(db, target.id, title, description);
        return `Added task #${task.id} "${task.title}" to ${target.slug}.`;
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Show a repo's task list, grouped by status, with attached PRs and their live status. Use when the user asks to see their tasks, todo list or checklist. Show the output to the user as-is.",
      inputSchema: {
        repo: repoArg,
        status: z.enum(STATUSES).optional().describe("Only show tasks with this status"),
        include_prs: z.boolean().optional().describe("Include attached PRs with live status (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ repo, status, include_prs = true }) =>
      run(async () => {
        const target = resolveLinkedRepo(db, repo, await getCwd());
        const tasks = listTasks(db, target.id, status);
        const prs = include_prs ? prsForTasks(db, tasks.map((t) => t.id)) : null;
        const info = prs ? await liveInfo(target.slug, [...prs.values()].flat()) : new Map();
        return formatTaskList(target.slug, tasks, prs, info, status);
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Show one task in full: description, status, dates and attached PRs with live status.",
      inputSchema: { id: taskId },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const task = getTask(db, id);
        const prs = prsForTasks(db, [id]).get(id) ?? [];
        return formatTaskDetail(task, prs, await liveInfo(task.repo_slug, prs));
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        'Change a task\'s title, description or status. Use status "done" to check it off and "todo" to reopen it. Pass an empty description to clear it.',
      inputSchema: {
        id: taskId,
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(STATUSES).optional(),
      },
    },
    ({ id, title, description, status }) =>
      run(() => {
        if (title === undefined && description === undefined && status === undefined) {
          throw new UserError("Nothing to change: pass a title, description or status.");
        }
        const task = updateTask(db, id, { title, description, status });
        const label = { todo: "to do", in_progress: "in progress", done: "done" }[task.status];
        return `Updated task #${task.id} "${task.title}" (now ${label}).`;
      }),
  );

  server.registerTool(
    "remove_task",
    {
      title: "Remove task",
      description: "Permanently delete a task and its PR links. Confirm with the user first.",
      inputSchema: { id: taskId },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      run(() => {
        const task = removeTask(db, id);
        return `Removed task #${task.id} "${task.title}" from ${task.repo_slug}.`;
      }),
  );

  // ---------- Pull requests ----------

  server.registerTool(
    "attach_pr",
    {
      title: "Attach PR",
      description: "Attach a GitHub pull request to a task. The PR must be in the same repo as the task.",
      inputSchema: {
        task_id: taskId,
        pr: z.union([z.number(), z.string()]).describe('PR number (42 or "#42") or full PR URL'),
      },
    },
    ({ task_id, pr }) =>
      run(async () => {
        const task = getTask(db, task_id);
        const number = parsePrRef(pr, task.repo_slug);
        const info = await fetchPr(task.repo_slug, number);
        const added = attachPr(db, task_id, number, info?.url ?? prUrl(task.repo_slug, number));
        if (!added) return `PR #${number} was already attached to task #${task_id}.`;
        return info
          ? `Attached PR #${number} "${info.title}" (${info.state}) to task #${task_id}.`
          : `Attached PR #${number} to task #${task_id}. Its status couldn't be checked right now (GitHub CLI unavailable, offline, or PR not found).`;
      }),
  );

  server.registerTool(
    "detach_pr",
    {
      title: "Detach PR",
      description: "Remove a PR link from a task (the PR itself isn't touched).",
      inputSchema: { task_id: taskId, pr_number: z.number().int().positive() },
    },
    ({ task_id, pr_number }) =>
      run(() => {
        detachPr(db, task_id, pr_number);
        return `Detached PR #${pr_number} from task #${task_id}.`;
      }),
  );

  return server;
}
