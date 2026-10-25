import test from "node:test";
import assert from "node:assert/strict";
import {
  extractToolCalls,
  listModels,
  ProviderTimeoutError,
  streamChat
} from "../extension/sidepanel/provider.js";

test("extracts a single XML tool call and strips it from the text", () => {
  const result = extractToolCalls(
    'Let me look.\n<tool_call>{"name":"read_page","arguments":{"filter":"interactive"}}</tool_call>'
  );
  assert.equal(result.text, "Let me look.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_page");
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
    filter: "interactive"
  });
});

test("extracts multiple XML tool calls in order", () => {
  const result = extractToolCalls(
    [
      '<tool_call>{"name":"tabs_context_mcp","arguments":{"createIfEmpty":true}}</tool_call>',
      '<tool_call>{"name":"find","arguments":{"query":"Sign in"}}</tool_call>'
    ].join("\n")
  );
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["tabs_context_mcp", "find"]
  );
  assert.equal(result.text, "");
});

test("accepts tool/args aliases and object arguments", () => {
  const result = extractToolCalls(
    '<tool_call>{"tool":"navigate","args":{"url":"https://example.com"}}</tool_call>'
  );
  assert.equal(result.toolCalls[0].name, "navigate");
  assert.equal(
    JSON.parse(result.toolCalls[0].arguments).url,
    "https://example.com"
  );
});

test("falls back to a fenced JSON block when no XML is present", () => {
  const result = extractToolCalls(
    'I will search.\n```json\n{"name":"find","arguments":{"query":"Search"}}\n```'
  );
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "find");
  assert.equal(result.text, "I will search.");
});

test("ignores malformed blocks without throwing", () => {
  const result = extractToolCalls(
    "Before\n<tool_call>not json</tool_call>\nAfter"
  );
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.text, "Before\n\nAfter");
});

test("leaves ordinary prose untouched", () => {
  const result = extractToolCalls("Just a normal answer.");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.text, "Just a normal answer.");
});

test("listModels reads, dedupes, and sorts model ids", async () => {
  const originalFetch = globalThis.fetch;
  let requested = null;

  globalThis.fetch = async (url, options) => {
    requested = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }]
      })
    };
  };

  try {
    const models = await listModels({
      baseUrl: "https://example.test/v1",
      apiKey: "secret"
    });
    assert.deepEqual(models, ["a-model", "b-model"]);
    assert.equal(requested.url, "https://example.test/v1/models");
    assert.equal(requested.options.headers.Authorization, "Bearer secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listModels surfaces provider errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "bad key" } })
  });

  try {
    await assert.rejects(
      listModels({ baseUrl: "https://example.test/v1", apiKey: "nope" }),
      /bad key/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listModels requires an API key", async () => {
  await assert.rejects(
    listModels({ baseUrl: "https://example.test/v1", apiKey: "" }),
    /API key/
  );
});

function providerSettings() {
  return {
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "test-model",
    temperature: 0,
    maxTokens: 100,
    toolMode: "prompt"
  };
}

test("streamChat explains models unavailable for the account", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () =>
      JSON.stringify({
        status: 404,
        title: "Not Found",
        detail:
          "Function '767b5b9a-3f9d-4c1d-86e8-fa861988cee7': Not found for account 'example-account'"
      })
  });

  try {
    await assert.rejects(
      streamChat({
        settings: providerSettings(),
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      /not available for your account/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat times out while waiting for response headers", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });

  try {
    await assert.rejects(
      streamChat({
        settings: providerSettings(),
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true,
        timeoutMs: 10,
        idleTimeoutMs: 1000
      }),
      (error) => {
        assert.equal(error instanceof ProviderTimeoutError, true);
        assert.match(error.message, /did not respond/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat retries a temporary provider failure", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].map((chunk) => encoder.encode(chunk));
  const retries = [];
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        text: async () =>
          JSON.stringify({ error: { message: "temporarily unavailable" } })
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            chunks.length ? { done: false, value: chunks.shift() } : { done: true },
          releaseLock: () => {}
        })
      }
    };
  };

  try {
    const result = await streamChat({
      settings: { ...providerSettings(), provider: "custom" },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      forcePrompt: true,
      onRetryWait: (event) => retries.push(event)
    });
    assert.equal(calls, 2);
    assert.equal(result.content, "Recovered");
    assert.equal(retries[0].status, 503);
    assert.equal(retries[0].waitMs, 1000);
    assert.equal(retries.at(-1).waitMs, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat retries 429 and honors Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].map((chunk) => encoder.encode(chunk));
  const retries = [];
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name.toLowerCase() === "retry-after" ? "3" : null)
        },
        text: async () =>
          JSON.stringify({ error: { message: "rate limit exceeded" } })
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            chunks.length ? { done: false, value: chunks.shift() } : { done: true },
          releaseLock: () => {}
        })
      }
    };
  };

  try {
    const result = await streamChat({
      settings: { ...providerSettings(), provider: "groq" },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      forcePrompt: true,
      onRetryWait: (event) => retries.push(event)
    });
    assert.equal(calls, 2);
    assert.equal(result.content, "Recovered");
    assert.equal(retries[0].status, 429);
    assert.equal(retries[0].waitMs, 3250);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxRetries, 4);
    assert.equal(retries.at(-1).waitMs, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat reads reset headers when Retry-After is absent", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].map((chunk) => encoder.encode(chunk));
  const retries = [];
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name) =>
            name.toLowerCase() === "x-ratelimit-reset-tokens" ? "0.05s" : null
        },
        text: async () =>
          JSON.stringify({ error: { message: "rate limit exceeded" } })
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            chunks.length ? { done: false, value: chunks.shift() } : { done: true },
          releaseLock: () => {}
        })
      }
    };
  };

  try {
    await streamChat({
      settings: { ...providerSettings(), provider: "custom" },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      forcePrompt: true,
      onRetryWait: (event) => retries.push(event)
    });
    assert.equal(calls, 2);
    assert.equal(retries[0].waitMs, 300);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat explains OpenRouter free-model privacy blocks", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () =>
      JSON.stringify({
        error: {
          message:
            "No endpoints found matching your data policy (Free model publication)"
        }
      })
  });

  try {
    await assert.rejects(
      streamChat({
        settings: { ...providerSettings(), provider: "openrouter" },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      /Allow free-model publication/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat times out when the stream goes idle", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        releaseLock: () => {}
      })
    }
  });

  try {
    await assert.rejects(
      streamChat({
        settings: providerSettings(),
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true,
        timeoutMs: 1000,
        idleTimeoutMs: 10
      }),
      (error) => {
        assert.equal(error instanceof ProviderTimeoutError, true);
        assert.match(error.message, /stopped sending data/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
