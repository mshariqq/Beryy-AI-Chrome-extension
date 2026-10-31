#!/usr/bin/env node
/**
 * Opencode Bridge for Beryy Chrome Extension
 *
 * WebSocket relay between the Beryy extension (in Chrome) and tool clients
 * (the MCP stdio server in opencode-tool/beryy-mcp.js, or beryy-tool.js).
 *
 * Connection roles are decided by the WebSocket Origin header:
 *   - "chrome-extension://..."  -> the extension (exactly one at a time)
 *   - no Origin (Node clients)  -> tool client (many allowed)
 *   - anything else (web pages) -> rejected
 *
 * Protocol (JSON messages):
 *   request     { type: "request", id, method, params }
 *   response    { type: "response", id, payload: { ok, result?, error? } }
 *   notification{ type: "notification", method, params }
 *
 * Usage: node opencode-bridge.js
 */

import { WebSocket, WebSocketServer } from "ws";
import { writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const FALLBACK_PORTS = [51777, 51778, 51779, 51780];
const DEFAULT_BRIDGE_DIR = join(homedir(), ".beryy");
const FORWARD_TIMEOUT_MS = 120000;
const PING_INTERVAL_MS = 20000;

// Browser tools forwarded to the extension.
export const BROWSER_TOOLS = new Set([
  "navigate",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "computer",
  "read_page",
  "get_page_text",
  "find"
]);

// Local tools executed by this Node process.
export const localToolHandlers = {
  read_file: async (args) => {
    const { readFileSync } = await import("fs");
    return { content: readFileSync(args.path, "utf8") };
  },
  write_file: async (args) => {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(args.path), { recursive: true });
    writeFileSync(args.path, args.content);
    return { success: true };
  },
  list_files: async (args) => {
    const { readdirSync, statSync } = await import("fs");
    const { join } = await import("path");
    const base = args.path || ".";
    const files = readdirSync(base).map((name) => {
      const full = join(base, name);
      const stat = statSync(full);
      return {
        name,
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime
      };
    });
    return { files };
  },
  run_command: async (args) => {
    const { spawn } = await import("child_process");
    return new Promise((resolve) => {
      const proc = spawn(args.command, {
        shell: true,
        cwd: args.cwd,
        timeout: args.timeout || 30000
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => resolve({ stdout, stderr, code }));
      proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
    });
  }
};

export class OpencodeBridge {
  constructor({ ports = FALLBACK_PORTS, bridgeDir = DEFAULT_BRIDGE_DIR, log = console } = {}) {
    this.ports = ports;
    this.bridgeDir = bridgeDir;
    this.log = log;
    this.wss = null;
    this.wsUrlFile = join(bridgeDir, "ws-url");
    this.extension = null; // WebSocket of the connected extension
    this.toolClients = new Set();
    this.requestSeq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer } for requests to the extension
    this.pingTimer = null;
  }

  async start() {
    mkdirSync(this.bridgeDir, { recursive: true });

    let lastError = null;
    for (const port of this.ports) {
      try {
        const url = await this.listen(port);
        writeFileSync(this.wsUrlFile, url);
        this.log.log(`[bridge] WebSocket server listening on ${url}`);
        this.log.log(`[bridge] URL written to ${this.wsUrlFile}`);
        this.log.log("[bridge] Waiting for the Beryy extension to connect...");
        this.pingTimer = setInterval(() => this.pingClients(), PING_INTERVAL_MS);
        return url;
      } catch (err) {
        lastError = err;
        this.log.warn?.(`[bridge] Port ${port} unavailable: ${err.message}`);
      }
    }
    throw lastError || new Error("No available port");
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port });
      const onError = (err) => {
        wss.removeAllListeners();
        reject(err);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.removeListener("error", onError);
        this.wss = wss;
        wss.on("connection", (ws, req) => this.handleConnection(ws, req));
        resolve(`ws://localhost:${wss.address().port}`);
      });
    });
  }

  handleConnection(ws, req) {
    const origin = req.headers.origin || "";

    if (origin.startsWith("chrome-extension://")) {
      this.attachExtension(ws, origin);
    } else if (!origin) {
      // Node.js clients (ws library) send no Origin header.
      this.attachToolClient(ws);
    } else {
      // A web page is trying to connect - never allowed.
      this.log.warn?.(`[bridge] Rejected connection from origin: ${origin}`);
      ws.close(4001, "Origin not allowed");
    }
  }

  attachExtension(ws, origin) {
    if (this.extension && this.extension.readyState === WebSocket.OPEN) {
      this.log.log("[bridge] Replacing existing extension connection");
      this.extension.close(4000, "Replaced by a new extension connection");
    }
    this.extension = ws;
    this.log.log(`[bridge] Extension connected (${origin})`);
    this.broadcastToolStatus();

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        this.log.error("[bridge] Invalid JSON from extension:", err.message);
        return;
      }
      if (msg.type === "response") {
        this.resolveExtensionResponse(msg);
      } else if (msg.type === "request") {
        // The extension may ask local questions (ping for now).
        this.handleExtensionRequest(ws, msg);
      } else if (msg.type === "notification") {
        if (msg.method !== "pong") {
          this.log.log("[bridge] Extension notification:", msg.method);
        }
      }
    });

    ws.on("close", (code) => {
      if (this.extension === ws) {
        this.extension = null;
        this.log.log(`[bridge] Extension disconnected (code ${code})`);
        this.failPending("Extension disconnected");
        this.broadcastToolStatus();
      }
    });

    ws.on("error", (err) => {
      this.log.error("[bridge] Extension socket error:", err.message);
    });
  }

  attachToolClient(ws) {
    this.toolClients.add(ws);
    this.log.log(
      `[bridge] Tool client connected (${this.toolClients.size} active). Extension: ${
        this.extension ? "connected" : "not connected"
      }`
    );

    this.send(ws, {
      type: "notification",
      method: "extension_status",
      params: { connected: Boolean(this.extension) }
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        this.log.error("[bridge] Invalid JSON from tool client:", err.message);
        return;
      }
      if (msg.type === "request") {
        this.handleToolRequest(ws, msg).catch((err) => {
          this.log.error("[bridge] Tool request failed:", err.message);
        });
      }
    });

    ws.on("close", () => {
      this.toolClients.delete(ws);
    });

    ws.on("error", (err) => {
      this.log.error("[bridge] Tool client socket error:", err.message);
    });
  }

  async handleToolRequest(ws, msg) {
    const { id, method, params } = msg;
    let payload;
    try {
      payload = { ok: true, result: await this.dispatch(method, params) };
    } catch (err) {
      payload = { ok: false, error: String(err?.message || err) };
    }
    this.send(ws, { type: "response", id, payload });
  }

  async dispatch(method, params) {
    switch (method) {
      case "executeTool":
        return this.executeTool(params.tool, params.args);
      case "ping":
        return { pong: true, extensionConnected: Boolean(this.extension) };
      case "status":
        return {
          extensionConnected: Boolean(this.extension),
          toolClients: this.toolClients.size,
          browserTools: [...BROWSER_TOOLS],
          localTools: Object.keys(localToolHandlers)
        };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async executeTool(toolName, args) {
    if (localToolHandlers[toolName]) {
      this.log.log(`[bridge] Executing local tool: ${toolName}`);
      return localToolHandlers[toolName](args || {});
    }
    if (BROWSER_TOOLS.has(toolName)) {
      this.log.log(`[bridge] Forwarding browser tool to extension: ${toolName}`);
      return this.forwardToExtension(toolName, args || {});
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  forwardToExtension(toolName, args) {
    return new Promise((resolve, reject) => {
      const ext = this.extension;
      if (!ext || ext.readyState !== WebSocket.OPEN) {
        reject(
          new Error(
            "No extension connected. Open the Beryy sidepanel and make sure the bridge is running."
          )
        );
        return;
      }

      const id = `ext_${++this.requestSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension tool ${toolName} timed out after ${FORWARD_TIMEOUT_MS}ms`));
      }, FORWARD_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send(ext, {
        type: "request",
        id,
        method: "executeTool",
        params: { tool: toolName, args }
      });
    });
  }

  resolveExtensionResponse(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    const payload = msg.payload || {};
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(payload.error || "Extension tool failed"));
    }
  }

  failPending(message) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  handleExtensionRequest(ws, msg) {
    const payload =
      msg.method === "ping"
        ? { ok: true, result: { pong: true } }
        : { ok: false, error: `Unknown method: ${msg.method}` };
    this.send(ws, { type: "response", id: msg.id, payload });
  }

  broadcastToolStatus() {
    const params = { connected: Boolean(this.extension) };
    for (const client of this.toolClients) {
      this.send(client, { type: "notification", method: "extension_status", params });
    }
  }

  pingClients() {
    const notification = JSON.stringify({ type: "notification", method: "ping", params: {} });
    for (const ws of [this.extension, ...this.toolClients]) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(notification);
      }
    }
  }

  send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failPending("Bridge shutting down");
    if (this.wss) {
      for (const ws of this.wss.clients) ws.close();
      this.wss.close();
    }
  }
}

// Run only when executed directly (not when imported by tests).
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedAs && fileURLToPath(import.meta.url) === invokedAs) {
  const bridge = new OpencodeBridge();

  const shutdown = () => {
    bridge.log.log("\n[bridge] Shutting down...");
    bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await bridge.start();
    bridge.log.log("[bridge] Ready. Press Ctrl+C to stop.");
  } catch (err) {
    bridge.log.error("[bridge] Failed to start:", err.message);
    process.exit(1);
  }
}
