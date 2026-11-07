import type { PrInfo } from "./github.js";
import type { RepoSummary } from "./repos.js";
import type { Status, Task, TaskPr } from "./tasks.js";

/** Live PR info keyed by PR number. A missing entry means "status unavailable". */
export type PrInfoMap = Map<number, PrInfo | null>;

const GROUPS: { status: Status; heading: string }[] = [
  { status: "in_progress", heading: "In progress" },
  { status: "todo", heading: "To do" },
  { status: "done", heading: "Done" },
];

const CHECKS_LABEL: Record<PrInfo["checks"], string> = {
  passing: "✅ checks passing",
  failing: "❌ checks failing",
  pending: "⏳ checks running",
  none: "no checks",
};

export function formatPr(pr: TaskPr, info: PrInfo | null | undefined): string {
  if (!info) return `🔀 [PR #${pr.pr_number}](${pr.pr_url}) · status unavailable`;
  const parts = [`🔀 [PR #${info.number}](${info.url}): "${info.title}"`, info.state];
  if (info.state === "open" || info.state === "draft") parts.push(CHECKS_LABEL[info.checks]);
  return parts.join(" · ");
}

function taskLine(task: Task): string {
  const box = task.status === "done" ? "[x]" : "[ ]";
  const note = task.description ? " · *has description*" : "";
  return `- ${box} **#${task.id} ${task.title}**${note}`;
}

export function formatTaskList(
  repoSlug: string,
  tasks: Task[],
  prs: Map<number, TaskPr[]> | null,
  prInfo: PrInfoMap,
  statusFilter?: Status,
): string {
  const open = tasks.filter((t) => t.status !== "done").length;
  const filterNote = statusFilter ? ` (showing ${statusFilter.replace("_", " ")} only)` : "";
  const lines = [`**${repoSlug}: ${tasks.length} task${tasks.length === 1 ? "" : "s"} (${open} open)**${filterNote}`];

  if (tasks.length === 0) {
    lines.push("", statusFilter ? "No tasks match." : "No tasks yet.");
    return lines.join("\n");
  }

  for (const group of GROUPS) {
    const inGroup = tasks.filter((t) => t.status === group.status);
    if (inGroup.length === 0) continue;
    lines.push("", `**${group.heading}**`);
    for (const task of inGroup) {
      lines.push(taskLine(task));
      for (const pr of prs?.get(task.id) ?? []) {
        lines.push(`  - ${formatPr(pr, prInfo.get(pr.pr_number))}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatTaskDetail(task: Task, prs: TaskPr[], prInfo: PrInfoMap): string {
  const status = { todo: "To do", in_progress: "In progress", done: "Done" }[task.status];
  const lines = [
    `**#${task.id} ${task.title}**`,
    `Repo: ${task.repo_slug} · Status: ${status} · Created: ${task.created_at} UTC` +
      (task.completed_at ? ` · Completed: ${task.completed_at} UTC` : ""),
    "",
    "**Description**",
    task.description ?? "*No description.*",
    "",
    "**Pull requests**",
  ];
  if (prs.length === 0) lines.push("*None attached.*");
  for (const pr of prs) lines.push(`- ${formatPr(pr, prInfo.get(pr.pr_number))}`);
  return lines.join("\n");
}

export function formatRepoList(repos: RepoSummary[]): string {
  if (repos.length === 0) return "No repos are linked yet. Open Claude in a repo and ask to link it.";
  const lines = [`**Linked repos (${repos.length})**`, ""];
  for (const r of repos) {
    lines.push(`- **${r.slug}**: ${r.open_count} open, ${r.done_count} done`);
  }
  return lines.join("\n");
}
