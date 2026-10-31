// WebSocket bridge client for the Beryy background service worker.
//
// Connects to the opencode bridge (opencode-bridge.js) and executes browser
// tools on behalf of remote clients (opencode's MCP server). Runs entirely in
// the service worker: no chrome.runtime messaging round-trips.
//
// The bridge writes its URL to ~/.beryy/ws-url, which the extension cannot
// read - so we discover it by probing the fallback ports. The URL only needs
// to be found once; after that we reconnect to the same port with backoff.

const FALLBACK_PORTS = [51777, 51778, 51779, 51780];
const PROBE_TIMEOUT_MS = 800;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const DISCOVERY_RETRY_MS = 15000;
const KEEPALIVE_PING_MS = 20000;

let ws = null;
let wsUrl = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let stopped = false;
let toolHandler = null; // async (tool, args) => result

function probe(url) {
  return new Promise((resolve, reject) => {
    const testWs = new WebSocket(url);
    const timer = setTimeout(() => {
      testWs.onerror = testWs.onopen = null;
      try {
        testWs.close();
      } catch {
        // Already closed.
      }
      reject(new Error("timeout"));
    }, PROBE_TIMEOUT_MS);
    testWs.onopen = () => {
      clearTimeout(timer);
      testWs.onerror = null;
      testWs.close();
      resolve();
    };
    testWs.onerror = () => {
      clearTimeout(timer);
      reject(new Error("connection failed"));
    };
  });
}

async function discover() {
  for (const port of FALLBACK_PORTS) {
    const url = `ws://localhost:${port}`;
    try {
      await probe(url);
      return url;
    } catch {
      continue;
    }
  }
  throw new Error("No bridge found on any fallback port");
}

function isOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function send(message) {
  if (isOpen(ws)) {
    ws.send(JSON.stringify(message));
  }
}

function scheduleReconnect(delay) {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopped || isOpen(ws) || ws?.readyState === WebSocket.CONNECTING) return;

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WS bridge: connected", wsUrl);
    reconnectDelay = RECONNECT_MIN_MS;
    startKeepalive();
  };

  ws.onclose = (event) => {
    console.log("WS bridge: closed", event.code, event.reason);
    ws = null;
    stopKeepalive();
    if (!stopped) scheduleReconnect(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };

  ws.onerror = (err) => {
    console.warn("WS bridge: error", err?.message || "");
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      // Text frames arrive as strings; binary frames as ArrayBuffer.
      const raw =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
      msg = JSON.parse(raw);
    } catch {
      console.warn("WS bridge: invalid JSON");
      return;
    }
    if (msg.type === "request") {
      void handleRequest(msg);
    }
    // Responses and notifications are handled by request/keepalive logic.
  };
}

async function handleRequest(msg) {
  let payload;
  try {
    payload = { ok: true, result: await dispatch(msg.method, msg.params) };
  } catch (err) {
    payload = { ok: false, error: String(err?.message || err) };
  }
  send({ type: "response", id: msg.id, payload });
}

async function dispatch(method, params) {
  switch (method) {
    case "executeTool":
      if (!toolHandler) throw new Error("No tool handler registered");
      return toolHandler(params.tool, params.args || {});
    case "ping":
      return { pong: true };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function startKeepalive() {
  stopKeepalive();
  // Regular messages keep the MV3 service worker alive while the bridge is up.
  keepaliveTimer = setInterval(() => {
    if (isOpen(ws)) {
      send({ type: "notification", method: "ping", params: {} });
    }
  }, KEEPALIVE_PING_MS);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

async function init() {
  if (wsUrl) {
    connect();
    return;
  }
  try {
    wsUrl = await discover();
    console.log("WS bridge: discovered bridge at", wsUrl);
    connect();
  } catch {
    // Bridge not running yet - keep looking.
    if (!stopped) scheduleReconnect(DISCOVERY_RETRY_MS);
  }
}

/**
 * Start the bridge client. `handler` is called for every remote tool request:
 *   handler(tool, args) -> Promise<result>
 * Throws from the handler are reported back to the bridge as errors.
 */
export function startWsBridge(handler) {
  toolHandler = handler;
  stopped = false;
  init();
}

export function stopWsBridge() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopKeepalive();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  wsUrl = null;
}
