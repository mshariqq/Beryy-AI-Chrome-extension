import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../extension/shared/prompt.js";

const context = { tabGroupId: 1, tabs: [] };

test("vision-off prompt forbids visual match claims", () => {
  const prompt = buildSystemPrompt({
    settings: {
      model: "model-a",
      vision: false,
      systemPromptExtra: ""
    },
    tabContext: context
  });

  assert.match(prompt, /cannot verify colors, shapes, or visual appearance/i);
  assert.match(prompt, /enable Vision in settings/i);
  assert.match(prompt, /Do not claim a visual match/i);
  assert.match(prompt, /providing the result the user asked for/i);
});

test("vision-on prompt allows screenshot-based tasks", () => {
  const prompt = buildSystemPrompt({
    settings: {
      model: "model-a",
      vision: true,
      systemPromptExtra: ""
    },
    tabContext: context
  });

  assert.match(prompt, /The model can see images/i);
  assert.doesNotMatch(prompt, /cannot verify colors, shapes, or visual appearance/i);
});

test("prompt explains automatic pacing only when enabled", () => {
  const paced = buildSystemPrompt({
    settings: { antiBotGuard: true, systemPromptExtra: "" },
    tabContext: context
  });
  assert.match(paced, /automatically adds a short pause/i);

  const unpaced = buildSystemPrompt({
    settings: { antiBotGuard: false, systemPromptExtra: "" },
    tabContext: context
  });
  assert.doesNotMatch(unpaced, /automatically adds a short pause/i);
});
