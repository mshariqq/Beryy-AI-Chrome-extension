import test from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../extension/lib/tools.js";

function screenshotContext(vision) {
  return {
    settings: { vision, blockedDomains: [] },
    tabs: {
      resolveTabId: async () => 11,
      getTabInfo: async () => ({ id: 11, url: "https://example.test/" })
    },
    cdp: {
      async send(_tabId, method) {
        if (method === "Runtime.evaluate") {
          return { result: { value: JSON.stringify([800, 600, 1]) } };
        }
        if (method === "Page.captureScreenshot") {
          return { data: "ZmFrZS1pbWFnZQ==" };
        }
        throw new Error(`Unexpected CDP method: ${method}`);
      }
    },
    screenshots: {
      add: () => "screenshot_1"
    }
  };
}

test("screenshot results say when Vision is off", async () => {
  const result = await executeTool(screenshotContext(false), "computer", {
    action: "screenshot"
  });
  const text = result.content[0].text;

  assert.match(text, /Captured screenshot/);
  assert.match(text, /Vision is off/);
  assert.match(text, /not visible to the model/);
});

test("screenshot results omit the Vision warning when enabled", async () => {
  const result = await executeTool(screenshotContext(true), "computer", {
    action: "screenshot"
  });
  const text = result.content[0].text;

  assert.match(text, /Captured screenshot/);
  assert.doesNotMatch(text, /Vision is off/);
});
