import { createSSEParser, isDoneEvent, parseJSONEvent } from "../shared/sse.js";
import {
  abortableSleep,
  acquireNvidiaRateLimit,
  acquireProviderRateLimit
} from "../shared/rate-limit.js";
import {
  estimateMessagesTokens,
  estimateTextTokens
} from "../shared/context.js";
import {
  chatCompletionsUrl,
  modelListUrl,
  ollamaRootUrl
} from "../shared/providers.js";
import { buildPromptToolSpec } from "../shared/tools.js";

export const REQUEST_TIMEOUT_MS = 60000;
export const STREAM_IDLE_MS = 90000;
export const GOOGLE_REQUEST_TIMEOUT_MS = 180000;
export const GOOGLE_STREAM_IDLE_MS = 120000;

const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_TRANSIENT_RETRIES = 6;
const MAX_RETRY_WAIT_MS = 120000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  constructor(message, { status = 0, body = "", retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

function maxRetriesFor(status) {
  return status === 429 ? MAX_RATE_LIMIT_RETRIES : MAX_TRANSIENT_RETRIES;
}

function parseRetryAfter(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.ceil(Number(text) * 1000);
  }

  const timestamp = Date.parse(text);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return 0;
}

function parseDurationMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.ceil(Number(text) * 1000);
  }

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "ms" ? 1 : 1000;
    total += amount * multiplier;
  }
  return matched ? Math.ceil(total) : 0;
}

function responseRetryAfterMs(response) {
  const headers = response?.headers;
  if (typeof headers?.get !== "function") return 0;

  const direct = parseRetryAfter(headers.get("retry-after"));
  if (direct > 0) return direct;

  for (const name of [
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset"
  ]) {
    const parsed = parseDurationMs(headers.get(name));
    if (parsed > 0) return parsed;
  }
  return 0;
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

function errorMessage(body, fallback) {
  try {
    const parsed = JSON.parse(body);
    return (
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.detail ||
      parsed?.message ||
      fallback
    );
  } catch {
    return body || fallback;
  }
}

function providerErrorMessage(status, body, settings = {}) {
  const fallback = `Request failed (${status}).`;
  const message = errorMessage(body, fallback);
  const provider = settings.provider || "";

  if (provider === "ollama") {
    if (status === 404) {
      return `Ollama could not find model "${settings.model}". Install it first with: ollama pull ${settings.model}`;
    }
    if (status === 401) {
      return `${message} If you are using a secured Ollama proxy, check its API key.`;
    }
    if (status === 403) {
      return `${message} Ollama rejected this origin. For local Ollama, add this extension's origin to OLLAMA_ORIGINS (or use * for local use) and restart Ollama. If you use a secured proxy, check its API key.`;
    }
    if (status === 400 && /tool/i.test(body)) {
      return `${message} This Ollama model may not support native tools. Set Tool calling to Prompt format or choose a tool-capable model.`;
    }
    if (status >= 500 && /load|memory|gpu|context/i.test(body)) {
      return `${message} Reduce num_ctx or GPU layers, or check the Ollama server log.`;
    }
  }

  if (status === 402 && provider === "openrouter") {
    return "OpenRouter rejected the request for insufficient credits. Add credits or choose a free model.";
  }
  if (
    status === 404 &&
    provider === "openrouter" &&
    /data policy|free model publication/i.test(body)
  ) {
    return "OpenRouter blocked this free model under your privacy settings. Allow free-model publication in OpenRouter privacy settings, or choose another model.";
  }
  if (status === 404 && /Function .*Not found for account/i.test(body)) {
    return "This model is listed by the provider, but it is not available for your account. Choose another model or request access from the provider.";
  }
  if (status === 404 && /page not found/i.test(body)) {
    return "The provider could not find this model. Check the model ID and base URL.";
  }
  if (status === 410) {
    return "This model has been retired by the provider. Choose another model.";
  }
  if (status === 401 || status === 403) {
    return `${message} Check that your API key is valid and has access to this model.`;
  }
  if (status === 429) {
    if (provider === "google") {
      return `${message} Google's free-tier quota may be exhausted. Wait for it to reset or choose a different Google model.`;
    }
    if (provider === "groq") {
      return `${message} Groq's free-tier limit may be exhausted. Wait for the window to reset or choose another Groq model.`;
    }
    if (provider === "openrouter") {
      return `${message} OpenRouter's free-model limit may be exhausted. Wait for the window to reset or add credits.`;
    }
    return `${message} Rate limit reached; wait a moment and retry.`;
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return `${message} The provider is temporarily unavailable. Retrying may help.`;
  }

  return message;
}

function timeoutMessage(settings, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  if (settings.provider === "ollama") {
    return `Ollama did not start responding within ${seconds} seconds. The model may still be loading; increase Request timeout or keep the model loaded with keep_alive.`;
  }
  if (settings.provider === "google") {
    return `Google did not start responding within ${seconds} seconds. Gemma 4 31B can be slow on the free tier; try gemma-4-26b-a4b-it or retry.`;
  }
  return `The provider did not respond within ${seconds} seconds.`;
}

function idleTimeoutMessage(settings, idleTimeoutMs) {
  const seconds = Math.round(idleTimeoutMs / 1000);
  if (settings.provider === "ollama") {
    return `Ollama stopped sending data for ${seconds} seconds. The model may still be loading; increase Stream idle timeout or check the Ollama server memory.`;
  }
  return `The provider stopped sending data for ${seconds} seconds. If this happened after a screenshot, check that Vision is enabled only for a vision-capable model.`;
}

function ollamaFetchError(settings, error) {
  if (error instanceof ProviderError) return error;
  const message = String(error?.message || error);
  if (/failed to fetch|networkerror|load failed|fetch failed|connection refused/i.test(message)) {
    return new ProviderError(
      `Could not reach Ollama at ${ollamaRootUrl(settings?.baseUrl)}. Start it with "ollama serve" and set OLLAMA_ORIGINS to this extension's origin (or * for local use).`
    );
  }
  return new ProviderError(`Ollama request failed: ${message}`);
}

function ollamaHeaders(settings, extra = {}) {
  const headers = { ...extra };
  if (settings?.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function retryDelayMs(error, attempt) {
  if (Number(error?.retryAfterMs) > 0) {
    return Math.min(MAX_RETRY_WAIT_MS, Math.ceil(Number(error.retryAfterMs)) + 250);
  }

  const detail = `${error?.body || ""} ${error?.message || ""}`;
  const retryInfo = detail.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);

  if (retryInfo) {
    return Math.min(MAX_RETRY_WAIT_MS, Math.ceil(Number(retryInfo[1]) * 1000) + 250);
  }
  if (error?.status === 429) {
    return Math.min(60000, 10000 * 2 ** attempt);
  }
  return Math.min(15000, 1000 * 2 ** attempt);
}

async function listOllamaModels(settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(modelListUrl(settings), {
      method: "GET",
      headers: ollamaHeaders(settings, { Accept: "application/json" }),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new ProviderError(
        providerErrorMessage(response.status, raw, settings),
        { status: response.status, body: raw }
      );
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    const ids = items
      .map((item) => (typeof item === "string" ? item : item?.name || item?.model || item?.id))
      .filter(Boolean)
      .map((id) => String(id));

    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError("Loading Ollama models timed out. Is Ollama running?");
    }
    throw ollamaFetchError(settings, error);
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(settings) {
  if (!settings?.apiKey && settings?.provider !== "ollama") {
    throw new ProviderError("Add your API key in settings to load models.");
  }

  if (settings?.provider === "ollama" && settings.ollama?.apiMode !== "openai") {
    return listOllamaModels(settings);
  }

  await acquireNvidiaRateLimit(settings);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(modelListUrl(settings), {
      method: "GET",
      headers: ollamaHeaders(settings, { Accept: "application/json" }),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new ProviderError(
        providerErrorMessage(response.status, raw, settings),
        {
          status: response.status,
          body: raw,
          retryAfterMs: responseRetryAfterMs(response)
        }
      );
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];

    const ids = items
      .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
      .filter(Boolean)
      .map((id) => String(id));

    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError("Loading the model list timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function promptAddendum() {
  return `

TOOL CALL FORMAT (native tool calling is unavailable for this request):
To call a tool, output one block per call, exactly like this:
<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>
Do not wrap the block in markdown fences. You may call several tools in one reply. Wait for the tool results before deciding what to do next.

Available tools:
${buildPromptToolSpec()}`;
}

function withPromptInstructions(messages, add = true) {
  if (!add) return messages;
  return messages.map((message, index) => {
    if (index === 0 && message.role === "system") {
      return { ...message, content: `${message.content}${promptAddendum()}` };
    }
    return message;
  });
}

function promptSafeMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const blocks = message.tool_calls
        .map((call) => {
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {
            args = {};
          }
          return `<tool_call>${JSON.stringify({
            name: call.function?.name,
            arguments: args
          })}</tool_call>`;
        })
        .join("\n");
      output.push({
        role: "assistant",
        content: [message.content, blocks].filter(Boolean).join("\n")
      });
      continue;
    }

    if (message.role === "tool") {
      output.push({
        role: "user",
        content: `Tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ""}:\n${message.content}`
      });
      continue;
    }

    output.push(message);
  }
  return output;
}

function safeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeCall(value, index) {
  if (!value || typeof value !== "object") return null;
  const fn = value.function || value;
  const name = fn.name || value.tool || value.name;
  if (!name) return null;
  const args =
    fn.arguments ?? value.arguments ?? value.args ?? value.parameters ?? {};
  return {
    id: String(value.id || `call_${Date.now()}_${index}`),
    name: String(name),
    arguments: typeof args === "string" ? args : JSON.stringify(args)
  };
}

export function extractToolCalls(text) {
  const calls = [];
  const xml = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;

  while ((match = xml.exec(text))) {
    const parsed = safeJSON(match[1]);
    const call = normalizeCall(parsed, calls.length);
    if (call) calls.push(call);
  }

  let clean = text.replace(xml, "").trim();

  if (calls.length === 0) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    while ((match = fence.exec(clean))) {
      const parsed = safeJSON(match[1]);
      const call = normalizeCall(parsed, calls.length);
      if (call) {
        calls.push(call);
        clean = clean.replace(match[0], "").trim();
      }
    }
  }

  return { text: clean, toolCalls: calls };
}

function appendContent(current, delta) {
  if (typeof delta.content === "string") return current + delta.content;
  if (Array.isArray(delta.content)) {
    let next = current;
    for (const part of delta.content) {
      if (part?.type === "text" && part.text) next += part.text;
    }
    return next;
  }
  return current;
}

async function request({
  settings,
  messages,
  tools,
  signal,
  native,
  onDelta,
  onReasoning,
  onRateLimitWait,
  timeoutMs = REQUEST_TIMEOUT_MS,
  idleTimeoutMs = STREAM_IDLE_MS
}) {
  const body = {
    model: settings.model,
    messages: native
      ? messages
      : withPromptInstructions(
          promptSafeMessages(messages),
          settings.toolMode !== "prompt"
        ),
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: true
  };

  if (native) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const estimatedTokens =
    estimateMessagesTokens(body.messages) +
    estimateTextTokens(JSON.stringify(body.tools || [])) +
    (Number(settings.maxTokens) || 0);

  await acquireProviderRateLimit(settings, {
    onWait: onRateLimitWait,
    signal,
    weight: estimatedTokens
  });

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let headerTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(chatCompletionsUrl(settings), {
      method: "POST",
      headers: ollamaHeaders(settings, {
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      }),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    signal?.removeEventListener("abort", abortFromCaller);
    if (headerTimedOut) {
      throw new ProviderTimeoutError(timeoutMessage(settings, timeoutMs));
    }
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    signal?.removeEventListener("abort", abortFromCaller);
    const raw = await response.text().catch(() => "");
    throw new ProviderError(providerErrorMessage(response.status, raw, settings), {
      status: response.status,
      body: raw,
      retryAfterMs: responseRetryAfterMs(response)
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    signal?.removeEventListener("abort", abortFromCaller);
    throw new ProviderError("The provider returned an empty response body.");
  }

  const readNext = async () => {
    let idleTimer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            controller.abort();
            reject(
              new ProviderTimeoutError(
                idleTimeoutMessage(settings, idleTimeoutMs)
              )
            );
          }, idleTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(idleTimer);
    }
  };

  const decoder = new TextDecoder();
  const parser = createSSEParser();
  const toolMap = new Map();

  let content = "";
  let finishReason = null;
  let usage = null;

  const consume = (events) => {
    for (const event of events) {
      if (isDoneEvent(event)) continue;
      const json = parseJSONEvent(event);
      if (!json) continue;

      if (json.usage) usage = json.usage;

      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || choice.message;
      if (!delta) continue;

      const before = content;
      content = appendContent(content, delta);
      if (native && content.length > before.length) {
        onDelta?.(content.slice(before.length));
      }

      const reasoning = delta.reasoning_content || delta.reasoning;
      if (typeof reasoning === "string" && reasoning) onReasoning?.(reasoning);

      const toolCalls = delta.tool_calls || choice.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const part of toolCalls) {
          const index = Number.isFinite(part.index) ? part.index : toolMap.size;
          const current = toolMap.get(index) || { id: "", name: "", arguments: "" };
          if (part.id) current.id = part.id;

          const fn = part.function || part;
          if (fn.name) current.name += fn.name;
          if (fn.arguments) {
            current.arguments +=
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments);
          }
          toolMap.set(index, current);
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await readNext();
      if (done) break;
      consume(parser.push(decoder.decode(value, { stream: true })));
    }
    consume(parser.flush());
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
    signal?.removeEventListener("abort", abortFromCaller);
  }

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call_${Date.now()}_${index}`,
      name: call.name,
      arguments: call.arguments || "{}"
    }))
    .filter((call) => call.name);

  return { content, toolCalls, finishReason, usage, mode: "native" };
}

function ollamaNumberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ollamaOptions(settings) {
  const ollama = settings.ollama || {};
  const maxTokens = Math.max(1, Number(settings.maxTokens) || 4096);
  const numPredict = ollamaNumberOption(ollama.numPredict, 0);
  const options = {
    temperature: Number(settings.temperature ?? 0.2),
    num_ctx: ollamaNumberOption(ollama.numCtx, 8192),
    num_gpu: ollamaNumberOption(ollama.numGpu, -1),
    num_predict: numPredict > 0 ? numPredict : maxTokens,
    top_k: ollamaNumberOption(ollama.topK, 40),
    top_p: ollamaNumberOption(ollama.topP, 0.9),
    min_p: ollamaNumberOption(ollama.minP, 0),
    repeat_penalty: ollamaNumberOption(ollama.repeatPenalty, 1.1),
    repeat_last_n: ollamaNumberOption(ollama.repeatLastN, 64),
    presence_penalty: ollamaNumberOption(ollama.presencePenalty, 0),
    frequency_penalty: ollamaNumberOption(ollama.frequencyPenalty, 0),
    use_mmap: ollama.useMmap !== false,
    use_mlock: ollama.useMlock === true
  };

  const numThread = ollamaNumberOption(ollama.numThread, 0);
  if (numThread > 0) options.num_thread = numThread;
  const numBatch = ollamaNumberOption(ollama.numBatch, 0);
  if (numBatch > 0) options.num_batch = numBatch;
  const numKeep = ollamaNumberOption(ollama.numKeep, 0);
  if (numKeep > 0) options.num_keep = numKeep;

  const seed = ollamaNumberOption(ollama.seed, -1);
  if (seed >= 0) options.seed = seed;
  if (ollama.flashAttn === "on") options.flash_attn = true;
  if (ollama.flashAttn === "off") options.flash_attn = false;
  if (ollama.kvCacheType) options.kv_cache_type = ollama.kvCacheType;

  const stop = String(ollama.stop || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (stop.length) options.stop = stop;

  return options;
}

function ollamaThinkValue(value) {
  if (value === "on") return true;
  if (value === "off") return false;
  if (["low", "medium", "high"].includes(value)) return value;
  return undefined;
}

function ollamaArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ollamaMessages(messages) {
  const callNames = new Map();
  for (const message of messages) {
    for (const call of message?.tool_calls || []) {
      if (call?.id && call?.function?.name) callNames.set(call.id, call.function.name);
    }
  }

  return messages
    .map((message) => {
      const role = message.role;

      if (Array.isArray(message.content)) {
        const texts = [];
        const images = [];
        for (const part of message.content) {
          if (part?.type === "text") texts.push(String(part.text ?? ""));
          if (part?.type === "image_url") {
            const url =
              typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
            const match = /^data:[^;]+;base64,(.+)$/i.exec(String(url || ""));
            if (match) images.push(match[1]);
          }
        }
        const output = { role, content: texts.join("\n") };
        if (images.length) output.images = images;
        return output;
      }

      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        const toolCalls = message.tool_calls
          .map((call) => {
            const name = call.function?.name || call.name;
            if (!name) return null;
            return {
              function: {
                name: String(name),
                arguments: ollamaArguments(call.function?.arguments ?? call.arguments)
              }
            };
          })
          .filter(Boolean);
        return {
          role: "assistant",
          content: String(message.content ?? ""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        };
      }

      if (role === "tool") {
        const output = { role: "tool", content: String(message.content ?? "") };
        const name = message.name || callNames.get(message.tool_call_id);
        if (name) output.tool_name = String(name);
        return output;
      }

      return { role, content: String(message.content ?? "") };
    })
    .filter((message) => message.content || message.images || message.tool_calls);
}

async function streamOllamaChat({
  settings,
  messages,
  tools,
  signal,
  onDelta,
  onReasoning,
  timeoutMs,
  idleTimeoutMs,
  forcePrompt = false
}) {
  const native = !forcePrompt && settings.toolMode !== "prompt";
  const prepared = native
    ? messages
    : withPromptInstructions(promptSafeMessages(messages), settings.toolMode !== "prompt");
  const body = {
    model: settings.model,
    messages: ollamaMessages(prepared),
    stream: true,
    keep_alive: settings.ollama?.keepAlive || "5m",
    options: ollamaOptions(settings)
  };
  if (native && Array.isArray(tools) && tools.length) body.tools = tools;

  const think = ollamaThinkValue(settings.ollama?.think);
  if (think !== undefined) body.think = think;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let headerTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(chatCompletionsUrl(settings), {
      method: "POST",
      headers: ollamaHeaders(settings, {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson"
      }),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    signal?.removeEventListener("abort", abortFromCaller);
    if (headerTimedOut) {
      throw new ProviderTimeoutError(timeoutMessage(settings, timeoutMs));
    }
    if (error?.name === "AbortError") throw error;
    throw ollamaFetchError(settings, error);
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    signal?.removeEventListener("abort", abortFromCaller);
    const raw = await response.text().catch(() => "");
    if (
      native &&
      settings.toolMode === "auto" &&
      [400, 422].includes(response.status) &&
      /tool/i.test(raw)
    ) {
      return streamOllamaChat({
        settings,
        messages,
        tools,
        signal,
        onDelta,
        onReasoning,
        timeoutMs,
        idleTimeoutMs,
        forcePrompt: true
      });
    }
    throw new ProviderError(providerErrorMessage(response.status, raw, settings), {
      status: response.status,
      body: raw
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    signal?.removeEventListener("abort", abortFromCaller);
    throw new ProviderError("Ollama returned an empty response body.");
  }

  const readNext = async () => {
    let idleTimer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            controller.abort();
            reject(
              new ProviderTimeoutError(idleTimeoutMessage(settings, idleTimeoutMs))
            );
          }, idleTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(idleTimer);
    }
  };

  const decoder = new TextDecoder();
  const toolMap = new Map();
  let buffer = "";
  let content = "";
  let finishReason = null;
  let usage = null;

  const consumeLine = (line) => {
    const text = line.trim();
    if (!text) return;

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    if (json.error) {
      throw new ProviderError(String(json.error?.message || json.error), {
        status: 500,
        body: text
      });
    }

    const message = json.message;
    if (message) {
      if (typeof message.content === "string" && message.content) {
        content += message.content;
        if (native) onDelta?.(message.content);
      }

      const reasoning = message.thinking || message.reasoning;
      if (typeof reasoning === "string" && reasoning) onReasoning?.(reasoning);

      if (Array.isArray(message.tool_calls)) {
        for (let index = 0; index < message.tool_calls.length; index += 1) {
          const call = message.tool_calls[index];
          const fn = call?.function || call;
          const name = fn?.name || call?.name;
          if (!name) continue;
          toolMap.set(index, {
            id: String(call?.id || `call_ollama_${Date.now()}_${index}`),
            name: String(name),
            arguments: JSON.stringify(ollamaArguments(fn?.arguments ?? call?.arguments))
          });
        }
      }
    }

    if (json.done) {
      finishReason = json.done_reason || finishReason || "stop";
      const promptTokens = Number(json.prompt_eval_count);
      const completionTokens = Number(json.eval_count);
      if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
        const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
        const completion = Number.isFinite(completionTokens) ? completionTokens : 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion
        };
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await readNext();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
    signal?.removeEventListener("abort", abortFromCaller);
  }

  const toolCalls = [...toolMap.values()];
  const result = {
    content,
    toolCalls,
    finishReason,
    usage,
    mode: native ? "native" : "prompt"
  };

  if (!native) {
    const parsed = extractToolCalls(content);
    result.rawContent = content;
    result.content = parsed.text;
    result.toolCalls = parsed.toolCalls;
    if (parsed.text) onDelta?.(parsed.text);
  }

  return result;
}

export async function streamChat({
  settings,
  messages,
  tools,
  signal,
  onDelta,
  onReasoning,
  onRateLimitWait,
  onRetryWait,
  forcePrompt = false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  idleTimeoutMs = STREAM_IDLE_MS
}) {
  if (!settings.apiKey && settings.provider !== "ollama") {
    throw new ProviderError(
      "No API key is configured. Open Beryy settings and add your API key."
    );
  }

  const google = settings.provider === "google";
  const ollama = settings.provider === "ollama";
  let effectiveTimeoutMs =
    google && timeoutMs === REQUEST_TIMEOUT_MS
      ? GOOGLE_REQUEST_TIMEOUT_MS
      : timeoutMs;
  let effectiveIdleTimeoutMs =
    google && idleTimeoutMs === STREAM_IDLE_MS
      ? GOOGLE_STREAM_IDLE_MS
      : idleTimeoutMs;

  if (ollama) {
    const requestTimeout = Number(settings.ollama?.requestTimeoutMs);
    const idleTimeout = Number(settings.ollama?.idleTimeoutMs);
    if (timeoutMs === REQUEST_TIMEOUT_MS && requestTimeout > 0) {
      effectiveTimeoutMs = requestTimeout;
    }
    if (idleTimeoutMs === STREAM_IDLE_MS && idleTimeout > 0) {
      effectiveIdleTimeoutMs = idleTimeout;
    }
  }

  if (ollama && settings.ollama?.apiMode !== "openai") {
    return streamOllamaChat({
      settings,
      messages,
      tools,
      signal,
      onDelta,
      onReasoning,
      forcePrompt,
      timeoutMs: effectiveTimeoutMs,
      idleTimeoutMs: effectiveIdleTimeoutMs
    });
  }

  const native = !forcePrompt && settings.toolMode !== "prompt";

  let result;
  let transientRetries = 0;

  while (true) {
    try {
      result = await request({
        settings,
        messages,
        tools,
        signal,
        native,
        onDelta,
        onReasoning,
        onRateLimitWait,
        timeoutMs: effectiveTimeoutMs,
        idleTimeoutMs: effectiveIdleTimeoutMs
      });
      break;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;

      const maxRetries = maxRetriesFor(error?.status);
      if (RETRYABLE_STATUSES.has(error?.status) && transientRetries < maxRetries) {
        const waitMs = retryDelayMs(error, transientRetries);
        const attempt = transientRetries + 1;
        onRetryWait?.({ waitMs, status: error.status, attempt, maxRetries });
        await abortableSleep(waitMs, signal);
        onRetryWait?.({ waitMs: 0, status: error.status, attempt, maxRetries });
        transientRetries += 1;
        continue;
      }

      if (transientRetries > 0 && RETRYABLE_STATUSES.has(error?.status)) {
        error.message = `${error.message} Beryy retried ${transientRetries} time${transientRetries === 1 ? "" : "s"} automatically.`;
      }

      const toolRelated = /tool|function/i.test(
        `${error?.body || ""} ${error?.message || ""}`
      );
      if (
        native &&
        settings.toolMode === "auto" &&
        [400, 422].includes(error?.status) &&
        toolRelated
      ) {
        return streamChat({
          settings,
          messages,
          tools,
          signal,
          onDelta,
          onReasoning,
          onRateLimitWait,
          onRetryWait,
          forcePrompt: true,
          timeoutMs: effectiveTimeoutMs,
          idleTimeoutMs: effectiveIdleTimeoutMs
        });
      }
      throw error;
    }
  }

  if (!native) {
    const rawContent = result.content;
    const parsed = extractToolCalls(rawContent);
    result.rawContent = rawContent;
    result.content = parsed.text;
    result.toolCalls = parsed.toolCalls;
    result.mode = "prompt";
    if (parsed.text) onDelta?.(parsed.text);
  }

  return result;
}

