import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import type { PrFetcher } from "../src/github.js";
import { createTaskServer } from "../src/server.js";

/** Fake GitHub: PR 42 is open with passing checks, PR 7 is merged, anything else is "unavailable". */
const fakeFetchPr: PrFetcher = async (slug, n) => {
  if (n === 42) return { number: 42, title: "Fix session refresh", url: `https://github.com/${slug}/pull/42`, state: "open", checks: "passing" };
  if (n === 7) return { number: 7, title: "Set up CI", url: `https://github.com/${slug}/pull/7`, state: "merged", checks: "none" };
  return null;
};

let client: Client;

/** Call a tool the way Claude would and return its text plus whether it was an error. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

beforeEach(async () => {
  const server = createTaskServer({
    db: openDb(":memory:"),
    fetchPr: fakeFetchPr,
    getCwd: async () => "/definitely/not/a/repo",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

describe("MCP server", () => {
  it("exposes all ten tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_task", "attach_pr", "detach_pr", "get_task", "link_repo", "list_repos", "list_tasks", "remove_task", "unlink_repo", "update_task"],
    );
  });

  it("asks to link a repo before using it", async () => {
    const res = await call("add_task", { title: "Nope", repo: "o/r" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("isn't linked");
  });

  it("explains when the current folder isn't a repo", async () => {
    const res = await call("list_tasks");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("isn't a git repo");
  });

  it("runs the full task flow", async () => {
    expect((await call("link_repo", { repo: "https://github.com/TobiasPak/Wtake" })).text).toContain("Linked tobiaspak/wtake");

    await call("add_task", { title: "Fix the login bug", repo: "tobiaspak/wtake" });
    await call("add_task", { title: "Write API docs", description: "Cover every endpoint", repo: "tobiaspak/wtake" });
    await call("add_task", { title: "Set up CI", repo: "tobiaspak/wtake" });

    await call("update_task", { id: 1, status: "in_progress" });
    await call("update_task", { id: 3, status: "done" });
    expect((await call("attach_pr", { task_id: 1, pr: "#42" })).text).toContain('"Fix session refresh"');
    await call("attach_pr", { task_id: 3, pr: 7 });
    expect((await call("attach_pr", { task_id: 3, pr: 99 })).text).toContain("couldn't be checked");

    const list = (await call("list_tasks", { repo: "tobiaspak/wtake" })).text;
    expect(list).toContain("**tobiaspak/wtake: 3 tasks (2 open)**");
    expect(list.indexOf("In progress")).toBeLessThan(list.indexOf("To do"));
    expect(list.indexOf("To do")).toBeLessThan(list.indexOf("Done"));
    expect(list).toContain("- [ ] **#2 Write API docs** · *has description*");
    expect(list).toContain("open · ✅ checks passing");
    expect(list).toContain("- [x] **#3 Set up CI**");
    expect(list).toContain("PR #99](https://github.com/tobiaspak/wtake/pull/99) · status unavailable");
    expect(list).not.toContain("Cover every endpoint");

    const detail = (await call("get_task", { id: 2 })).text;
    expect(detail).toContain("Cover every endpoint");
    expect(detail).toContain("*None attached.*");

    expect((await call("list_repos")).text).toContain("**tobiaspak/wtake**: 2 open, 1 done");

    await call("detach_pr", { task_id: 3, pr_number: 99 });
    expect((await call("remove_task", { id: 2 })).text).toContain("Removed task #2");
    expect((await call("get_task", { id: 2 })).isError).toBe(true);

    expect((await call("unlink_repo", { repo: "tobiaspak/wtake", confirm: true })).text).toContain("deleted its 2 tasks");
  });

  it("rejects an update with nothing to change", async () => {
    await call("link_repo", { repo: "o/r" });
    await call("add_task", { title: "T", repo: "o/r" });
    expect((await call("update_task", { id: 1 })).isError).toBe(true);
  });
});
