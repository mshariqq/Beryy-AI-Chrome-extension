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

test("listModels reads native Ollama tags without an API key", async () => {
  const originalFetch = globalThis.fetch;
  let requested = null;

  globalThis.fetch = async (url, options) => {
    requested = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: "qwen2.5:7b" }, { name: "llama3.2:latest" }, { name: "llama3.2:latest" }]
      })
    };
  };

  try {
    const models = await listModels({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      apiKey: "",
      ollama: { apiMode: "native" }
    });
    assert.deepEqual(models, ["llama3.2:latest", "qwen2.5:7b"]);
    assert.equal(requested.url, "http://localhost:11434/api/tags");
    assert.equal(requested.options.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat sends native Ollama options and parses NDJSON", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requested = null;
  const deltas = [];
  const reasoning = [];
  const chunks = [
    { message: { content: "Hel" } },
    { message: { content: "lo", thinking: "considering" } },
    {
      message: {
        content: "",
        tool_calls: [{ function: { name: "read_page", arguments: { filter: "interactive" } } }]
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 5
    }
  ].map((entry) => encoder.encode(`${JSON.stringify(entry)}\n`));

  globalThis.fetch = async (url, options) => {
    requested = { url, options, body: JSON.parse(options.body) };
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
      settings: {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "llama3.2",
        temperature: 0.3,
        maxTokens: 2048,
        toolMode: "native",
        ollama: {
          apiMode: "native",
          keepAlive: "1h",
          numCtx: 4096,
          numGpu: 10,
          numThread: 6,
          numBatch: 64,
          numKeep: 8,
          numPredict: 512,
          topK: 20,
          topP: 0.8,
          minP: 0.05,
          repeatPenalty: 1.2,
          repeatLastN: 32,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          seed: 42,
          stop: "END\nSTOP",
          think: "high",
          flashAttn: "on",
          kvCacheType: "q8_0",
          useMmap: false,
          useMlock: true,
          requestTimeoutMs: 180000,
          idleTimeoutMs: 120000
        }
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_page" } }],
      onDelta: (delta) => deltas.push(delta),
      onReasoning: (delta) => reasoning.push(delta)
    });

    assert.equal(requested.url, "http://localhost:11434/api/chat");
    assert.equal(requested.options.headers.Authorization, undefined);
    assert.equal(requested.body.stream, true);
    assert.equal(requested.body.keep_alive, "1h");
    assert.deepEqual(requested.body.tools, [
      { type: "function", function: { name: "read_page" } }
    ]);
    assert.equal(requested.body.think, "high");
    assert.deepEqual(requested.body.options, {
      temperature: 0.3,
      num_ctx: 4096,
      num_gpu: 10,
      num_predict: 512,
      top_k: 20,
      top_p: 0.8,
      min_p: 0.05,
      repeat_penalty: 1.2,
      repeat_last_n: 32,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      use_mmap: false,
      use_mlock: true,
      num_thread: 6,
      num_batch: 64,
      num_keep: 8,
      seed: 42,
      flash_attn: true,
      kv_cache_type: "q8_0",
      stop: ["END", "STOP"]
    });

    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.deepEqual(reasoning, ["considering"]);
    assert.equal(result.mode, "native");
    assert.equal(result.content, "Hello");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.toolCalls.map((call) => call.name), ["read_page"]);
    assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
      filter: "interactive"
    });
    assert.deepEqual(result.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat uses Ollama OpenAI mode without an API key", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requested = null;
  let sent = false;
  const chunk = encoder.encode(
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  );

  globalThis.fetch = async (url, options) => {
    requested = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: chunk };
          },
          releaseLock: () => {}
        })
      }
    };
  };

  try {
    const result = await streamChat({
      settings: {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "llama3.2",
        temperature: 0,
        maxTokens: 64,
        toolMode: "prompt",
        ollama: { apiMode: "openai" }
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      forcePrompt: true
    });

    assert.equal(requested.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(requested.options.headers.Authorization, undefined);
    assert.equal(result.content, "OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat falls back from Ollama native tools to prompt tools", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const requests = [];
  const fallback = [
    {
      message: {
        content:
          'I will look.\n<tool_call>{"name":"read_page","arguments":{"filter":"interactive"}}</tool_call>'
      }
    },
    { message: { content: "" }, done: true, done_reason: "stop" }
  ].map((entry) => encoder.encode(`${JSON.stringify(entry)}\n`));

  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "tools are not supported by this model" })
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            fallback.length ? { done: false, value: fallback.shift() } : { done: true },
          releaseLock: () => {}
        })
      }
    };
  };

  try {
    const result = await streamChat({
      settings: {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
        model: "llama3.2",
        temperature: 0,
        maxTokens: 64,
        toolMode: "auto",
        ollama: { apiMode: "native" }
      },
      messages: [
        { role: "system", content: "You are Beryy." },
        { role: "user", content: "hello" }
      ],
      tools: [{ type: "function", function: { name: "read_page" } }]
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.tools.length, 1);
    assert.equal(requests[1].body.tools, undefined);
    assert.match(requests[1].body.messages[0].content, /TOOL CALL FORMAT/);
    assert.equal(result.mode, "prompt");
    assert.equal(result.content, "I will look.");
    assert.deepEqual(result.toolCalls.map((call) => call.name), ["read_page"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat explains when Ollama cannot be reached", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  try {
    await assert.rejects(
      streamChat({
        settings: {
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
          model: "llama3.2",
          temperature: 0,
          maxTokens: 64,
          toolMode: "prompt",
          ollama: { apiMode: "native" }
        },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      /check the base URL/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat explains an Ollama origin rejection", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => "Forbidden"
  });

  try {
    await assert.rejects(
      streamChat({
        settings: {
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
          model: "llama3.2",
          temperature: 0,
          maxTokens: 64,
          toolMode: "prompt",
          ollama: { apiMode: "native" }
        },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      (error) => {
        assert.match(error.message, /Reload Beryy/);
        assert.match(error.message, /rewritten automatically/);
        assert.match(error.message, /OLLAMA_ORIGINS/);
        assert.match(error.message, /secured proxy/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat uses NVIDIA request timeout from settings", async () => {
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
        settings: {
          provider: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "nv-key",
          model: "meta/llama-3.3-70b-instruct",
          temperature: 0,
          maxTokens: 64,
          toolMode: "prompt",
          nvidiaRequestTimeoutMs: 10
        },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      (error) => {
        assert.equal(error instanceof ProviderTimeoutError, true);
        assert.match(error.message, /NVIDIA did not start responding/);
        assert.match(error.message, /request timeout/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat uses Ollama request timeout from settings", async () => {
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
        settings: {
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
          model: "llama3.2",
          temperature: 0,
          maxTokens: 64,
          toolMode: "prompt",
          ollama: { apiMode: "native", requestTimeoutMs: 10, idleTimeoutMs: 1000 }
        },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        forcePrompt: true
      }),
      (error) => {
        assert.equal(error instanceof ProviderTimeoutError, true);
        assert.match(error.message, /Ollama did not start responding/);
        assert.match(error.message, /Request timeout/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
