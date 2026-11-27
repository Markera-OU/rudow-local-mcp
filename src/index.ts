#!/usr/bin/env node
// Rudow local MCP server (stdio).
//
// Lets an AI coding agent read your own local log files over MCP. The
// server reads only the files you configure, parses them in memory, and
// answers tool calls from that data. It makes no network calls, needs no
// account, and sends nothing anywhere. Log files are re-read when they
// change, so a growing file is picked up on the next tool call.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveSources } from "./config.js";
import { handleTool, isKnownTool } from "./handlers.js";
import { LogStore } from "./store.js";
import { TOOLS } from "./tools.js";

export const VERSION = "0.1.0";

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function createServer(store: LogStore): Server {
  const server = new Server(
    { name: "rudow-local", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (!isKnownTool(name)) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      store.load();
      const result = handleTool(name, args as Record<string, unknown>, store);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  });

  return server;
}

const sources = resolveSources();
const store = new LogStore(sources);
store.load();
if (sources.length === 0) {
  console.error(
    "rudow-local-mcp: no log files configured. Pass paths as arguments, set " +
      "RUDOW_LOCAL_LOG_PATHS, or add a rudow-local.json config file. " +
      "list_sources will report the same.",
  );
}
await createServer(store).connect(new StdioServerTransport());
