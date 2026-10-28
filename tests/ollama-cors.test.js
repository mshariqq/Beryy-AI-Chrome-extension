import test from "node:test";
import assert from "node:assert/strict";

import {
  OLLAMA_ORIGIN_RULE_ID,
  buildOllamaOriginRules,
  ollamaOriginRuleIds
} from "../extension/shared/ollama-cors.js";
import { ALLOW_RULE_ID_START } from "../extension/shared/tracker-rules.js";

test("Ollama origin rules rewrite Origin only for extension requests", () => {
  const rules = buildOllamaOriginRules("abcdefghijklmnopabcdefghijklmnop");

  assert.equal(rules.length, 2);
  assert.deepEqual(
    rules.map((rule) => rule.condition.requestDomains[0]),
    ["localhost", "127.0.0.1"]
  );
  assert.deepEqual(
    rules.map((rule) => rule.action.requestHeaders[0].value),
    ["http://localhost", "http://127.0.0.1"]
  );

  for (const rule of rules) {
    assert.equal(rule.action.type, "modifyHeaders");
    assert.equal(rule.action.requestHeaders[0].header, "Origin");
    assert.equal(rule.action.requestHeaders[0].operation, "set");
    assert.deepEqual(rule.condition.initiatorDomains, [
      "abcdefghijklmnopabcdefghijklmnop"
    ]);
    assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
  }
});

test("Ollama origin rules use reserved dynamic rule ids", () => {
  const ids = ollamaOriginRuleIds();

  assert.deepEqual(ids, [OLLAMA_ORIGIN_RULE_ID, OLLAMA_ORIGIN_RULE_ID + 1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Math.max(...ids) < ALLOW_RULE_ID_START);
  assert.deepEqual(buildOllamaOriginRules(""), []);
});
