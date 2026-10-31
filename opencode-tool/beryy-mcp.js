#!/usr/bin/env node
/**
 * Beryy MCP Server
 *
 * Exposes Beryy's browser tools to opencode as an MCP server, the same way
 * opencode integrates Playwright (@playwright/mcp). Tool calls are forwarded
 * over the WebSocket bridge to the Beryy Chrome extension.
 *
 * opencode.json:
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "mcp": {
 *     "beryy": {
 *       "type": "local",
 *       "command": ["node", "C:/path/to/Beryy-chrome-ext/opencode-tool/beryy-mcp.js"],
 *       "enabled": true
 *     }
 *   }
 * }
 */

import { BeryyTool, TOOLS } from "./beryy-tool.js";
import { fileURLToPath } from "url";
import { resolve } from "path";

const SERVER_INFO = { name: "bery", version: "0.1.0" };

// OpenAI-style schema -> MCP inputSchema (strip nothing, shape matches).
function mcpTools() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.parameters
  }));
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function resultContent(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}

class BeryyMcpServer {
  constructor() {
    this.tool = new BeryyTool();
  }

  async handleMessage(msg) {
    const { id, method, params } = msg;

    // Notifications have no id and expect no response.
    if (id === undefined || id === null) {
      return;
    }

    try {
      let result;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          };
          break;

        case "tools/list":
          result = { tools: mcpTools() };
          break;

        case "tools/call": {
          const name = params?.name;
          if (!TOOLS[name]) {
            writeMessage({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Unknown tool: ${name}` }
            });
            return;
          }
          try {
            const toolResult = await this.tool.executeTool(name, params?.arguments || {});
            result = resultContent(toolResult);
          } catch (err) {
            result = errorContent(err.message);
          }
          break;
        }

        case "ping":
          result = {};
          break;

        default:
          writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          });
          return;
      }

      writeMessage({ jsonrpc: "2.0", id, result });
    } catch (err) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String(err?.message || err) }
      });
    }
  }

  start() {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          void this.handleMessage(msg);
        } catch {
          writeMessage({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          });
        }
      }
    });
    process.stdin.on("end", () => {
      this.tool.disconnect().finally(() => process.exit(0));
    });
    process.on("SIGINT", () => {
      this.tool.disconnect().finally(() => process.exit(0));
    });
  }
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedAs && fileURLToPath(import.meta.url) === invokedAs) {
  new BeryyMcpServer().start();
}
