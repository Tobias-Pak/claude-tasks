import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { UserError } from "../src/errors.js";
import { parseRepoSlug } from "../src/git.js";
import { parsePrRef, summarizeChecks } from "../src/github.js";
import { linkRepo, listRepos, unlinkRepo } from "../src/repos.js";
import { addTask, attachPr, listTasks, prsForTasks, removeTask, updateTask } from "../src/tasks.js";

describe("parseRepoSlug", () => {
  it.each([
    ["TobiasPak/Wtake", "tobiaspak/wtake"],
    ["https://github.com/TobiasPak/Wtake.git", "tobiaspak/wtake"],
    ["https://github.com/TobiasPak/Wtake/", "tobiaspak/wtake"],
    ["git@github.com:TobiasPak/Wtake.git", "tobiaspak/wtake"],
    ["ssh://git@github.com/TobiasPak/Wtake", "tobiaspak/wtake"],
    ["github.com/owner/my-repo.js", "owner/my-repo.js"],
  ])("%s -> %s", (input, expected) => {
    expect(parseRepoSlug(input)).toBe(expected);
  });

  it.each(["", "just-a-name", "a/b/c"])("rejects %j", (input) => {
    expect(parseRepoSlug(input)).toBeNull();
  });
});

describe("parsePrRef", () => {
  it("accepts numbers, #numbers and URLs", () => {
    expect(parsePrRef(42, "o/r")).toBe(42);
    expect(parsePrRef("#42", "o/r")).toBe(42);
    expect(parsePrRef("https://github.com/O/R/pull/42/files", "o/r")).toBe(42);
  });

  it("rejects a PR from another repo", () => {
    expect(() => parsePrRef("https://github.com/x/y/pull/1", "o/r")).toThrow(UserError);
  });
});

describe("summarizeChecks", () => {
  it("summarizes check runs and status contexts", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
    expect(summarizeChecks([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { state: "PENDING" }])).toBe("failing");
  });
});

describe("database", () => {
  it("does task CRUD with ordering and completion dates", () => {
    const db = openDb(":memory:");
    const { repo } = linkRepo(db, { slug: "o/r" });
    const a = addTask(db, repo.id, "First");
    const b = addTask(db, repo.id, "Second", "  details  ");
    expect(b.description).toBe("details");
    expect(b.position).toBe(a.position + 1);

    const done = updateTask(db, a.id, { status: "done" });
    expect(done.completed_at).not.toBeNull();
    expect(updateTask(db, a.id, { status: "todo" }).completed_at).toBeNull();

    updateTask(db, b.id, { status: "in_progress" });
    expect(listTasks(db, repo.id).map((t) => t.title)).toEqual(["Second", "First"]);
    expect(listTasks(db, repo.id, "in_progress")).toHaveLength(1);

    expect(updateTask(db, b.id, { description: "" }).description).toBeNull();
    removeTask(db, a.id);
    expect(() => removeTask(db, a.id)).toThrow(UserError);
  });

  it("keeps one row per repo slug and cascades deletes", () => {
    const db = openDb(":memory:");
    const first = linkRepo(db, { slug: "o/r", localPath: "/one" });
    const second = linkRepo(db, { slug: "o/r", localPath: "/two" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.repo.local_path).toBe("/two");

    const task = addTask(db, first.repo.id, "Has a PR");
    expect(attachPr(db, task.id, 5, "https://github.com/o/r/pull/5")).toBe(true);
    expect(attachPr(db, task.id, 5, "https://github.com/o/r/pull/5")).toBe(false);
    expect(listRepos(db)[0]).toMatchObject({ slug: "o/r", open_count: 1, done_count: 0 });

    expect(unlinkRepo(db, "o/r").taskCount).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(prsForTasks(db, [task.id]).size).toBe(0);
  });
});
