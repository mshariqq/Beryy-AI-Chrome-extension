const INDEX_KEY = "beryConversationIndex";
const ACTIVE_KEY = "beryActiveConversation";
const KEY_PREFIX = "beryConversation:";
const MAX_CONVERSATIONS = 10;
const MAX_TRANSCRIPT_ENTRIES = 300;
const MAX_HISTORY_MESSAGES = 300;
const MAX_CONVERSATION_CHARS = 600000;
const MAX_TEXT = 100000;
const MAX_TOOL_OUTPUT = 30000;

let saveChain = Promise.resolve();

function enqueue(task) {
  const next = saveChain.then(task, task);
  saveChain = next.catch(() => {});
  return next;
}

function local() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) throw new Error("Chat storage is unavailable.");
  return storage;
}

function conversationKey(id) {
  return `${KEY_PREFIX}${id}`;
}

function clampText(value, limit = MAX_TEXT) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

function jsonArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function historyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts = [];
  for (const part of content) {
    if (part?.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part?.type === "image_url") {
      parts.push({ type: "text", text: "[image omitted from saved history]" });
    }
  }
  return parts.length ? parts : "[image omitted from saved history]";
}

function pruneHistory(history) {
  const output = [];

  for (const item of history) {
    if (item.role === "tool") {
      let known = false;
      for (let index = output.length - 1; index >= 0; index -= 1) {
        if (output[index].role !== "assistant") continue;
        known = Boolean(
          output[index].toolCalls?.some((call) => call.id === item.callId)
        );
        break;
      }
      if (!known) continue;
    }

    output.push(item);
  }

  return output;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const output = [];

  for (const item of history) {
    if (!item || typeof item !== "object") continue;

    if (item.role === "system") {
      output.push({ role: "system", content: clampText(item.content) });
      continue;
    }

    if (item.role === "user") {
      output.push({ role: "user", content: historyContent(item.content) });
      continue;
    }

    if (item.role === "assistant") {
      output.push({
        role: "assistant",
        content: clampText(item.content),
        rawContent: item.rawContent ? clampText(item.rawContent) : "",
        toolCalls: Array.isArray(item.toolCalls)
          ? item.toolCalls
              .filter((call) => call && typeof call === "object" && call.name)
              .map((call) => ({
                id: String(call.id ?? ""),
                name: String(call.name),
                arguments: String(call.arguments ?? "{}")
              }))
          : []
      });
      continue;
    }

    if (item.role === "tool" && item.callId) {
      output.push({
        role: "tool",
        callId: String(item.callId),
        name: String(item.name ?? ""),
        content: clampText(item.content, MAX_TOOL_OUTPUT)
      });
    }
  }

  return pruneHistory(output.slice(-MAX_HISTORY_MESSAGES));
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  const output = [];

  for (const entry of transcript) {
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "user") {
      const text = clampText(entry.text);
      if (text) output.push({ type: "user", text });
      continue;
    }

    if (entry.type === "assistant") {
      const text = clampText(entry.text);
      if (text) output.push({ type: "assistant", text });
      continue;
    }

    if (entry.type === "tool") {
      const status =
        entry.status === "done" || entry.status === "failed"
          ? entry.status
          : "failed";
      const interrupted = entry.status === "running";
      output.push({
        type: "tool",
        callId: String(entry.callId ?? ""),
        tool: String(entry.tool ?? ""),
        args: jsonArgs(entry.args),
        status,
        output: clampText(entry.output, MAX_TOOL_OUTPUT),
        error: interrupted
          ? "Interrupted when the side panel closed."
          : clampText(entry.error, MAX_TOOL_OUTPUT)
      });
      continue;
    }

    if (entry.type === "notice") {
      const text = clampText(entry.text, 5000);
      if (text) output.push({ type: "notice", text, kind: String(entry.kind ?? "") });
    }
  }

  return output.slice(-MAX_TRANSCRIPT_ENTRIES);
}

export function conversationTitle(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 64 ? `${clean.slice(0, 61)}...` : clean;
}

export function newConversationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createConversation({ id = newConversationId(), now = Date.now() } = {}) {
  return {
    version: 1,
    id,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    transcript: [],
    agent: {
      history: [],
      toolNames: [],
      promptMode: false,
      model: "",
      toolMode: ""
    }
  };
}

export function normalizeConversation(input) {
  const base = createConversation({
    id: String(input?.id || newConversationId()),
    now: Number(input?.createdAt) || Date.now()
  });
  const transcript = normalizeTranscript(input?.transcript);
  const firstUser = transcript.find((entry) => entry.type === "user");
  const title =
    input?.title && String(input.title).trim() && String(input.title) !== "New chat"
      ? clampText(input.title, 120)
      : conversationTitle(firstUser?.text);
  const state = input?.agent || {};
  const conversation = {
    ...base,
    title,
    updatedAt: Number(input?.updatedAt) || Date.now(),
    transcript,
    agent: {
      history: normalizeHistory(state.history),
      toolNames: Array.isArray(state.toolNames)
        ? state.toolNames
            .filter((entry) => Array.isArray(entry) && entry[0] && entry[1])
            .map(([callId, name]) => [String(callId), String(name)])
            .slice(-MAX_HISTORY_MESSAGES)
        : [],
      promptMode: Boolean(state.promptMode),
      model: String(state.model ?? ""),
      toolMode: String(state.toolMode ?? "")
    }
  };

  while (conversation.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    conversation.transcript.shift();
  }
  while (conversation.agent.history.length > MAX_HISTORY_MESSAGES) {
    conversation.agent.history.shift();
  }

  let size = JSON.stringify(conversation).length;
  while (
    size > MAX_CONVERSATION_CHARS &&
    (conversation.transcript.length > 1 || conversation.agent.history.length > 1)
  ) {
    if (conversation.transcript.length > 1) {
      conversation.transcript.splice(0, Math.min(5, conversation.transcript.length - 1));
    }
    if (conversation.agent.history.length > 1) {
      conversation.agent.history.splice(
        0,
        Math.min(5, conversation.agent.history.length - 1)
      );
    }
    size = JSON.stringify(conversation).length;
  }

  conversation.agent.history = pruneHistory(conversation.agent.history);
  return conversation;
}

export function summarizeConversation(conversation) {
  const firstUser = conversation.transcript.find((entry) => entry.type === "user");
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.transcript.filter((entry) => entry.type === "user").length,
    preview: clampText(firstUser?.text ?? "", 120)
  };
}

function normalizeIndex(index) {
  if (!Array.isArray(index)) return [];
  return index
    .filter((entry) => entry && typeof entry === "object" && entry.id)
    .map((entry) => ({
      id: String(entry.id),
      title: String(entry.title || "New chat"),
      createdAt: Number(entry.createdAt) || 0,
      updatedAt: Number(entry.updatedAt) || 0,
      messageCount: Number(entry.messageCount) || 0,
      preview: String(entry.preview || "")
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

async function readIndex() {
  const stored = await local().get(INDEX_KEY);
  return normalizeIndex(stored?.[INDEX_KEY]);
}

async function writeConversation(conversation) {
  const index = await readIndex();
  const nextIndex = normalizeIndex([
    summarizeConversation(conversation),
    ...index.filter((entry) => entry.id !== conversation.id)
  ]);
  const keep = new Set(nextIndex.map((entry) => entry.id));
  const stale = index
    .filter((entry) => !keep.has(entry.id))
    .map((entry) => conversationKey(entry.id));

  await local().set({
    [conversationKey(conversation.id)]: conversation,
    [INDEX_KEY]: nextIndex,
    [ACTIVE_KEY]: conversation.id
  });

  if (stale.length) await local().remove(stale);
}

export function saveConversation(conversation) {
  const snapshot = normalizeConversation(conversation);
  return enqueue(() => writeConversation(snapshot));
}

export async function loadConversation(id) {
  if (!id) return null;
  const key = conversationKey(id);
  const stored = await local().get(key);
  return stored?.[key] ? normalizeConversation(stored[key]) : null;
}

export async function loadActiveConversation() {
  const stored = await local().get([ACTIVE_KEY, INDEX_KEY]);
  const index = normalizeIndex(stored?.[INDEX_KEY]);
  const activeId =
    typeof stored?.[ACTIVE_KEY] === "string" ? stored[ACTIVE_KEY] : "";

  if (activeId) {
    const active = await loadConversation(activeId);
    return active || createConversation({ id: activeId });
  }

  if (index.length) {
    const latest = await loadConversation(index[0].id);
    if (latest) return latest;
  }

  return null;
}

export async function listConversations() {
  return readIndex();
}

export function setActiveConversation(id) {
  return enqueue(async () => {
    if (id) await local().set({ [ACTIVE_KEY]: String(id) });
    else await local().remove(ACTIVE_KEY);
  });
}

export function deleteConversation(id) {
  return enqueue(async () => {
    await local().remove(conversationKey(id));
    const index = await readIndex();
    const nextIndex = index.filter((entry) => entry.id !== id);
    await local().set({ [INDEX_KEY]: nextIndex });
    const stored = await local().get(ACTIVE_KEY);
    if (stored?.[ACTIVE_KEY] === id) await local().remove(ACTIVE_KEY);
  });
}
