import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationTitle,
  createConversation,
  deleteConversation,
  listConversations,
  loadActiveConversation,
  loadConversation,
  normalizeConversation,
  saveConversation,
  setActiveConversation
} from "../extension/sidepanel/conversations.js";

function installStorage() {
  const store = new Map();

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) {
            return Object.fromEntries(
              [...store.entries()].map(([key, value]) => [key, structuredClone(value)])
            );
          }

          const list = Array.isArray(keys) ? keys : [keys];
          const output = {};
          for (const key of list) {
            if (store.has(key)) output[key] = structuredClone(store.get(key));
          }
          return output;
        },

        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            store.set(key, structuredClone(value));
          }
        },

        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        }
      }
    }
  };

  return store;
}

test("conversation titles come from the first user message", () => {
  assert.equal(conversationTitle("  Plan   my   trip  "), "Plan my trip");
  assert.equal(conversationTitle(""), "New chat");
  assert.equal(conversationTitle("x".repeat(100)).length, 64);
});

test("normalizeConversation strips images and repairs interrupted tools", () => {
  const conversation = createConversation({ id: "chat_1", now: 1000 });
  conversation.transcript = [
    { type: "user", text: "Take a look" },
    { type: "assistant", text: "Looking." },
    {
      type: "tool",
      callId: "call_1",
      tool: "computer",
      args: { action: "screenshot" },
      status: "running",
      output: "",
      error: ""
    }
  ];
  conversation.agent.history = [
    {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,secret" }
        }
      ]
    },
    {
      role: "assistant",
      content: "I see it.",
      toolCalls: [{ id: "call_1", name: "computer", arguments: "{}" }]
    },
    { role: "tool", callId: "call_1", name: "computer", content: "ok" }
  ];

  const normalized = normalizeConversation(conversation);

  assert.equal(normalized.title, "Take a look");
  assert.deepEqual(normalized.agent.history[0].content, [
    { type: "text", text: "Look at this" },
    { type: "text", text: "[image omitted from saved history]" }
  ]);
  assert.equal(normalized.transcript[2].status, "failed");
  assert.match(normalized.transcript[2].error, /Interrupted/);
});

test("normalizeConversation drops orphaned tool results", () => {
  const conversation = createConversation({ id: "chat_1" });
  conversation.agent.history = [
    { role: "tool", callId: "orphan", name: "navigate", content: "stale" },
    { role: "user", content: "Open the page" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "navigate", arguments: "{}" }]
    },
    { role: "tool", callId: "call_1", name: "navigate", content: "opened" }
  ];

  const normalized = normalizeConversation(conversation);
  assert.deepEqual(
    normalized.agent.history.map((item) => item.role),
    ["user", "assistant", "tool"]
  );
  assert.equal(normalized.agent.history[2].callId, "call_1");
});

test("saves, lists, loads, and restores the active conversation", async () => {
  installStorage();

  const conversation = createConversation({ id: "chat_1", now: 1000 });
  conversation.transcript = [
    { type: "user", text: "First question" },
    { type: "assistant", text: "First answer" }
  ];
  conversation.updatedAt = 2000;

  await saveConversation(conversation);

  const list = await listConversations();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "chat_1");
  assert.equal(list[0].title, "First question");
  assert.equal(list[0].messageCount, 1);

  const loaded = await loadConversation("chat_1");
  assert.deepEqual(loaded.transcript, conversation.transcript);
  assert.equal((await loadActiveConversation()).id, "chat_1");
});

test("keeps only the newest conversations", async () => {
  const store = installStorage();

  for (let index = 1; index <= 11; index += 1) {
    const conversation = createConversation({ id: `chat_${index}`, now: index });
    conversation.transcript = [{ type: "user", text: `Question ${index}` }];
    conversation.updatedAt = index;
    await saveConversation(conversation);
  }

  const list = await listConversations();
  assert.equal(list.length, 10);
  assert.equal(list[0].id, "chat_11");
  assert.equal(store.has("beryConversation:chat_1"), false);
  assert.equal(store.has("beryConversation:chat_11"), true);
});

test("deleting the active chat clears the active pointer", async () => {
  installStorage();

  const conversation = createConversation({ id: "chat_1" });
  conversation.transcript = [{ type: "user", text: "Delete me" }];
  await saveConversation(conversation);
  await deleteConversation("chat_1");

  assert.equal(await loadConversation("chat_1"), null);
  assert.deepEqual(await listConversations(), []);
  assert.equal(await loadActiveConversation(), null);
});

test("an unsaved active chat restores as an empty conversation", async () => {
  installStorage();
  await setActiveConversation("blank_chat");

  const conversation = await loadActiveConversation();
  assert.equal(conversation.id, "blank_chat");
  assert.equal(conversation.title, "New chat");
  assert.deepEqual(conversation.transcript, []);
});

test("falls back to the latest saved chat when no active id exists", async () => {
  installStorage();

  const older = createConversation({ id: "older", now: 1 });
  older.transcript = [{ type: "user", text: "Older" }];
  older.updatedAt = 2;
  const newer = createConversation({ id: "newer", now: 3 });
  newer.transcript = [{ type: "user", text: "Newer" }];
  newer.updatedAt = 4;

  await saveConversation(older);
  await saveConversation(newer);
  await setActiveConversation("");

  const conversation = await loadActiveConversation();
  assert.equal(conversation.id, "newer");
});
