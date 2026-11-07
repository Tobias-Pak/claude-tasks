import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DB = Database.Database;

/** Where the database lives. Override with TASKS_DB_PATH (tests use ":memory:"). */
export function defaultDbPath(): string {
  return process.env.TASKS_DB_PATH ?? path.join(os.homedir(), ".claude-tasks", "tasks.db");
}

/**
 * Schema migrations, applied in order. The index of each entry + 1 is the schema
 * version stored in PRAGMA user_version. Never edit an existing entry: append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE repos (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    remote_url  TEXT,
    local_path  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY,
    repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'done')),
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX idx_tasks_repo_status ON tasks(repo_id, status);

  CREATE TABLE task_prs (
    id          INTEGER PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pr_number   INTEGER NOT NULL,
    pr_url      TEXT NOT NULL,
    attached_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (task_id, pr_number)
  );
  `,
];

export function openDb(file: string = defaultDbPath()): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
