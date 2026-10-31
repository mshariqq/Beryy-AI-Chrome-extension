#!/usr/bin/env node
/**
 * Smoke test for the opencode bridge.
 * Requires: bridge running (node opencode-bridge.js) and the Beryy extension
 * sidepanel open. Starts a local tool to exercise the bridge, plus the
 * built-in local `list_files` tool which needs no extension.
 */

import { WebSocket } from "ws";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WS_URL_FILE = join(homedir(), ".beryy", "ws-url");

let url;
try {
  url = readFileSync(WS_URL_FILE, "utf8").trim();
} catch {
  console.error("[test] Bridge not running. Start with: node opencode-bridge.js");
  process.exit(1);
}

console.log("[test] Connecting to", url);

const ws = new WebSocket(url);
let pending = null;
let nextId = 0;

ws.on("open", async () => {
  console.log("[test] Connected to bridge");

  try {
    // 1. Local tool (no extension needed).
    const files = await sendRequest("executeTool", { tool: "list_files", args: { path: "." } });
    console.log(`[test] list_files ok (${files.files.length} entries)`);

    // 2. Bridge status.
    const status = await sendRequest("status", {});
    console.log("[test] status:", JSON.stringify(status));

    if (!status.extensionConnected) {
      console.warn("[test] Extension not connected - browser tools will fail.");
      console.warn("[test] Open the Beryy sidepanel, then re-run this test.");
    } else {
      // 3. Browser tool forwarded to the extension.
      const tabs = await sendRequest("executeTool", {
        tool: "tabs_context_mcp",
        args: {}
      });
      console.log("[test] tabs_context_mcp ok:", JSON.stringify(tabs).slice(0, 200));
    }

    console.log("[test] PASS");
    process.exit(0);
  } catch (err) {
    console.error("[test] FAIL:", err.message);
    process.exit(1);
  }
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === "response" && pending && pending.resolve) {
      const p = pending;
      pending = null;
      if (msg.payload.ok) p.resolve(msg.payload.result);
      else p.reject(new Error(msg.payload.error));
    }
  } catch {
    // Ignore malformed messages.
  }
});

ws.on("error", (err) => {
  console.error("[test] WebSocket error:", err.message);
  process.exit(1);
});

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending = { resolve, reject };
    ws.send(JSON.stringify({ type: "request", id, method, params }));
    setTimeout(() => {
      if (pending && pending.reject) {
        pending = null;
        reject(new Error("Timeout waiting for response"));
      }
    }, 30000);
  });
}
