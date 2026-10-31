import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { OpencodeBridge } from "../opencode-bridge.js";

let bridge;
let bridgeDir;

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function request(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = `t_${Math.random().toString(36).slice(2)}`;
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response" && msg.id === id) {
        ws.removeListener("message", onMessage);
        resolve(msg.payload);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

function notifications(ws) {
  const received = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "notification") received.push(msg);
  });
  return received;
}

beforeEach(() => {
  bridgeDir = mkdtempSync(join(tmpdir(), "beryy-bridge-test-"));
  bridge = new OpencodeBridge({
    ports: [0],
    bridgeDir,
    log: { log() {}, warn() {}, error() {} }
  });
});

afterEach(() => {
  bridge.stop();
  rmSync(bridgeDir, { recursive: true, force: true });
});

test("bridge listens, writes ws-url file, and answers ping", async () => {
  const url = await bridge.start();
  assert.match(url, /^ws:\/\/localhost:\d+$/);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(bridgeDir, "ws-url"), "utf8").trim(), url);

  const tool = new WebSocket(url);
  await waitOpen(tool);
  const payload = await request(tool, "ping", {});
  assert.equal(payload.ok, true);
  assert.equal(payload.result.pong, true);
  tool.close();
});

test("rejects connections from web page origins", async () => {
  const url = await bridge.start();
  const page = new WebSocket(url, { origin: "https://evil.example" });
  const closed = await Promise.race([
    waitClose(page),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000))
  ]);
  assert.ok(closed, "expected the socket to close");
  assert.equal(closed.code, 4001);
});

test("routes browser tool requests from tool clients to the extension", async () => {
  const url = await bridge.start();

  const extension = new WebSocket(url, { origin: "chrome-extension://testextensionid" });
  await waitOpen(extension);

  const tool = new WebSocket(url);
  const notes = notifications(tool);
  await waitOpen(tool);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = notes.find((n) => n.method === "extension_status");
  assert.ok(status, "tool client should receive extension_status");
  assert.equal(status.params.connected, true);

  // Answer the forwarded request from the "extension" side.
  extension.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "request" && msg.method === "executeTool") {
      assert.equal(msg.params.tool, "navigate");
      assert.deepEqual(msg.params.args, { url: "https://example.com" });
      extension.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          payload: { ok: true, result: { navigated: true } }
        })
      );
    }
  });

  const payload = await request(tool, "executeTool", {
    tool: "navigate",
    args: { url: "https://example.com" }
  });
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.result, { navigated: true });
  extension.close();
  tool.close();
});

test("forwarding fails when no extension is connected", async () => {
  const url = await bridge.start();
  const tool = new WebSocket(url);
  await waitOpen(tool);
  const payload = await request(tool, "executeTool", {
    tool: "navigate",
    args: { url: "https://example.com" }
  });
  assert.equal(payload.ok, false);
  assert.match(payload.error, /No extension connected/);
});

test("extension disconnect rejects pending forwards and notifies tools", async () => {
  const url = await bridge.start();

  const extension = new WebSocket(url, { origin: "chrome-extension://testextensionid" });
  await waitOpen(extension);
  const tool = new WebSocket(url);
  const notes = notifications(tool);
  await waitOpen(tool);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(notes.find((n) => n.method === "extension_status").params.connected, true);

  // Extension takes a request but never answers; then disconnects.
  extension.on("message", () => {
    /* no response */
  });
  const slow = request(tool, "executeTool", { tool: "find", args: { query: "x" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  extension.close();

  // The bridge surfaces the disconnect as an error payload on the tool's request.
  const payload = await slow;
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Extension disconnected/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const last = notes.filter((n) => n.method === "extension_status").pop();
  assert.equal(last.params.connected, false);
  tool.close();
});

test("executes local tools without an extension", async () => {
  const url = await bridge.start();
  const tool = new WebSocket(url);
  await waitOpen(tool);
  const payload = await request(tool, "executeTool", { tool: "list_files", args: { path: bridgeDir } });
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.result.files));
  tool.close();
});

test("unknown tools produce an error response", async () => {
  const url = await bridge.start();
  const tool = new WebSocket(url);
  await waitOpen(tool);
  const payload = await request(tool, "executeTool", { tool: "does_not_exist", args: {} });
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Unknown tool/);
  tool.close();
});

test("status reports roles and tool lists", async () => {
  const url = await bridge.start();
  const tool = new WebSocket(url);
  await waitOpen(tool);
  const payload = await request(tool, "status", {});
  assert.equal(payload.ok, true);
  assert.equal(payload.result.extensionConnected, false);
  assert.ok(payload.result.browserTools.includes("computer"));
  assert.ok(payload.result.localTools.includes("run_command"));
  tool.close();
});
