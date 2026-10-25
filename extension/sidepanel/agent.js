import { buildSystemPrompt } from "../shared/prompt.js";
import {
  COMPACTION_THRESHOLD,
  contextWindowFor,
  estimateMessageTokens,
  estimateMessagesTokens
} from "../shared/context.js";
import { TOOLS } from "../shared/tools.js";
import { shouldSendScreenshotImages } from "../shared/vision.js";
import { streamChat } from "./provider.js";

function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  const value = JSON.parse(String(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value;
}

function resultToText(result) {
  if (result == null) return "(no output)";
  if (typeof result === "string") return result.slice(0, 30000);
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((part) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image") return `[image ${part.mimeType || "image/jpeg"}${part.data ? "" : " missing data"}]`;
      return JSON.stringify(part);
    })
    .join("\n")
    .trim();
  return (text || "(no output)").slice(0, 30000);
}

function clipText(value, max) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[trimmed to fit the model context window]`;
}

function isContextLengthError(error) {
  const text = `${error?.message || ""}\n${error?.body || ""}`;
  return /maximum context length|context (?:length|window).*exceed|reduce the length of the messages|too many tokens/i.test(
    text
  );
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  return content
    .map((part) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image_url") return "[screenshot]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function historyUnits(history) {
  const units = [];
  let index = 0;

  while (index < history.length) {
    const item = history[index];
    if (item?.role === "user") {
      units.push([item]);
      index += 1;
      continue;
    }

    if (item?.role === "assistant") {
      const unit = [item];
      index += 1;
      while (index < history.length && history[index]?.role === "tool") {
        unit.push(history[index]);
        index += 1;
      }
      units.push(unit);
      continue;
    }

    units.push([item]);
    index += 1;
  }

  return units;
}

function splitHistoryForCompression(history, keepTokens) {
  const units = historyUnits(history);
  let start = units.length;
  let kept = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const tokens = units[index].reduce(
      (total, item) => total + estimateMessageTokens(item),
      0
    );
    if (kept + tokens > keepTokens && start < units.length) break;
    kept += tokens;
    start = index;
  }

  if (start <= 0) return null;

  const old = units.slice(0, start).flat();
  const recent = units.slice(start).flat();

  if (recent.length > 0 && recent[0].role === "tool") {
    return null;
  }

  return { old, recent };
}

function toolCallXml(call) {
  let args = {};
  try {
    args = parseArgs(call.arguments);
  } catch {
    args = {};
  }
  return `<tool_call>${JSON.stringify({ name: call.name, arguments: args })}</tool_call>`;
}

export class Agent {
  constructor({ settings, execute, onEvent, stream = streamChat, contextWindow = null }) {
    this.settings = settings;
    this.execute = execute;
    this.onEvent = onEvent;
    this.stream = stream;
    this.contextWindow = contextWindow;
    this.history = [];
    this.toolNames = new Map();
    this.promptMode = settings.toolMode === "prompt";
    this.controller = null;
    this.visionWarningShown = false;
    this.lastPromptTokens = 0;
    this.lastRequestEstimate = 0;
    this.tokenCalibration = 1;
  }

  updateSettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    if (
      settings.toolMode !== previous.toolMode ||
      settings.model !== previous.model ||
      settings.provider !== previous.provider
    ) {
      this.promptMode = settings.toolMode === "prompt";
    }
    if (
      settings.model !== previous.model ||
      settings.provider !== previous.provider ||
      settings.vision !== previous.vision
    ) {
      this.visionWarningShown = false;
    }
    if (
      settings.model !== previous.model ||
      settings.provider !== previous.provider
    ) {
      this.lastPromptTokens = 0;
      this.lastRequestEstimate = 0;
      this.tokenCalibration = 1;
    }
  }

  reset() {
    this.history = [];
    this.toolNames.clear();
    this.promptMode = this.settings.toolMode === "prompt";
    this.visionWarningShown = false;
    this.lastPromptTokens = 0;
    this.lastRequestEstimate = 0;
    this.tokenCalibration = 1;
  }

  pruneImages(keep = 1) {
    let found = 0;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const item = this.history[index];
      if (item?.role !== "user" || !Array.isArray(item.content)) continue;
      if (!item.content.some((part) => part?.type === "image_url")) continue;

      found += 1;
      if (found <= keep) continue;
      item.content = item.content.map((part) =>
        part?.type === "image_url"
          ? { type: "text", text: "[older screenshot omitted]" }
          : part
      );
    }
  }

  compactHistory() {
    this.pruneImages(1);

    let tools = 0;
    let assistants = 0;
    let users = 0;
    let changed = 0;

    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const item = this.history[index];
      if (item?.role === "tool") {
        tools += 1;
        if (tools > 2) {
          const content = clipText(item.content, 6000);
          if (content !== item.content) {
            item.content = content;
            changed += 1;
          }
        }
      } else if (item?.role === "assistant") {
        assistants += 1;
        if (assistants > 3) {
          const content = clipText(item.content, 6000);
          if (content !== item.content) {
            item.content = content;
            changed += 1;
          }
        }
      } else if (item?.role === "user" && typeof item.content === "string") {
        users += 1;
        if (users > 4) {
          const content = clipText(item.content, 8000);
          if (content !== item.content) {
            item.content = content;
            changed += 1;
          }
        }
      }
    }

    return changed;
  }

  contextLimit() {
    return this.contextWindow || contextWindowFor(this.settings.model);
  }

  formatHistoryForSummary(history, maxChars) {
    const blocks = [];

    for (const item of history) {
      if (item?.role === "system") {
        blocks.push(`PRIOR SUMMARY:\n${clipText(String(item.content ?? ""), 8000)}`);
        continue;
      }

      if (item?.role === "user") {
        blocks.push(`USER:\n${clipText(contentToText(item.content), 6000)}`);
        continue;
      }

      if (item?.role === "assistant") {
        if (item.content) {
          blocks.push(`ASSISTANT:\n${clipText(item.content, 4000)}`);
        }
        for (const call of item.toolCalls || []) {
          blocks.push(
            `ASSISTANT TOOL CALL (${call.name}):\n${clipText(String(call.arguments ?? "{}"), 2000)}`
          );
        }
        continue;
      }

      if (item?.role === "tool") {
        blocks.push(
          `TOOL RESULT (${item.name || "tool"}):\n${clipText(item.content, 5000)}`
        );
      }
    }

    let transcript = blocks.join("\n\n");
    if (transcript.length <= maxChars) return transcript;

    const headSize = Math.floor(maxChars * 0.25);
    const tailSize = maxChars - headSize - 60;
    transcript = `${transcript.slice(0, headSize)}\n\n[older middle omitted]\n\n${transcript.slice(-tailSize)}`;
    return transcript;
  }

  async summarizeHistory(history, signal) {
    const maxChars = Math.max(
      12000,
      Math.min(480000, Math.floor(this.contextLimit() * 3.5 * 0.55))
    );
    const transcript = this.formatHistoryForSummary(history, maxChars);
    const result = await this.stream({
      settings: {
        ...this.settings,
        temperature: 0.2,
        toolMode: "prompt",
        maxTokens: Math.min(
          2000,
          Math.max(1024, Number(this.settings.maxTokens) || 0)
        )
      },
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Write a concise, dense summary that preserves all information needed to continue the task: user goals, decisions, URLs, selectors, tool results, errors, and pending next steps. Do not invent information. Return only the summary text, no formatting, no tool calls."
        },
        {
          role: "user",
          content: `Earlier conversation:\n\n${transcript}\n\nWrite the summary now.`
        }
      ],
      tools: [],
      signal,
      forcePrompt: true,
      onDelta: () => {},
      onRateLimitWait: (waitMs) =>
        this.onEvent({ type: "rate_limit_wait", waitMs }),
      onRetryWait: (retry) =>
        this.onEvent({ type: "provider_retry", ...retry })
    });

    return String(result?.content || "").trim();
  }

  async compressHistory({ signal, reason = "threshold" } = {}) {
    const keepTokens = Math.max(1500, Math.floor(this.contextLimit() * 0.3));
    const split = splitHistoryForCompression(this.history, keepTokens);
    if (!split) return false;

    this.onEvent({
      type: "compression_start",
      reason,
      contextWindow: this.contextLimit()
    });

    try {
      const summary = await this.summarizeHistory(split.old, signal);
      if (!summary) throw new Error("The model returned an empty summary.");

      this.history = [
        {
          role: "system",
          content: `[Conversation summary — earlier context compressed]\n${summary}`
        },
        ...split.recent
      ];
      this.lastPromptTokens = 0;

      this.onEvent({ type: "compression_done", reason });
      this.onEvent({
        type: "notice",
        text:
          reason === "threshold"
            ? "Context reached 85%; older conversation history was summarized."
            : "The context window was exceeded; older conversation history was summarized, and the request is being retried."
      });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      this.onEvent({ type: "compression_failed", reason });
      return false;
    }
  }

  async maybeCompress(tabContext, signal) {
    const limit = this.contextLimit();
    const messages = this.buildMessages(tabContext);
    const estimatedTokens =
      estimateMessagesTokens(messages) * this.tokenCalibration;
    const threshold = limit * COMPACTION_THRESHOLD;
    if (estimatedTokens < threshold && this.lastPromptTokens < threshold) {
      return false;
    }

    const compressed = await this.compressHistory({
      signal,
      reason: "threshold"
    });
    if (compressed) return true;

    const changed = this.compactHistory();
    if (changed > 0) {
      this.lastPromptTokens = 0;
      this.onEvent({
        type: "notice",
        text: "Context reached 85%; older output was shortened because compression was unavailable."
      });
    }
    return changed > 0;
  }

  getState() {
    const history = [];

    for (const item of this.history) {
      if (!item || typeof item !== "object") continue;

      if (item.role === "system") {
        history.push({ role: "system", content: String(item.content ?? "") });
        continue;
      }

      if (item.role === "user") {
        let content = item.content;
        if (Array.isArray(content)) {
          content = content
            .filter((part) => part?.type === "text" || part?.type === "image_url")
            .map((part) =>
              part.type === "text"
                ? { type: "text", text: String(part.text ?? "") }
                : { type: "text", text: "[image omitted from saved history]" }
            );
        } else {
          content = String(content ?? "");
        }
        history.push({ role: "user", content });
        continue;
      }

      if (item.role === "assistant") {
        history.push({
          role: "assistant",
          content: String(item.content ?? ""),
          rawContent: String(item.rawContent ?? ""),
          toolCalls: Array.isArray(item.toolCalls)
            ? item.toolCalls.map((call) => ({
                id: String(call?.id ?? ""),
                name: String(call?.name ?? ""),
                arguments: String(call?.arguments ?? "{}")
              }))
            : []
        });
        continue;
      }

      if (item.role === "tool" && item.callId) {
        history.push({
          role: "tool",
          callId: String(item.callId),
          name: String(item.name ?? ""),
          content: String(item.content ?? "")
        });
      }
    }

    return {
      history,
      toolNames: [...this.toolNames.entries()],
      promptMode: this.promptMode,
      provider: this.settings.provider,
      model: this.settings.model,
      toolMode: this.settings.toolMode
    };
  }

  loadState(state) {
    if (!state || !Array.isArray(state.history)) return;

    this.history = state.history
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        if (item.role === "system") {
          return { role: "system", content: String(item.content ?? "") };
        }

        if (item.role === "assistant") {
          return {
            role: "assistant",
            content: String(item.content ?? ""),
            rawContent: String(item.rawContent ?? ""),
            toolCalls: Array.isArray(item.toolCalls)
              ? item.toolCalls
                  .filter((call) => call && call.name)
                  .map((call) => ({
                    id: String(call.id ?? ""),
                    name: String(call.name),
                    arguments: String(call.arguments ?? "{}")
                  }))
              : []
          };
        }

        if (item.role === "tool" && item.callId) {
          return {
            role: "tool",
            callId: String(item.callId),
            name: String(item.name ?? ""),
            content: String(item.content ?? "")
          };
        }

        if (item.role === "user") {
          const content = Array.isArray(item.content)
            ? item.content
                .filter((part) => part?.type === "text")
                .map((part) => ({ type: "text", text: String(part.text ?? "") }))
            : String(item.content ?? "");
          return { role: "user", content };
        }

        return null;
      })
      .filter(Boolean);

    const resultIds = new Set(
      this.history.filter((item) => item.role === "tool").map((item) => item.callId)
    );
    const repaired = [];
    for (const item of this.history) {
      repaired.push(item);
      if (item.role !== "assistant" || !item.toolCalls?.length) continue;

      for (const call of item.toolCalls) {
        if (resultIds.has(call.id)) continue;
        resultIds.add(call.id);
        repaired.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: "Error: The tool was interrupted before it returned a result."
        });
      }
    }
    this.history = repaired;

    this.toolNames = new Map(
      Array.isArray(state.toolNames)
        ? state.toolNames
            .filter((entry) => Array.isArray(entry) && entry[0] && entry[1])
            .map(([callId, name]) => [String(callId), String(name)])
        : []
    );

    const sameProvider =
      !state.provider || state.provider === this.settings.provider;
    const sameModel =
      sameProvider && (!state.model || state.model === this.settings.model);
    const sameToolMode = !state.toolMode || state.toolMode === this.settings.toolMode;
    this.promptMode =
      this.settings.toolMode === "prompt" ||
      Boolean(state.promptMode && sameModel && sameToolMode);
    this.visionWarningShown = false;
    this.lastPromptTokens = 0;
    this.lastRequestEstimate = 0;
    this.tokenCalibration = 1;
  }

  abort() {
    this.controller?.abort();
  }

  buildMessages(tabContext) {
    const promptMode = this.promptMode || this.settings.toolMode === "prompt";
    const base = buildSystemPrompt({
      settings: this.settings,
      tabContext,
      promptMode
    });
    const summaries = this.history
      .filter((item) => item?.role === "system" && item.content)
      .map((item) => String(item.content))
      .join("\n\n");
    const system = summaries ? `${base}\n\n${summaries}` : base;

    const messages = [{ role: "system", content: system }];

    for (const item of this.history) {
      if (item.role === "system") continue;

      if (item.role === "assistant") {
        if (promptMode) {
          let content = item.rawContent || item.content || "";
          if (!item.rawContent && item.toolCalls?.length) {
            const calls = item.toolCalls.map(toolCallXml).join("\n");
            content = `${content}\n${calls}`.trim();
          }
          messages.push({ role: "assistant", content });
          continue;
        }

        const message = { role: "assistant", content: item.content || null };
        if (item.toolCalls?.length) {
          message.tool_calls = item.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" }
          }));
        }
        messages.push(message);
        continue;
      }

      if (item.role === "tool") {
        if (promptMode) {
          const name = item.name || this.toolNames.get(item.callId) || "tool";
          messages.push({
            role: "user",
            content: `Tool result for ${name}:\n${item.content}`
          });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            content: item.content
          });
        }
        continue;
      }

      messages.push({ role: "user", content: item.content });
    }

    return messages;
  }

  async run(text, tabContext) {
    this.controller = new AbortController();
    const signal = this.controller.signal;

    this.history.push({ role: "user", content: String(text) });
    this.onEvent({ type: "turn_start" });

    let step = 0;
    while (step < this.settings.maxSteps) {
      step += 1;
      this.onEvent({ type: "assistant_start", step });

      let result;
      let compacted = false;
      let compressionChecked = false;
      while (true) {
        try {
          this.pruneImages(1);
          if (!compressionChecked) {
            compressionChecked = true;
            await this.maybeCompress(tabContext, signal);
          }
          const messages = this.buildMessages(tabContext);
          this.lastRequestEstimate = estimateMessagesTokens(messages);
          const limit = this.contextLimit();
          const estimated = Math.round(
            this.lastRequestEstimate * this.tokenCalibration
          );
          this.onEvent({
            type: "context_usage",
            percent: Math.min(100, Math.round((estimated / limit) * 100)),
            estimated,
            limit
          });
          result = await this.stream({
            settings: this.settings,
            messages,
            tools: TOOLS,
            signal,
            forcePrompt: this.promptMode,
            onDelta: (delta) => this.onEvent({ type: "assistant_delta", text: delta }),
            onRateLimitWait: (waitMs) =>
              this.onEvent({ type: "rate_limit_wait", waitMs }),
            onRetryWait: (retry) =>
              this.onEvent({ type: "provider_retry", ...retry })
          });
          this.lastPromptTokens = Number(result?.usage?.prompt_tokens) || 0;
          if (this.lastPromptTokens > 0 && this.lastRequestEstimate > 0) {
            this.tokenCalibration = Math.min(
              1.6,
              Math.max(0.8, this.lastPromptTokens / this.lastRequestEstimate)
            );
            this.onEvent({
              type: "context_usage",
              percent: Math.min(
                100,
                Math.round((this.lastPromptTokens / limit) * 100)
              ),
              estimated: this.lastPromptTokens,
              limit,
              actual: true
            });
          }
          break;
        } catch (error) {
          if (error?.name === "AbortError") {
            this.onEvent({ type: "aborted" });
            return;
          }
          if (isContextLengthError(error)) {
            if (!compacted) {
              compacted = true;
              const compressed = await this.compressHistory({
                signal,
                reason: "error"
              });
              if (compressed) continue;

              const changed = this.compactHistory();
              if (changed > 0) {
                this.lastPromptTokens = 0;
                this.onEvent({
                  type: "notice",
                  text: "This chat exceeded the model's context window. Older output was shortened, and the request is being retried."
                });
                continue;
              }
            }
            error.message =
              "This chat is too large for the selected model's context window. Start a new chat or choose a model with a larger context.";
          }
          throw error;
        }
      }

      if (result.mode === "prompt") this.promptMode = true;

      const assistant = {
        role: "assistant",
        content: result.content || "",
        rawContent:
          result.mode === "prompt" ? result.rawContent || result.content || "" : "",
        toolCalls: result.toolCalls || []
      };
      this.history.push(assistant);
      this.onEvent({ type: "assistant_end", text: assistant.content, step });

      if (!assistant.toolCalls.length) {
        if (result.finishReason === "length") {
          this.onEvent({
            type: "notice",
            text: "The response hit the output token limit before finishing."
          });
        }
        this.onEvent({ type: "turn_end", reason: "complete" });
        return;
      }

      for (const call of assistant.toolCalls) {
        if (signal.aborted) {
          this.onEvent({ type: "aborted" });
          return;
        }

        this.toolNames.set(call.id, call.name);
        let args;
        try {
          args = parseArgs(call.arguments);
        } catch (error) {
          const message = `Invalid arguments for ${call.name}: ${error?.message || error}`;
          this.history.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: `Error: ${message}`
          });
          this.onEvent({
            type: "tool_error",
            callId: call.id,
            tool: call.name,
            error: message
          });
          continue;
        }

        this.onEvent({
          type: "tool_start",
          callId: call.id,
          tool: call.name,
          args
        });

        try {
          const toolResult = await this.execute(call.name, args);
          this.history.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: resultToText(toolResult)
          });
          this.onEvent({
            type: "tool_result",
            callId: call.id,
            tool: call.name,
            result: toolResult
          });

          if (this.settings.vision && Array.isArray(toolResult?.content)) {
            const images = toolResult.content.filter(
              (part) => part?.type === "image" && part.data
            );
            if (images.length && !shouldSendScreenshotImages(this.settings.model)) {
              if (!this.visionWarningShown) {
                this.visionWarningShown = true;
                this.onEvent({
                  type: "notice",
                  text: `Vision is on, but ${this.settings.model} is a text-only model. The screenshot stays in the panel but was not sent. Choose a vision model or turn Vision off.`
                });
              }
            } else {
              for (const part of images) {
                this.history.push({
                  role: "user",
                  content: [
                    { type: "text", text: `Image returned by ${call.name}:` },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${part.mimeType || "image/jpeg"};base64,${part.data}`
                      }
                    }
                  ]
                });
              }
            }
          }
        } catch (error) {
          const message = String(error?.message || error);
          this.history.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: `Error: ${message}`
          });
          this.onEvent({
            type: "tool_error",
            callId: call.id,
            tool: call.name,
            error: message
          });
        }
      }

      if (signal.aborted) {
        this.onEvent({ type: "aborted" });
        return;
      }

      if (step >= this.settings.maxSteps) {
        this.onEvent({
          type: "notice",
          text: `I stopped after ${this.settings.maxSteps} steps. Ask me to continue if you want me to keep going.`
        });
        this.onEvent({ type: "turn_end", reason: "max_steps" });
        return;
      }
    }
  }
}
