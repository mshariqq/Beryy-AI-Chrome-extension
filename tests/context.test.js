import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPACTION_THRESHOLD,
  contextUsage,
  contextWindowFor,
  estimateMessageTokens,
  estimateMessagesTokens,
  shouldCompact
} from "../extension/shared/context.js";

test("context windows are recognized for supported model families", () => {
  assert.equal(contextWindowFor("gemma-4-26b-a4b-it"), 256000);
  assert.equal(contextWindowFor("gemma-4-31b-it"), 256000);
  assert.equal(contextWindowFor("gemma-4-e2b-it"), 128000);
  assert.equal(contextWindowFor("meta/llama-3.3-70b-instruct"), 128000);
  assert.equal(contextWindowFor("gemini-2.5-pro"), 1048576);
  assert.equal(contextWindowFor("unknown-model"), 128000);
});

test("message estimates include text, tool calls, and screenshots", () => {
  const text = estimateMessageTokens({ role: "user", content: "x".repeat(350) });
  const tools = estimateMessageTokens({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_1", function: { name: "read_page", arguments: "{}" } }]
  });
  const image = estimateMessageTokens({
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }]
  });

  assert.ok(text >= 104);
  assert.ok(tools > 4);
  assert.ok(image >= 1200);
});

test("compaction starts at 85 percent of the context window", () => {
  assert.equal(COMPACTION_THRESHOLD, 0.85);

  const messages = [{ role: "user", content: "x".repeat(3500) }];
  const tokens = estimateMessagesTokens(messages);
  const window = Math.floor(tokens / COMPACTION_THRESHOLD);

  assert.ok(contextUsage(messages, window) >= 0.85);
  assert.equal(shouldCompact(messages, window), true);
  assert.equal(shouldCompact(messages, Math.ceil(window * 1.05)), false);
});
