import { Agent } from "./agent.js";
import {
  conversationTitle,
  createConversation,
  deleteConversation,
  listConversations,
  loadActiveConversation,
  loadConversation,
  saveConversation,
  setActiveConversation
} from "./conversations.js";
import { listModels } from "./provider.js";
import {
  getSettings,
  normalizeSettings,
  saveSettings
} from "../shared/settings.js";
import { PROVIDERS, providerLabel } from "../shared/providers.js";

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const welcomeEl = $("welcome");
const welcomeTabEl = $("welcome-tab");
const welcomeNoteEl = $("welcome-note");
const modelLabel = $("model-label");
const providerSelect = $("provider-select");
const modelSelect = $("model-select");
const refreshModelsButton = $("refresh-models");
const modeSelect = $("mode-select");
const statusEl = $("status");
const promptEl = $("prompt");
const composerEl = $("composer");
const sendButton = $("send");
const stopButton = $("stop");
const newChatButton = $("new-chat");
const historyButton = $("history");
const settingsButton = $("settings");

const permissionOverlay = $("permission");
const permissionReason = $("permission-reason");
const permissionAction = $("permission-action");
const permissionHost = $("permission-host");
const permissionTab = $("permission-tab");
const permissionArgs = $("permission-args-text");
const permissionOnce = $("permission-once");
const permissionDomain = $("permission-domain");
const permissionDeny = $("permission-deny");

const historyOverlay = $("history-overlay");
const historyCloseButton = $("history-close");
const historyListEl = $("history-list");
const historyNewButton = $("history-new");

let settings = normalizeSettings({});
let agent = null;
let running = false;
let port = null;
let reconnectTimer = null;
let requestSeq = 0;
let conversationToken = 0;
let activePermission = null;
let currentTurn = null;
let currentTextBlock = null;
let currentAssistantEntry = null;
let conversation = null;
let saveTimer = null;
let saveErrorShown = false;
let historyRequest = 0;
let modelList = [];
let modelListKey = "";
let modelRequest = 0;

const pending = new Map();
const toolChips = new Map();
const toolEntries = new Map();

function setStatus(text, busy = false) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
  statusEl.classList.toggle("busy", Boolean(busy));
}

function updateContextIndicator(percent) {
  const indicator = $("context-indicator");
  const percentEl = $("context-percent");
  const fillEl = $("context-bar-fill");
  if (!indicator || !percentEl || !fillEl) return;

  percentEl.textContent = `${percent}%`;
  fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;

  indicator.hidden = false;
  indicator.classList.toggle("warn", percent >= 70 && percent < 85);
  indicator.classList.toggle("danger", percent >= 85);
}

function updateComposer() {
  sendButton.disabled = running;
  stopButton.hidden = !running;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function clip(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n… (truncated)` : value;
}

function snapshotAgentState() {
  if (conversation && agent) conversation.agent = agent.getState();
}

async function persistConversation() {
  if (!conversation) return;
  snapshotAgentState();
  conversation.updatedAt = Date.now();

  try {
    await saveConversation(conversation);
    saveErrorShown = false;
    if (!historyOverlay.hidden) void renderHistoryList();
  } catch (error) {
    if (!saveErrorShown) {
      saveErrorShown = true;
      addNotice(`Could not save chat history: ${String(error?.message || error)}`, "error");
    }
  }
}

function cancelScheduledSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

function queueSave(immediate = false) {
  if (!conversation) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (immediate) {
    void persistConversation();
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistConversation();
  }, 200);
}

function persistIfNeeded() {
  if (!conversation) return Promise.resolve();
  if (!conversation.transcript.length && !conversation.agent.history.length) {
    return Promise.resolve();
  }
  return persistConversation();
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    port = chrome.runtime.connect({ name: "sidepanel" });
  } catch {
    port = null;
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    failPending("The extension restarted. Try that again.");
    hidePermission();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setStatus("Reconnecting…", true);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 800);
}

function failPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
    pending.delete(id);
  }
}

function call(type, payload = {}, timeoutMs = 20000) {
  if (!port) {
    return Promise.reject(new Error("Beryy is reconnecting. Try again in a moment."));
  }

  const id = `req_${++requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The extension did not respond in time."));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    try {
      port.postMessage({ type, id, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function onPortMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "permission_request") {
    showPermission(message.request);
    return;
  }

  if (message.type === "ready") return;

  const entry = message.id ? pending.get(message.id) : null;
  if (!entry) {
    if (message.type === "error") addNotice(message.error || "Unknown error.", "error");
    return;
  }

  pending.delete(message.id);
  clearTimeout(entry.timer);

  if (message.type === "tool_result") {
    entry.resolve(message.result);
  } else if (message.type === "tool_error" || message.type === "error") {
    entry.reject(new Error(message.error || "Unknown error."));
  } else {
    entry.resolve(message);
  }
}

function modelSourceKey(value = settings) {
  return `${value.provider}|${value.baseUrl}|${value.apiKey}`;
}

function renderProviderOptions() {
  providerSelect.replaceChildren();

  for (const [id, preset] of Object.entries(PROVIDERS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.shortLabel;
    providerSelect.appendChild(option);
  }

  providerSelect.value = settings.provider;
}

function renderModelOptions(selected) {
  const values = [...new Set([selected, ...modelList].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  modelSelect.replaceChildren();

  if (!values.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models available";
    modelSelect.appendChild(option);
  } else {
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      modelSelect.appendChild(option);
    }
    modelSelect.value = selected || values[0];
  }

  modelSelect.disabled = !settings.apiKey || values.length === 0;
  refreshModelsButton.disabled = !settings.apiKey;
}

async function loadModels({ force = false, announce = false } = {}) {
  const providerName = providerLabel(settings.provider);

  if (!settings.apiKey) {
    modelList = [];
    modelListKey = "";
    renderModelOptions(settings.model);
    modelSelect.title = `Add an API key for ${providerName} in settings to load models`;
    return;
  }

  const key = modelSourceKey();
  if (!force && key === modelListKey && modelList.length) {
    renderModelOptions(settings.model);
    return;
  }

  if (key !== modelListKey) {
    modelList = [];
    modelListKey = "";
  }

  const token = ++modelRequest;
  renderModelOptions(settings.model);
  modelSelect.disabled = true;
  refreshModelsButton.disabled = true;
  refreshModelsButton.classList.add("loading");
  if (announce) setStatus("Loading models…", true);

  try {
    const models = await listModels(settings);
    if (token !== modelRequest) return;

    modelList = models;
    modelListKey = key;
    renderModelOptions(settings.model);
    modelSelect.title = `${models.length} model${models.length === 1 ? "" : "s"} available`;

    if (announce) {
      setStatus(`Loaded ${models.length} model${models.length === 1 ? "" : "s"}.`);
      setTimeout(() => {
        if (statusEl.textContent.startsWith("Loaded ")) setStatus("", false);
      }, 2500);
    }
  } catch (error) {
    if (token !== modelRequest) return;
    renderModelOptions(settings.model);
    const message = String(error?.message || error);
    modelSelect.title = `Could not load models: ${message}`;
    if (announce) {
      setStatus("", false);
      addNotice(`Could not load ${providerName} models: ${message}`, "error");
    }
  } finally {
    if (token === modelRequest) {
      refreshModelsButton.classList.remove("loading");
      refreshModelsButton.disabled = !settings.apiKey;
      modelSelect.disabled = !settings.apiKey;
    }
  }
}

function applySettings() {
  const providerName = providerLabel(settings.provider);
  renderProviderOptions();
  modelLabel.textContent = settings.model || "No model";
  modelLabel.title = `${providerName} · ${settings.model} · ${settings.baseUrl}`;
  modeSelect.value = settings.permissionMode;
  renderModelOptions(settings.model);

  if (settings.apiKey) {
    welcomeNoteEl.textContent = "Ready. I ask before I change anything.";
    welcomeNoteEl.classList.add("ok");
  } else {
    welcomeNoteEl.textContent =
      settings.provider === "custom"
        ? "Add an API key in settings to get started."
        : `Add your ${providerName} API key in settings to get started.`;
    welcomeNoteEl.classList.remove("ok");
  }
}

async function reloadSettings() {
  const previousKey = modelSourceKey(settings);
  try {
    settings = await getSettings();
  } catch {
    settings = normalizeSettings({});
  }
  applySettings();
  agent?.updateSettings(settings);

  if (modelSourceKey(settings) !== previousKey || !modelList.length) {
    void loadModels();
  }
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    let label = "Active tab";
    try {
      const url = new URL(tab.url || "");
      if (url.protocol === "http:" || url.protocol === "https:") {
        label = `Active tab: ${url.hostname}`;
      } else if (tab.title) {
        label = `Active tab: ${tab.title}`;
      }
    } catch {
      if (tab.title) label = `Active tab: ${tab.title}`;
    }
    welcomeTabEl.textContent = label;
  } catch {
    // Ignore.
  }
}

function hideWelcome() {
  welcomeEl.hidden = true;
}

function addUserMessage(text, { record = true } = {}) {
  const turn = document.createElement("div");
  turn.className = "turn user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  turn.appendChild(bubble);
  messagesEl.appendChild(turn);

  if (record && conversation) {
    if (conversation.title === "New chat") {
      conversation.title = conversationTitle(text);
    }
    conversation.transcript.push({ type: "user", text });
    queueSave();
  }

  scrollToBottom();
}

function addNotice(text, kind = "", record = false) {
  const notice = document.createElement("div");
  notice.className = `notice${kind ? ` ${kind}` : ""}`;
  notice.textContent = text;
  messagesEl.appendChild(notice);

  if (record && conversation) {
    conversation.transcript.push({ type: "notice", text, kind });
    queueSave();
  }

  scrollToBottom();
}

function createTurn() {
  const turn = document.createElement("div");
  turn.className = "turn assistant";
  messagesEl.appendChild(turn);
  return turn;
}

function ensureTurn() {
  if (!currentTurn) currentTurn = createTurn();
  return currentTurn;
}

function ensureTextBlock() {
  if (!currentTextBlock) {
    currentTextBlock = document.createElement("div");
    currentTextBlock.className = "assistant-text";
    ensureTurn().appendChild(currentTextBlock);
  }
  return currentTextBlock;
}

function toolSummary(tool, args = {}) {
  if (tool === "computer") {
    const extra = args.ref ? ` · ${args.ref}` : "";
    return `computer · ${args.action || "action"}${extra}`;
  }
  if (tool === "navigate") return `navigate · ${args.url || ""}`;
  if (tool === "find") return `find · "${args.query || ""}"`;
  if (tool === "form_input") return `form_input · ${args.ref || ""}`;
  if (tool === "read_page") return `read_page${args.filter ? ` · ${args.filter}` : ""}`;
  if (tool === "get_page_text") return "get_page_text";
  if (tool === "tabs_context_mcp") return "tabs_context_mcp";
  if (tool === "tabs_create_mcp") return `tabs_create_mcp${args.url ? ` · ${args.url}` : ""}`;
  if (tool === "tabs_close_mcp") return "tabs_close_mcp";
  if (tool === "upload_image") return `upload_image · ${args.ref || ""}`;
  return tool;
}

function addToolChip(event) {
  const turn = ensureTurn();
  const details = document.createElement("details");
  details.className = "tool running";
  details.open = true;

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = toolSummary(event.tool, event.args);
  const state = document.createElement("span");
  state.className = "tool-state";
  state.textContent = "running";
  summary.append(title, state);

  const body = document.createElement("div");
  body.className = "tool-body";

  const args = document.createElement("pre");
  args.className = "tool-args";
  args.textContent = JSON.stringify(event.args || {}, null, 2);
  body.appendChild(args);

  details.append(summary, body);
  turn.appendChild(details);

  toolChips.set(event.callId, { details, body, state });
  scrollToBottom();
}

function toolResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

function completeToolChip(
  callId,
  { output = "", error = "", failed = false, images = [] } = {}
) {
  const chip = toolChips.get(callId);
  if (!chip) return;

  chip.details.classList.remove("running");
  chip.details.classList.add(failed ? "failed" : "success");
  chip.state.textContent = failed ? "failed" : "done";

  if (failed) {
    const node = document.createElement("pre");
    node.className = "tool-output failed";
    node.textContent = clip(error || "Tool failed.", 12000);
    chip.body.appendChild(node);
  } else {
    if (output) {
      const node = document.createElement("pre");
      node.className = "tool-output";
      node.textContent = clip(output, 12000);
      chip.body.appendChild(node);
    }

    for (const part of images) {
      if (part?.type !== "image" || typeof part.data !== "string") continue;
      const mime = String(part.mimeType || "image/jpeg").toLowerCase();
      if (!mime.startsWith("image/")) continue;
      const image = document.createElement("img");
      image.className = "tool-image";
      image.alt = "Screenshot from the page";
      image.loading = "lazy";
      image.src = `data:${mime};base64,${part.data}`;
      chip.body.appendChild(image);
    }
  }

  toolChips.delete(callId);
  scrollToBottom();
}

function finishToolChip(event, failed) {
  const parts = Array.isArray(event.result?.content) ? event.result.content : [];
  completeToolChip(event.callId, {
    output: failed ? "" : toolResultText(event.result),
    error: event.error,
    failed,
    images: failed ? [] : parts
  });
}

function restoreToolChip(entry) {
  addToolChip({
    callId: entry.callId,
    tool: entry.tool,
    args: entry.args
  });
  completeToolChip(entry.callId, {
    output: entry.output,
    error: entry.error,
    failed: entry.status === "failed"
  });
}

function reconcileConversationContext() {
  const entries = conversation?.transcript || [];
  const last = entries[entries.length - 1];
  if (!last || last.type !== "user") return;

  const history = conversation.agent?.history || [];
  const lastUser = [...history]
    .reverse()
    .find((item) => item.role === "user" && typeof item.content === "string");
  if (lastUser?.content === last.text) return;

  history.push({ role: "user", content: last.text });
  conversation.agent.history = history;
  queueSave();
}

function renderConversation() {
  for (const node of messagesEl.querySelectorAll(".turn, .notice")) node.remove();

  currentTurn = null;
  currentTextBlock = null;
  currentAssistantEntry = null;
  toolChips.clear();
  toolEntries.clear();

  const entries = conversation?.transcript || [];
  if (!entries.length) {
    welcomeEl.hidden = false;
    return;
  }

  welcomeEl.hidden = true;
  for (const entry of entries) {
    if (entry.type === "user") {
      addUserMessage(entry.text, { record: false });
      currentTurn = null;
      continue;
    }

    if (entry.type === "assistant") {
      const block = document.createElement("div");
      block.className = "assistant-text";
      block.textContent = entry.text;
      ensureTurn().appendChild(block);
      currentTextBlock = null;
      continue;
    }

    if (entry.type === "tool") {
      restoreToolChip(entry);
      continue;
    }

    if (entry.type === "notice") {
      addNotice(entry.text, entry.kind, false);
    }
  }

  currentTurn = null;
  currentTextBlock = null;
  scrollToBottom();
}

function handleAgentEvent(event, token) {
  if (token !== conversationToken) return;

  switch (event.type) {
    case "turn_start":
      currentTurn = createTurn();
      currentTextBlock = null;
      currentAssistantEntry = null;
      toolEntries.clear();
      queueSave();
      break;
    case "assistant_start":
      currentTextBlock = null;
      if (conversation) {
        currentAssistantEntry = { type: "assistant", text: "" };
        conversation.transcript.push(currentAssistantEntry);
      }
      break;
    case "rate_limit_wait":
      if (event.waitMs > 0) {
        setStatus(
          `NVIDIA rate limit: waiting ${Math.ceil(event.waitMs / 1000)}s…`,
          true
        );
      } else {
        setStatus("Thinking…", true);
      }
      break;
    case "provider_retry":
      if (event.waitMs > 0) {
        const reason = event.status === 429 ? "rate limit" : "temporary error";
        setStatus(
          `${providerLabel(settings.provider)} ${reason}: retrying in ${Math.ceil(event.waitMs / 1000)}s…`,
          true
        );
      } else {
        setStatus("Thinking…", true);
      }
      break;
    case "compression_start":
      setStatus("Compacting conversation context…", true);
      break;
    case "compression_done":
    case "compression_failed":
      setStatus("Thinking…", true);
      break;
    case "context_usage":
      updateContextIndicator(event.percent);
      break;
    case "assistant_delta": {
      const block = ensureTextBlock();
      block.textContent += event.text;
      if (currentAssistantEntry) currentAssistantEntry.text += event.text;
      scrollToBottom();
      break;
    }
    case "assistant_end":
      if (currentAssistantEntry) {
        currentAssistantEntry.text = String(
          event.text ?? currentAssistantEntry.text ?? ""
        );
        if (!currentAssistantEntry.text.trim() && conversation) {
          const index = conversation.transcript.indexOf(currentAssistantEntry);
          if (index >= 0) conversation.transcript.splice(index, 1);
        } else {
          queueSave();
        }
        currentAssistantEntry = null;
      }
      if (currentTextBlock && !currentTextBlock.textContent.trim()) {
        currentTextBlock.remove();
      }
      currentTextBlock = null;
      break;
    case "tool_start": {
      addToolChip(event);
      if (conversation) {
        const entry = {
          type: "tool",
          callId: event.callId,
          tool: event.tool,
          args: event.args || {},
          status: "running",
          output: "",
          error: ""
        };
        conversation.transcript.push(entry);
        toolEntries.set(event.callId, entry);
      }
      queueSave();
      setStatus(`Running ${event.tool}…`, true);
      break;
    }
    case "tool_result": {
      finishToolChip(event, false);
      if (conversation) {
        const entry =
          toolEntries.get(event.callId) ||
          {
            type: "tool",
            callId: event.callId,
            tool: event.tool,
            args: {},
            output: "",
            error: ""
          };
        if (!toolEntries.has(event.callId)) conversation.transcript.push(entry);
        entry.status = "done";
        entry.output = clip(toolResultText(event.result), 30000);
        entry.error = "";
        toolEntries.set(event.callId, entry);
      }
      queueSave();
      setStatus("Thinking…", true);
      break;
    }
    case "tool_error": {
      finishToolChip(event, true);
      if (conversation) {
        const entry =
          toolEntries.get(event.callId) ||
          {
            type: "tool",
            callId: event.callId,
            tool: event.tool,
            args: {},
            output: "",
            error: ""
          };
        if (!toolEntries.has(event.callId)) conversation.transcript.push(entry);
        entry.status = "failed";
        entry.error = String(event.error || "Tool failed.");
        toolEntries.set(event.callId, entry);
      }
      queueSave();
      setStatus("Thinking…", true);
      break;
    }
    case "notice":
      addNotice(event.text, "", true);
      break;
    case "aborted":
      if (currentAssistantEntry && !currentAssistantEntry.text.trim() && conversation) {
        const index = conversation.transcript.indexOf(currentAssistantEntry);
        if (index >= 0) conversation.transcript.splice(index, 1);
      }
      currentAssistantEntry = null;
      currentTextBlock = null;
      addNotice("Stopped.", "", true);
      setStatus("", false);
      queueSave(true);
      break;
    case "turn_end":
      currentTurn = null;
      currentTextBlock = null;
      currentAssistantEntry = null;
      toolChips.clear();
      toolEntries.clear();
      setStatus("", false);
      queueSave(true);
      break;
    default:
      break;
  }
}

async function executeTool(tool, args) {
  return call("execute_tool", { tool, args }, 10 * 60 * 1000);
}

function ensureAgent(token) {
  if (!agent) {
    agent = new Agent({
      settings,
      execute: executeTool,
      onEvent: (event) => handleAgentEvent(event, token)
    });
    if (conversation?.agent) agent.loadState(conversation.agent);
  }
  return agent;
}

async function send() {
  const text = promptEl.value.trim();
  if (!text || running) return;

  if (!settings.apiKey) {
    const target = settings.provider === "custom" ? "API" : providerLabel(settings.provider);
    addNotice(
      `No API key yet. Opening settings so you can add your ${target} key.`,
      "error"
    );
    chrome.runtime.openOptionsPage();
    return;
  }

  if (!conversation) conversation = createConversation();

  promptEl.value = "";
  promptEl.style.height = "auto";
  hideWelcome();
  addUserMessage(text);

  running = true;
  updateComposer();
  setStatus("Thinking…", true);

  const token = conversationToken;

  try {
    let context = null;
    try {
      const response = await call("get_tab_context", { createIfEmpty: false }, 15000);
      context = response.context || null;
    } catch {
      // The model can still call tabs_context_mcp with createIfEmpty.
    }

    const activeAgent = ensureAgent(token);
    activeAgent.updateSettings(settings);
    await activeAgent.run(text, context);
  } catch (error) {
    if (token !== conversationToken) return;
    const message = String(error?.message || error);
    if (error?.name === "AbortError" || /abort/i.test(message)) {
      addNotice("Stopped.", "", true);
    } else {
      addNotice(message, "error", true);
    }
    setStatus("", false);
  } finally {
    if (token === conversationToken) {
      running = false;
      updateComposer();
      if (statusEl.classList.contains("busy")) setStatus("", false);
      queueSave(true);
    }
  }
}

function showPermission(request) {
  if (!request) return;
  closeHistory();
  activePermission = request;

  permissionReason.textContent =
    request.reason || "Beryy needs your permission for this action.";
  permissionAction.textContent = request.action || request.tool || "Action";
  permissionHost.textContent = request.host || "Browser controls";
  permissionTab.textContent = request.tab
    ? `${request.tab.title || "Untitled"} — ${request.tab.url || ""}`
    : "No specific tab";
  permissionArgs.textContent = JSON.stringify(request.args || {}, null, 2);
  permissionDomain.hidden = !request.host;

  permissionOverlay.hidden = false;
  permissionOnce.focus();
}

function hidePermission() {
  activePermission = null;
  permissionOverlay.hidden = true;
}

function respondPermission(decision) {
  if (!activePermission) return;
  const requestId = activePermission.requestId;
  hidePermission();
  try {
    port?.postMessage({ type: "permission_response", requestId, decision });
  } catch {
    // The port will reconnect; the request times out on the background side.
  }
}

function stopCurrentTurn() {
  cancelScheduledSave();
  conversationToken += 1;
  agent?.abort();
  agent = null;
  running = false;
  currentTurn = null;
  currentTextBlock = null;
  currentAssistantEntry = null;
  toolChips.clear();
  toolEntries.clear();
  hidePermission();
  setStatus("", false);
  updateComposer();
}

function newChat() {
  const previous = conversation;
  if (previous) void persistIfNeeded();
  stopCurrentTurn();

  conversation = createConversation();
  void setActiveConversation(conversation.id);
  closeHistory();
  renderConversation();
  promptEl.focus();
}

async function switchConversation(id) {
  if (!id) return;
  if (id === conversation?.id) {
    closeHistory();
    return;
  }

  if (conversation) void persistIfNeeded();
  stopCurrentTurn();

  let next = null;
  try {
    next = await loadConversation(id);
  } catch {
    next = null;
  }

  if (!next) {
    renderConversation();
    closeHistory();
    return;
  }

  conversation = next;
  reconcileConversationContext();
  await setActiveConversation(id);
  renderConversation();
  updateComposer();
  closeHistory();
  promptEl.focus();
}

async function deleteChat(id) {
  if (!id) return;
  if (!window.confirm("Delete this chat?")) return;

  if (id === conversation?.id) {
    stopCurrentTurn();
    try {
      await deleteConversation(id);
    } catch (error) {
      addNotice(String(error?.message || error), "error");
      return;
    }
    conversation = createConversation();
    void setActiveConversation(conversation.id);
    renderConversation();
    updateComposer();
    closeHistory();
    promptEl.focus();
    return;
  }

  try {
    await deleteConversation(id);
    await renderHistoryList();
  } catch (error) {
    addNotice(String(error?.message || error), "error");
  }
}

function historyMeta(item) {
  const date = item.updatedAt
    ? new Date(item.updatedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "";
  const count = item.messageCount === 1 ? "1 message" : `${item.messageCount} messages`;
  return [date, count].filter(Boolean).join(" · ");
}

async function renderHistoryList() {
  const token = ++historyRequest;
  let items = [];

  try {
    items = await listConversations();
  } catch (error) {
    if (token !== historyRequest) return;
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = `Could not load chat history: ${String(error?.message || error)}`;
    historyListEl.replaceChildren(empty);
    return;
  }

  if (token !== historyRequest) return;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No saved chats yet.";
    historyListEl.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "history-item";
    if (item.id === conversation?.id) row.classList.add("active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    open.dataset.open = item.id;

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = item.title || "New chat";

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = historyMeta(item);

    open.append(title, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete";
    remove.dataset.delete = item.id;
    remove.title = "Delete chat";
    remove.setAttribute("aria-label", `Delete ${item.title || "chat"}`);
    remove.textContent = "×";

    row.append(open, remove);
    fragment.append(row);
  }

  historyListEl.replaceChildren(fragment);
}

function openHistory() {
  historyOverlay.hidden = false;
  void renderHistoryList();
  historyCloseButton.focus();
}

function closeHistory() {
  if (historyOverlay.hidden) return;
  historyOverlay.hidden = true;
  historyButton.focus();
}

function wireEvents() {
  composerEl.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });

  promptEl.addEventListener("input", () => {
    promptEl.style.height = "auto";
    promptEl.style.height = `${Math.min(160, promptEl.scrollHeight)}px`;
  });

  promptEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!running) composerEl.requestSubmit();
    }
  });

  stopButton.addEventListener("click", () => {
    if (!agent) return;
    setStatus("Stopping…", true);
    agent.abort();
  });

  newChatButton.addEventListener("click", newChat);
  historyButton.addEventListener("click", openHistory);
  historyCloseButton.addEventListener("click", closeHistory);
  historyNewButton.addEventListener("click", newChat);
  settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

  historyOverlay.addEventListener("click", (event) => {
    if (event.target === historyOverlay) closeHistory();
  });

  historyListEl.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-delete]");
    if (remove) {
      void deleteChat(remove.dataset.delete);
      return;
    }

    const open = event.target.closest("[data-open]");
    if (open) void switchConversation(open.dataset.open);
  });

  providerSelect.addEventListener("change", async () => {
    const provider = providerSelect.value;
    if (!provider || provider === settings.provider) return;

    try {
      settings = await saveSettings({ provider });
      applySettings();
      agent?.updateSettings(settings);
      void loadModels({ force: true });
    } catch (error) {
      providerSelect.value = settings.provider;
      addNotice(String(error?.message || error), "error");
    }
  });

  modelSelect.addEventListener("change", async () => {
    const selected = modelSelect.value;
    if (!selected || selected === settings.model) return;

    try {
      settings = await saveSettings({ model: selected });
      applySettings();
      agent?.updateSettings(settings);
    } catch (error) {
      modelSelect.value = settings.model;
      addNotice(String(error?.message || error), "error");
    }
  });

  refreshModelsButton.addEventListener("click", () => {
    void loadModels({ force: true, announce: true });
  });

  modeSelect.addEventListener("change", async () => {
    try {
      const response = await call("save_settings", {
        patch: { permissionMode: modeSelect.value }
      });
      settings = response.settings || settings;
      applySettings();
    } catch (error) {
      addNotice(String(error?.message || error), "error");
    }
  });

  welcomeEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]");
    if (!button) return;
    promptEl.value = button.dataset.prompt || "";
    promptEl.dispatchEvent(new Event("input"));
    promptEl.focus();
  });

  permissionOnce.addEventListener("click", () => respondPermission("allow_once"));
  permissionDomain.addEventListener("click", () => respondPermission("allow_domain"));
  permissionDeny.addEventListener("click", () => respondPermission("deny"));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!permissionOverlay.hidden) {
      respondPermission("deny");
    } else if (!historyOverlay.hidden) {
      closeHistory();
    }
  });

  window.addEventListener("pagehide", () => {
    if (!conversation) return;
    if (!conversation.transcript.length && !conversation.agent.history.length) return;
    snapshotAgentState();
    conversation.updatedAt = Date.now();
    void saveConversation(conversation);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) void reloadSettings();
  });

  chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
  chrome.tabs.onUpdated.addListener((_tabId, info) => {
    if (info.url || info.status === "complete") void refreshActiveTab();
  });
}

async function init() {
  wireEvents();
  connect();

  try {
    settings = await getSettings();
  } catch {
    settings = normalizeSettings({});
  }
  applySettings();

  try {
    conversation = await loadActiveConversation();
  } catch {
    conversation = null;
  }
  if (!conversation) conversation = createConversation();
  reconcileConversationContext();
  renderConversation();
  updateComposer();
  void refreshActiveTab();
  void loadModels();

  setTimeout(() => promptEl.focus(), 50);
}

void init();
