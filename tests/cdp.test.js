import test from "node:test";
import assert from "node:assert/strict";

import { CDP } from "../extension/lib/cdp.js";

test("cdp keeps execution contexts from different sessions separate", () => {
  const cdp = new CDP();
  cdp.handleEvent(1, "Runtime.executionContextCreated", {
    context: { id: 1, auxData: { frameId: "top", isDefault: true } }
  });
  cdp.handleEvent(
    1,
    "Runtime.executionContextCreated",
    { context: { id: 2, auxData: { frameId: "child" } } },
    "session-1"
  );

  const contexts = cdp.executionContexts(1);
  assert.equal(contexts.length, 2);
  assert.deepEqual(
    contexts.map((context) => [context.id, context.sessionId, context.frameId]),
    [
      [1, "", "top"],
      [2, "session-1", "child"]
    ]
  );

  cdp.handleEvent(1, "Runtime.executionContextsCleared", {}, "session-1");
  assert.deepEqual(
    cdp.executionContexts(1).map((context) => context.id),
    [1]
  );

  cdp.handleEvent(1, "Runtime.executionContextDestroyed", {
    executionContextId: 1
  });
  assert.equal(cdp.executionContexts(1).length, 0);
});

test("cdp routes commands to a child session when asked", async () => {
  const calls = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    debugger: {
      attach: async () => {},
      sendCommand: async (target, method, params) => {
        calls.push({ target, method, params });
        return {};
      }
    }
  };

  try {
    const cdp = new CDP();
    await cdp.ensureAttached(7);
    await cdp.send(7, "Runtime.evaluate", { expression: "1" }, 1000, "session-2");

    const evaluate = calls.find((call) => call.method === "Runtime.evaluate");
    assert.deepEqual(evaluate.target, { tabId: 7, sessionId: "session-2" });
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
