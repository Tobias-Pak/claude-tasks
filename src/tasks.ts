import type { DB } from "./db.js";
import { UserError } from "./errors.js";

export const STATUSES = ["todo", "in_progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: number;
  repo_id: number;
  repo_slug: string;
  title: string;
  description: string | null;
  status: Status;
  position: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskPr {
  id: number;
  task_id: number;
  pr_number: number;
  pr_url: string;
  attached_at: string;
}

const SELECT_TASK = `SELECT t.*, r.slug AS repo_slug FROM tasks t JOIN repos r ON r.id = t.repo_id`;

export function addTask(db: DB, repoId: number, title: string, description?: string | null): Task {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new UserError("A task needs a title.");
  const { id } = db
    .prepare(
      `INSERT INTO tasks (repo_id, title, description, position)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE repo_id = ?))
       RETURNING id`,
    )
    .get(repoId, cleanTitle, description?.trim() || null, repoId) as { id: number };
  return getTask(db, id);
}

export function getTask(db: DB, id: number): Task {
  const task = db.prepare(`${SELECT_TASK} WHERE t.id = ?`).get(id) as Task | undefined;
  if (!task) throw new UserError(`Task #${id} doesn't exist.`);
  return task;
}

export function listTasks(db: DB, repoId: number, status?: Status): Task[] {
  const order = `ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, t.position, t.id`;
  if (status) {
    return db.prepare(`${SELECT_TASK} WHERE t.repo_id = ? AND t.status = ? ${order}`).all(repoId, status) as Task[];
  }
  return db.prepare(`${SELECT_TASK} WHERE t.repo_id = ? ${order}`).all(repoId) as Task[];
}

export interface TaskUpdate {
  title?: string;
  /** Pass an empty string to clear the description. */
  description?: string;
  status?: Status;
}

export function updateTask(db: DB, id: number, changes: TaskUpdate): Task {
  const current = getTask(db, id);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (!title) throw new UserError("A task's title can't be empty.");
    sets.push("title = @title");
    params.title = title;
  }
  if (changes.description !== undefined) {
    sets.push("description = @description");
    params.description = changes.description.trim() || null;
  }
  if (changes.status !== undefined && changes.status !== current.status) {
    sets.push("status = @status");
    sets.push(changes.status === "done" ? "completed_at = datetime('now')" : "completed_at = NULL");
    params.status = changes.status;
  }
  if (sets.length === 0) return current;

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getTask(db, id);
}

export function removeTask(db: DB, id: number): Task {
  const task = getTask(db, id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return task;
}

/** Returns false if that PR was already attached to the task. */
export function attachPr(db: DB, taskId: number, prNumber: number, prUrl: string): boolean {
  getTask(db, taskId);
  const result = db
    .prepare(
      `INSERT INTO task_prs (task_id, pr_number, pr_url) VALUES (?, ?, ?)
       ON CONFLICT (task_id, pr_number) DO NOTHING`,
    )
    .run(taskId, prNumber, prUrl);
  return result.changes > 0;
}

export function detachPr(db: DB, taskId: number, prNumber: number): void {
  getTask(db, taskId);
  const result = db.prepare("DELETE FROM task_prs WHERE task_id = ? AND pr_number = ?").run(taskId, prNumber);
  if (result.changes === 0) throw new UserError(`PR #${prNumber} isn't attached to task #${taskId}.`);
}

/** All PRs for the given tasks, grouped by task id. */
export function prsForTasks(db: DB, taskIds: number[]): Map<number, TaskPr[]> {
  const byTask = new Map<number, TaskPr[]>();
  if (taskIds.length === 0) return byTask;
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM task_prs WHERE task_id IN (${placeholders}) ORDER BY pr_number`)
    .all(...taskIds) as TaskPr[];
  for (const row of rows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push(row);
    byTask.set(row.task_id, list);
  }
  return byTask;
}
