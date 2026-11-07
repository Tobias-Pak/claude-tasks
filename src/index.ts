#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db.js";
import { createTaskServer } from "./server.js";

// stdout carries the MCP protocol, so all logging must go to stderr.
async function main(): Promise<void> {
  const db = openDb();
  const server = createTaskServer({ db });
  await server.connect(new StdioServerTransport());
  console.error("claude-tasks MCP server running");

  const shutdown = () => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("claude-tasks failed to start:", err);
  process.exit(1);
});
