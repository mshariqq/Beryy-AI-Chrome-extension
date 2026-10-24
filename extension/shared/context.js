export const COMPACTION_THRESHOLD = 0.85;
export const DEFAULT_CONTEXT_WINDOW = 128000;

const MODEL_CONTEXT_WINDOWS = Object.freeze([
  [/gemma-4-(?:12b|26b|31b)/i, 256000],
  [/gemma-4-(?:e2b|e4b)/i, 128000],
  [/gemma-[23]/i, 128000],
  [/gemini-(?:2\.5|3)/i, 1048576],
  [/gpt-4\.1/i, 1047576],
  [/gpt-4o/i, 128000],
  [/llama-3\.[123]/i, 128000],
  [/llama-4/i, 128000],
  [/claude/i, 200000]
]);

export function contextWindowFor(model) {
  const id = String(model || "");
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(id)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function estimateTextTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  return Math.ceil(text.length / 3.5);
}

function estimateContentTokens(content) {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;

  let tokens = 0;
  for (const part of content) {
    if (part?.type === "text") {
      tokens += estimateTextTokens(part.text);
    } else if (part?.type === "image_url") {
      tokens += 1200;
    }
  }
  return tokens;
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;

  let tokens = 4;
  tokens += estimateContentTokens(message.content);

  const calls = message.tool_calls || message.toolCalls;
  if (Array.isArray(calls) && calls.length) {
    tokens += estimateTextTokens(JSON.stringify(calls));
  }
  if (message.tool_call_id) tokens += 4;
  if (message.name) tokens += estimateTextTokens(message.name);

  return tokens;
}

export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function contextUsage(messages, contextWindow) {
  if (!contextWindow || contextWindow <= 0) return 0;
  return estimateMessagesTokens(messages) / contextWindow;
}

export function shouldCompact(
  messages,
  contextWindow,
  threshold = COMPACTION_THRESHOLD
) {
  return contextUsage(messages, contextWindow) >= threshold;
}
