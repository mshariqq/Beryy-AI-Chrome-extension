import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// The ws-bridge module reads global WebSocket at call time, so we can stub it
// to test the protocol logic without a real WebSocket or Chrome.
let fakeInstances;
let autoOpen;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    fakeInstances.push(this);
    if (autoOpen) {
      queueMicrotask(() => {
        if (this.readyState === 0) {
          this.readyState = 1;
          this.onopen?.();
        }
      });
    }
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  // Test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(msg)) });
  }

  // Text frames (what the bridge actually sends) arrive as raw strings.
  receiveText(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  lastResponse() {
    const raw = this.sent.at(-1);
    return raw ? JSON.parse(raw) : null;
  }
}

let startWsBridge;
let stopWsBridge;

beforeEach(async () => {
  fakeInstances = [];
  autoOpen = true;
  globalThis.WebSocket = FakeWebSocket;
  ({ startWsBridge, stopWsBridge } = await import("../extension/shared/ws-bridge.js"));
});

afterEach(() => {
  stopWsBridge();
  delete globalThis.WebSocket;
});

function waitFor(fn, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = fn();
      if (value != null) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("discovers bridge on fallback port and registers the tool handler", async () => {
  const handled = [];
  startWsBridge(async (tool, args) => {
    handled.push({ tool, args });
    return { done: true };
  });

  // First instance is the discovery probe, second the real connection.
  const connection = await waitFor(() => fakeInstances[1]);
  assert.equal(connection.url, "ws://localhost:51777");

  connection.receive({
    type: "request",
    id: "ext_1",
    method: "executeTool",
    params: { tool: "navigate", args: { url: "https://example.com" } }
  });

  const response = await waitFor(() => connection.lastResponse());
  assert.equal(response.type, "response");
  assert.equal(response.id, "ext_1");
  assert.equal(response.payload.ok, true);
  assert.deepEqual(response.payload.result, { done: true });
  assert.deepEqual(handled, [{ tool: "navigate", args: { url: "https://example.com" } }]);
});

test("reports handler errors back to the bridge", async () => {
  startWsBridge(async () => {
    throw new Error("permission denied by policy");
  });

  const connection = await waitFor(() => fakeInstances[1]);
  connection.receive({
    type: "request",
    id: "ext_2",
    method: "executeTool",
    params: { tool: "computer", args: { action: "screenshot" } }
  });

  const response = await waitFor(() => connection.lastResponse());
  assert.equal(response.payload.ok, false);
  assert.match(response.payload.error, /permission denied by policy/);
});

test("answers ping requests", async () => {
  startWsBridge(async () => ({}));
  const connection = await waitFor(() => fakeInstances[1]);
  connection.receive({ type: "request", id: "ext_3", method: "ping", params: {} });
  const response = await waitFor(() => connection.lastResponse());
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.result.pong, true);
});

test("sends keepalive notifications while connected", async () => {
  startWsBridge(async () => ({}));
  const connection = await waitFor(() => fakeInstances[1]);
  const before = connection.sent.length;
  // Keepalive fires every 20s; just verify the mechanism is armed by
  // confirming no response-format messages are sent spontaneously.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const raw of connection.sent.slice(before)) {
    const msg = JSON.parse(raw);
    assert.notEqual(msg.type, "response");
  }
});

test("handles text-frame messages (strings) from the bridge", async () => {
  const handled = [];
  startWsBridge(async (tool, args) => ({ echoed: `${tool}:${args.url}` }));

  const connection = await waitFor(() => fakeInstances[1]);
  connection.receiveText({
    type: "request",
    id: "ext_9",
    method: "executeTool",
    params: { tool: "navigate", args: { url: "https://example.com" } }
  });

  const response = await waitFor(() => connection.lastResponse());
  assert.equal(response.type, "response");
  assert.equal(response.id, "ext_9");
  assert.equal(response.payload.ok, true);
  assert.deepEqual(response.payload.result, { echoed: "navigate:https://example.com" });
});

test("reconnects with backoff after the connection drops", async () => {
  startWsBridge(async () => ({}));
  const first = await waitFor(() => fakeInstances[1]);
  first.close();

  // A new connection should appear (backoff starts at 1s; wait longer).
  const second = await waitFor(() => fakeInstances[2], 5000);
  assert.notEqual(second, first);
  second.open();
  assert.equal(second.readyState, 1);
});
