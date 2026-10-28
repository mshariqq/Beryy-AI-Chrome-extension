import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../extension/sidepanel/agent.js";

function settings(overrides = {}) {
  return {
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "model-a",
    temperature: 0.2,
    maxTokens: 256,
    maxSteps: 1,
    toolMode: "auto",
    vision: false,
    permissionMode: "ask",
    blockedDomains: [],
    trustedDomains: [],
    systemPromptExtra: "",
    ...overrides
  };
}

function promptResult() {
  return {
    content: "ok",
    rawContent: "ok",
    toolCalls: [],
    finishReason: "stop",
    mode: "prompt"
  };
}

test("prompt fallback is forced for later turns in the same chat", async () => {
  const calls = [];
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {},
    stream: async (options) => {
      calls.push(options);
      return promptResult();
    }
  });

  await agent.run("first", { tabs: [] });
  await agent.run("second", { tabs: [] });

  assert.equal(calls[0].forcePrompt, false);
  assert.equal(calls[1].forcePrompt, true);
});

test("changing model or tool mode clears an automatic prompt fallback", () => {
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  agent.promptMode = true;
  agent.updateSettings(settings({ model: "model-b" }));
  assert.equal(agent.promptMode, false);

  agent.promptMode = true;
  agent.updateSettings(settings({ model: "model-b", toolMode: "prompt" }));
  assert.equal(agent.promptMode, true);

  agent.promptMode = true;
  agent.updateSettings(settings({ model: "model-b", toolMode: "prompt", temperature: 0.7 }));
  assert.equal(agent.promptMode, true);

  agent.promptMode = true;
  agent.updateSettings(settings({ model: "model-b", provider: "google" }));
  assert.equal(agent.promptMode, false);
});

test("new chats reset automatic prompt fallback", () => {
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  agent.promptMode = true;
  agent.reset();
  assert.equal(agent.promptMode, false);
});

test("agent context round-trips through saved state", () => {
  const first = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });
  first.history = [
    { role: "user", content: "Open the page" },
    {
      role: "assistant",
      content: "On it.",
      rawContent: "On it.",
      toolCalls: [{ id: "call_1", name: "navigate", arguments: '{"url":"https://example.com"}' }]
    },
    { role: "tool", callId: "call_1", name: "navigate", content: "Opened" }
  ];
  first.toolNames.set("call_1", "navigate");
  first.promptMode = true;

  const second = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });
  second.loadState(first.getState());

  assert.deepEqual(second.history, first.history);
  assert.equal(second.toolNames.get("call_1"), "navigate");
  assert.equal(second.promptMode, true);
  assert.equal(second.buildMessages({ tabs: [] }).length, 4);
});

test("saved agent state omits screenshot data", () => {
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });
  agent.history = [
    {
      role: "user",
      content: [
        { type: "text", text: "Here is the screenshot" },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,secret" }
        }
      ]
    }
  ];

  const state = agent.getState();
  assert.deepEqual(state.history[0].content, [
    { type: "text", text: "Here is the screenshot" },
    { type: "text", text: "[image omitted from saved history]" }
  ]);
});

test("restoring an interrupted tool call adds a synthetic result", () => {
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  agent.loadState({
    history: [
      { role: "user", content: "Open the page" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "navigate", arguments: '{"url":"https://example.com"}' }
        ]
      }
    ],
    toolNames: [["call_1", "navigate"]],
    promptMode: false,
    model: "model-a",
    toolMode: "auto"
  });

  assert.equal(agent.history.length, 3);
  assert.equal(agent.history[2].role, "tool");
  assert.equal(agent.history[2].callId, "call_1");
  assert.match(agent.history[2].content, /interrupted/);
});

test("restored prompt fallback is dropped when the model changes", () => {
  const agent = new Agent({
    settings: settings({ model: "model-b" }),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  agent.loadState({
    history: [],
    toolNames: [],
    promptMode: true,
    model: "model-a",
    toolMode: "auto"
  });

  assert.equal(agent.promptMode, false);
});

function screenshotCall() {
  return {
    content: "Captured screenshot",
    toolCalls: [
      { id: "call_shot", name: "computer", arguments: '{"action":"screenshot"}' }
    ],
    finishReason: "tool_calls",
    mode: "native"
  };
}

function finalAnswer() {
  return {
    content: "Done.",
    toolCalls: [],
    finishReason: "stop",
    mode: "native"
  };
}

function screenshotResult() {
  return {
    content: [
      { type: "text", text: "Captured screenshot" },
      { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/jpeg" }
    ]
  };
}

test("screenshots are not sent to text-only models", async () => {
  const calls = [];
  const events = [];
  const agent = new Agent({
    settings: settings({
      vision: true,
      model: "meta/llama-3.3-70b-instruct",
      maxSteps: 2
    }),
    execute: async () => screenshotResult(),
    onEvent: (event) => events.push(event),
    stream: async (options) => {
      calls.push(options);
      return calls.length === 1 ? screenshotCall() : finalAnswer();
    }
  });

  await agent.run("Take a screenshot", { tabs: [] });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url")
    ),
    false
  );
  assert.equal(
    agent.history.some(
      (item) =>
        Array.isArray(item.content) &&
        item.content.some((part) => part.type === "image_url")
    ),
    false
  );
  assert.ok(events.some((event) => /is a text-only model/.test(event.text || "")));
});

test("screenshots are sent when vision support is unknown", async () => {
  const calls = [];
  const agent = new Agent({
    settings: settings({
      vision: true,
      model: "unknown-model-xyz",
      maxSteps: 2
    }),
    execute: async () => screenshotResult(),
    onEvent: () => {},
    stream: async (options) => {
      calls.push(options);
      return calls.length === 1 ? screenshotCall() : finalAnswer();
    }
  });

  await agent.run("Take a screenshot", { tabs: [] });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url")
    ),
    true
  );
});

test("old screenshots are pruned from live history", () => {
  const agent = new Agent({
    settings: settings({ vision: true, model: "meta/llama-3.2-90b-vision-instruct" }),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  const imageMessage = (id) => ({
    role: "user",
    content: [
      { type: "text", text: `screenshot ${id}` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${id}` } }
    ]
  });
  agent.history = [imageMessage("one"), imageMessage("two"), imageMessage("three")];

  agent.pruneImages(1);

  const images = agent.history
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url.url, "data:image/jpeg;base64,three");
  assert.equal(agent.history[0].content[1].text, "[older screenshot omitted]");
  assert.equal(agent.history[1].content[1].text, "[older screenshot omitted]");
});

test("compactHistory shortens old tool output but keeps recent results", () => {
  const agent = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });
  const long = "x".repeat(20000);
  agent.history = [
    { role: "user", content: "old task" },
    { role: "assistant", content: "old answer", toolCalls: [] },
    { role: "tool", callId: "a", name: "read_page", content: long },
    { role: "tool", callId: "b", name: "read_page", content: long },
    { role: "tool", callId: "c", name: "read_page", content: long },
    { role: "user", content: "hi" }
  ];

  const changed = agent.compactHistory();

  assert.ok(changed > 0);
  assert.match(agent.history[2].content, /trimmed to fit the model context window/);
  assert.equal(agent.history[3].content, long);
  assert.equal(agent.history[4].content, long);
  assert.equal(agent.history[5].content, "hi");
});

test("agent summarizes history when context reaches 85 percent", async () => {
  const calls = [];
  const events = [];
  const agent = new Agent({
    settings: settings({ maxSteps: 1 }),
    contextWindow: 3000,
    execute: async () => ({ content: [] }),
    onEvent: (event) => events.push(event),
    stream: async (options) => {
      calls.push(options);
      if (options.tools.length === 0) {
        return {
          content: "COMPACT SUMMARY",
          rawContent: "COMPACT SUMMARY",
          toolCalls: [],
          finishReason: "stop",
          mode: "prompt"
        };
      }
      return finalAnswer();
    }
  });
  agent.history = [
    { role: "user", content: "old task" },
    { role: "assistant", content: "old answer", toolCalls: [] },
    { role: "user", content: "current task" },
    { role: "assistant", content: "x".repeat(20000), toolCalls: [] }
  ];

  await agent.run("go", { tabs: [] });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools.length, 0);
  assert.equal(calls[0].settings.toolMode, "prompt");
  assert.match(calls[0].messages.at(-1).content, /Write the summary now/);
  assert.equal(calls[1].messages[0].role, "system");
  assert.match(calls[1].messages[0].content, /Conversation summary/);
  assert.match(calls[1].messages[0].content, /COMPACT SUMMARY/);
  assert.ok(agent.history[0].content.startsWith("[Conversation summary"));
  assert.ok(events.some((event) => event.type === "compression_start"));
  assert.ok(events.some((event) => event.type === "compression_done"));
  assert.ok(events.some((event) => event.type === "notice" && /85%/.test(event.text)));
});

test("compression keeps the previous summary in saved state and later summaries", async () => {
  const calls = [];
  const agent = new Agent({
    settings: settings(),
    contextWindow: 3000,
    execute: async () => ({ content: [] }),
    onEvent: () => {},
    stream: async (options) => {
      calls.push(options);
      return {
        content: "NEW SUMMARY",
        rawContent: "NEW SUMMARY",
        toolCalls: [],
        finishReason: "stop",
        mode: "prompt"
      };
    }
  });
  agent.history = [
    { role: "system", content: "[Conversation summary] OLD SUMMARY" }
  ];
  for (let index = 0; index < 6; index += 1) {
    agent.history.push({ role: "user", content: `task ${index}` });
    agent.history.push({
      role: "assistant",
      content: "x".repeat(1000),
      toolCalls: []
    });
  }

  const state = agent.getState();
  assert.equal(state.history[0].role, "system");
  assert.match(state.history[0].content, /OLD SUMMARY/);

  const restored = new Agent({
    settings: settings(),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });
  restored.loadState(state);
  assert.match(restored.history[0].content, /OLD SUMMARY/);
  assert.match(restored.buildMessages({ tabs: [] })[0].content, /OLD SUMMARY/);

  const changed = await agent.compressHistory({
    signal: new AbortController().signal
  });

  assert.equal(changed, true);
  assert.match(calls[0].messages.at(-1).content, /OLD SUMMARY/);
  assert.match(agent.buildMessages({ tabs: [] })[0].content, /NEW SUMMARY/);
});

test("agent compacts when the provider reports 85 percent usage", async () => {
  const calls = [];
  const agent = new Agent({
    settings: settings({ maxSteps: 1 }),
    contextWindow: 3000,
    execute: async () => ({ content: [] }),
    onEvent: () => {},
    stream: async (options) => {
      calls.push(options);
      return promptResult();
    }
  });
  agent.history = [];
  for (let index = 0; index < 6; index += 1) {
    agent.history.push({ role: "user", content: `task ${index}` });
    agent.history.push({
      role: "assistant",
      content: "x".repeat(1000),
      toolCalls: []
    });
  }
  agent.lastPromptTokens = 2600;

  const changed = await agent.maybeCompress(
    { tabs: [] },
    new AbortController().signal
  );

  assert.equal(changed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.toolMode, "prompt");
  assert.ok(agent.history[0].content.startsWith("[Conversation summary"));
  assert.equal(agent.lastPromptTokens, 0);
});

test("context usage reports calibrated estimates and actual provider usage", async () => {
  const events = [];
  const agent = new Agent({
    settings: settings({ maxSteps: 1 }),
    contextWindow: 10000,
    execute: async () => ({ content: [] }),
    onEvent: (event) => events.push(event),
    stream: async () => ({
      content: "ok",
      rawContent: "ok",
      toolCalls: [],
      finishReason: "stop",
      mode: "prompt",
      usage: { prompt_tokens: 9000 }
    })
  });
  agent.tokenCalibration = 1.5;

  await agent.run("hello", { tabs: [] });

  const usage = events.filter((event) => event.type === "context_usage");
  assert.equal(usage.length, 2);
  assert.equal(usage[0].estimated, Math.round(agent.lastRequestEstimate * 1.5));
  assert.equal(usage[0].percent, Math.round((usage[0].estimated / 10000) * 100));
  assert.equal(usage[1].actual, true);
  assert.equal(usage[1].estimated, 9000);
  assert.equal(usage[1].percent, 90);
});

test("context-length errors compact history and retry once", async () => {
  const calls = [];
  const events = [];
  const agent = new Agent({
    settings: settings({ maxSteps: 2 }),
    execute: async () => ({ content: [] }),
    onEvent: (event) => events.push(event),
    stream: async (options) => {
      calls.push(options);
      if (options.tools.length === 0) {
        throw new Error("summary service unavailable");
      }
      if (calls.length === 1) {
        const error = new Error(
          "This model's maximum context length is 65536 tokens. However, your messages resulted in 68639 tokens. Please reduce the length of the messages."
        );
        error.status = 400;
        error.body = error.message;
        throw error;
      }
      return finalAnswer();
    }
  });
  agent.history = [
    { role: "user", content: "old task" },
    { role: "assistant", content: "old answer", toolCalls: [] },
    {
      role: "tool",
      callId: "a",
      name: "read_page",
      content: "x".repeat(50000)
    },
    {
      role: "tool",
      callId: "b",
      name: "read_page",
      content: "y".repeat(50000)
    },
    {
      role: "tool",
      callId: "c",
      name: "read_page",
      content: "z".repeat(50000)
    }
  ];

  await agent.run("hi", { tabs: [] });

  assert.equal(calls.length, 3);
  assert.ok(events.some((event) => event.type === "compression_failed"));
  assert.match(
    events.find((event) => event.type === "notice")?.text || "",
    /exceeded the model's context window/
  );
  assert.match(agent.history[2].content, /trimmed to fit the model context window/);
});

test("agent context limit is capped by Ollama num_ctx", () => {
  const agent = new Agent({
    settings: settings({
      provider: "ollama",
      model: "llama3.2",
      ollama: { numCtx: 4096 }
    }),
    execute: async () => ({ content: [] }),
    onEvent: () => {}
  });

  assert.equal(agent.contextLimit(), 4096);

  agent.updateSettings(
    settings({
      provider: "nvidia",
      model: "llama3.2",
      ollama: { numCtx: 4096 }
    })
  );
  assert.equal(agent.contextLimit(), 128000);
});
