import test from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../extension/lib/tools.js";

test("navigate listens for completion before starting the navigation", async () => {
  const originalChrome = globalThis.chrome;
  const listeners = new Set();
  let updatedUrl = "";

  globalThis.chrome = {
    tabs: {
      async update(tabId, options) {
        assert.equal(tabId, 7);
        updatedUrl = options.url;
        for (const listener of [...listeners]) {
          listener(tabId, { status: "complete" });
        }
      },
      onUpdated: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        }
      }
    }
  };

  const ctx = {
    settings: { blockedDomains: [] },
    tabs: {
      resolveTabId: async () => 7,
      getTabInfo: async () => ({ id: 7, url: "https://example.test/" })
    }
  };

  try {
    const result = await executeTool(ctx, "navigate", {
      url: "https://example.test/next"
    });
    const text = result.content[0].text;

    assert.equal(updatedUrl, "https://example.test/next");
    assert.match(text, /Navigated tab 7/);
    assert.doesNotMatch(text, /still loading/);
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
