import test from "node:test";
import assert from "node:assert/strict";

import { nextActionDelay, shouldPaceAction } from "../extension/shared/pacing.js";

test("pacing covers browser actions but not routine reads", () => {
  assert.equal(shouldPaceAction("computer", { action: "left_click" }), true);
  assert.equal(shouldPaceAction("computer", { action: "type" }), true);
  assert.equal(shouldPaceAction("computer", { action: "scroll" }), true);
  assert.equal(shouldPaceAction("navigate", { url: "https://example.com" }), true);
  assert.equal(shouldPaceAction("form_input", { ref: "a" }), true);
  assert.equal(shouldPaceAction("tabs_create_mcp"), true);

  assert.equal(shouldPaceAction("read_page"), false);
  assert.equal(shouldPaceAction("find", { query: "x" }), false);
  assert.equal(shouldPaceAction("read_network_requests"), false);
  assert.equal(shouldPaceAction("tabs_context_mcp"), false);
  assert.equal(shouldPaceAction("computer", { action: "screenshot" }), false);
  assert.equal(shouldPaceAction("computer", { action: "wait" }), false);
});

test("nextActionDelay respects the toggle, base delay, and jitter", () => {
  assert.equal(
    nextActionDelay({ antiBotGuard: false, actionDelayMs: 500 }, "navigate"),
    0
  );
  assert.equal(
    nextActionDelay({ antiBotGuard: true, actionDelayMs: 0 }, "navigate"),
    0
  );
  assert.equal(
    nextActionDelay({ antiBotGuard: true, actionDelayMs: 400 }, "read_page"),
    0
  );
  assert.equal(
    nextActionDelay({ antiBotGuard: true, actionDelayMs: 400 }, "navigate", {}, () => 0),
    400
  );
  assert.equal(
    nextActionDelay({ antiBotGuard: true, actionDelayMs: 400 }, "navigate", {}, () => 0.5),
    500
  );
  assert.equal(
    nextActionDelay({ antiBotGuard: true, actionDelayMs: 400 }, "navigate", {}, () => 2),
    600
  );
});
