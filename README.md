# claude-tasks

A task list that lives inside Claude. Each GitHub repo gets its own checklist, tasks can have descriptions, and pull requests can be attached to tasks with their live status (open / merged, CI passing or failing).

You don't open an app. You just talk to Claude:

> "Link this repo"
> "Add a task to fix the login bug"
> "Bring up my task list"
> "Attach PR 42 to task 7"
> "Mark task 7 done"

Under the hood it's an **MCP server**: a small Node.js program that gives Claude a set of tools (`add_task`, `list_tasks`, …) backed by a local SQLite database.

## How it works

```
You ──chat──> Claude ──MCP (stdio)──> claude-tasks ──> SQLite (~/.claude-tasks/tasks.db)
                                           ├──> git  (which repo am I in?)
                                           └──> gh   (live PR + CI status)
```

- **Repos** are identified by their git remote, normalized to a slug like `owner/repo`. That way the same repo maps to one checklist whether it's cloned over HTTPS or SSH, or in different folders.
- **The current repo** is detected from the folder Claude is working in. You never have to name it unless you want a different one.
- **PR status** isn't stored. It's fetched live through the GitHub CLI each time you list tasks, so it's never stale.

### Database

| Table | Columns |
|---|---|
| `repos` | `id`, `slug` (unique), `remote_url`, `local_path`, `created_at` |
| `tasks` | `id`, `repo_id` → repos, `title`, `description`, `status` (`todo` / `in_progress` / `done`), `position`, `created_at`, `updated_at`, `completed_at` |
| `task_prs` | `id`, `task_id` → tasks, `pr_number`, `pr_url`, `attached_at` |

A repo has many tasks, and a task has many PRs. Deleting a repo or task cascades to its children. Schema changes are versioned with `PRAGMA user_version` (see [src/db.ts](src/db.ts)).

### Tools

| Tool | What it does |
|---|---|
| `link_repo` / `unlink_repo` / `list_repos` | Choose which repos have task lists |
| `add_task` | Add a task (optional description) |
| `list_tasks` | Show the checklist grouped by status, with PRs and live status |
| `get_task` | Full detail for one task, including its description |
| `update_task` | Rename, edit description, or change status (check off / reopen) |
| `remove_task` | Delete a task |
| `attach_pr` / `detach_pr` | Link pull requests to tasks |

## Setup

Requirements: Node.js 20+, git, and the [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`) for PR status.

```bash
git clone https://github.com/Tobias-Pak/claude-tasks.git
cd claude-tasks
npm install
npm run build
```

Register it with Claude Code for every project (use the absolute path to `dist/index.js`):

```bash
claude mcp add tasks --scope user -- node /absolute/path/to/claude-tasks/dist/index.js
```

For the Claude desktop app, add it to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tasks": { "command": "node", "args": ["/absolute/path/to/claude-tasks/dist/index.js"] }
  }
}
```

Set `TASKS_DB_PATH` to store the database somewhere other than `~/.claude-tasks/tasks.db`.

## Development

```bash
npm test          # unit tests + end-to-end tests through a real MCP client
npm run dev       # recompile on change
npm run inspect   # try the tools by hand in the MCP Inspector
```

## Tech stack

TypeScript · Node.js · Model Context Protocol SDK · SQLite (better-sqlite3) · zod · GitHub CLI · Vitest
