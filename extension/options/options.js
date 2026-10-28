import {
  DEFAULT_SETTINGS,
  getSettings,
  normalizeSettings,
  saveSettings
} from "../shared/settings.js";
import {
  PROVIDERS,
  chatCompletionsUrl,
  ollamaRootUrl,
  providerDefaults,
  providerPreset,
  providerRequiresApiKey
} from "../shared/providers.js";

const $ = (id) => document.getElementById(id);

const form = $("settings-form");
const providerInput = $("provider");
const providerNote = $("provider-note");
const apiKeyLabel = $("api-key-label");
const apiKeyHint = $("api-key-hint");
const apiKeyInput = $("apiKey");
const baseUrlInput = $("baseUrl");
const modelInput = $("model");
const temperatureInput = $("temperature");
const maxTokensInput = $("maxTokens");
const maxStepsInput = $("maxSteps");
const toolModeInput = $("toolMode");
const visionInput = $("vision");
const nvidiaRateLimitInput = $("nvidiaRateLimit");
const nvidiaRateLimitRow = $("nvidia-rate-limit-row");
const googleTpmInput = $("googleTpm");
const googleRpdInput = $("googleRpd");
const googleRpmInput = $("googleRpm");
const googleRateLimitRow = $("google-rate-limit-row");
const ollamaSettings = $("ollama-settings");
const ollamaApiModeInput = $("ollamaApiMode");
const ollamaKeepAliveInput = $("ollamaKeepAlive");
const ollamaPresetInput = $("ollamaPreset");
const ollamaNumCtxInput = $("ollamaNumCtx");
const ollamaNumGpuInput = $("ollamaNumGpu");
const ollamaNumThreadInput = $("ollamaNumThread");
const ollamaNumBatchInput = $("ollamaNumBatch");
const ollamaNumKeepInput = $("ollamaNumKeep");
const ollamaNumPredictInput = $("ollamaNumPredict");
const ollamaTopKInput = $("ollamaTopK");
const ollamaTopPInput = $("ollamaTopP");
const ollamaMinPInput = $("ollamaMinP");
const ollamaRepeatPenaltyInput = $("ollamaRepeatPenalty");
const ollamaRepeatLastNInput = $("ollamaRepeatLastN");
const ollamaPresencePenaltyInput = $("ollamaPresencePenalty");
const ollamaFrequencyPenaltyInput = $("ollamaFrequencyPenalty");
const ollamaSeedInput = $("ollamaSeed");
const ollamaStopInput = $("ollamaStop");
const ollamaThinkInput = $("ollamaThink");
const ollamaFlashAttnInput = $("ollamaFlashAttn");
const ollamaKvCacheTypeInput = $("ollamaKvCacheType");
const ollamaUseMmapInput = $("ollamaUseMmap");
const ollamaUseMlockInput = $("ollamaUseMlock");
const ollamaRequestTimeoutMsInput = $("ollamaRequestTimeoutMs");
const ollamaIdleTimeoutMsInput = $("ollamaIdleTimeoutMs");
const permissionModeInput = $("permissionMode");
const blockedDomainsInput = $("blockedDomains");
const trustedDomainsInput = $("trustedDomains");
const blockTrackersInput = $("blockTrackers");
const trackerAllowlistInput = $("trackerAllowlist");
const antiBotGuardInput = $("antiBotGuard");
const actionDelayMsInput = $("actionDelayMs");
const systemPromptExtraInput = $("systemPromptExtra");
const statusEl = $("status");
const testButton = $("test");
const toggleKeyButton = $("toggle-key");
const clearKeyButton = $("clear-key");
const resetButton = $("reset");

let currentSettings = normalizeSettings({});

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function syncPacingControls() {
  actionDelayMsInput.disabled = !antiBotGuardInput.checked;
}

function syncProviderControls() {
  const provider = providerInput.value;
  nvidiaRateLimitRow.hidden = provider !== "nvidia";
  googleRateLimitRow.hidden = provider !== "google";
  ollamaSettings.hidden = provider !== "ollama";

  const requiresKey = providerRequiresApiKey(provider);
  apiKeyLabel.textContent = requiresKey ? "API key" : "API key (optional)";
  apiKeyHint.innerHTML = requiresKey
    ? "Stored in <code>chrome.storage.local</code> for this profile. It is sent only to the selected provider's base URL."
    : "Not needed for local Ollama. Set one only when Ollama is behind a proxy that requires a bearer token.";
}

function providerAccountFromForm() {
  return {
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim()
  };
}

function ollamaFromForm() {
  return {
    apiMode: ollamaApiModeInput.value,
    keepAlive: ollamaKeepAliveInput.value.trim(),
    numCtx: ollamaNumCtxInput.value,
    numGpu: ollamaNumGpuInput.value,
    numThread: ollamaNumThreadInput.value,
    numBatch: ollamaNumBatchInput.value,
    numKeep: ollamaNumKeepInput.value,
    numPredict: ollamaNumPredictInput.value,
    topK: ollamaTopKInput.value,
    topP: ollamaTopPInput.value,
    minP: ollamaMinPInput.value,
    repeatPenalty: ollamaRepeatPenaltyInput.value,
    repeatLastN: ollamaRepeatLastNInput.value,
    presencePenalty: ollamaPresencePenaltyInput.value,
    frequencyPenalty: ollamaFrequencyPenaltyInput.value,
    seed: ollamaSeedInput.value,
    stop: ollamaStopInput.value,
    think: ollamaThinkInput.value,
    flashAttn: ollamaFlashAttnInput.value,
    kvCacheType: ollamaKvCacheTypeInput.value,
    useMmap: ollamaUseMmapInput.checked,
    useMlock: ollamaUseMlockInput.checked,
    requestTimeoutMs: ollamaRequestTimeoutMsInput.value,
    idleTimeoutMs: ollamaIdleTimeoutMsInput.value
  };
}

function applyOllamaPreset(name) {
  const presets = {
    fast: {
      keepAlive: "30m",
      numCtx: 4096,
      numGpu: -1,
      numThread: 0,
      numBatch: 128,
      numKeep: 0,
      numPredict: 1024,
      topK: 20,
      topP: 0.8,
      minP: 0,
      repeatPenalty: 1.05,
      repeatLastN: 32,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: -1,
      think: "off",
      flashAttn: "auto",
      kvCacheType: "",
      useMmap: true,
      useMlock: false
    },
    balanced: {
      keepAlive: "5m",
      numCtx: 8192,
      numGpu: -1,
      numThread: 0,
      numBatch: 0,
      numKeep: 0,
      numPredict: 0,
      topK: 40,
      topP: 0.9,
      minP: 0,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: -1,
      think: "auto",
      flashAttn: "auto",
      kvCacheType: "",
      useMmap: true,
      useMlock: false
    },
    quality: {
      keepAlive: "5m",
      numCtx: 16384,
      numGpu: -1,
      numThread: 0,
      numBatch: 0,
      numKeep: 0,
      numPredict: 0,
      topK: 64,
      topP: 0.95,
      minP: 0.02,
      repeatPenalty: 1.15,
      repeatLastN: 128,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: -1,
      think: "auto",
      flashAttn: "auto",
      kvCacheType: "",
      useMmap: true,
      useMlock: false
    },
    cpu: {
      keepAlive: "30m",
      numCtx: 4096,
      numGpu: 0,
      numThread: 0,
      numBatch: 64,
      numKeep: 0,
      numPredict: 1024,
      topK: 20,
      topP: 0.8,
      minP: 0,
      repeatPenalty: 1.05,
      repeatLastN: 32,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: -1,
      think: "off",
      flashAttn: "off",
      kvCacheType: "",
      useMmap: true,
      useMlock: false
    }
  };
  const preset = presets[name];
  if (!preset) return;

  ollamaKeepAliveInput.value = preset.keepAlive;
  ollamaNumCtxInput.value = preset.numCtx;
  ollamaNumGpuInput.value = preset.numGpu;
  ollamaNumThreadInput.value = preset.numThread;
  ollamaNumBatchInput.value = preset.numBatch;
  ollamaNumKeepInput.value = preset.numKeep;
  ollamaNumPredictInput.value = preset.numPredict;
  ollamaTopKInput.value = preset.topK;
  ollamaTopPInput.value = preset.topP;
  ollamaMinPInput.value = preset.minP;
  ollamaRepeatPenaltyInput.value = preset.repeatPenalty;
  ollamaRepeatLastNInput.value = preset.repeatLastN;
  ollamaPresencePenaltyInput.value = preset.presencePenalty;
  ollamaFrequencyPenaltyInput.value = preset.frequencyPenalty;
  ollamaSeedInput.value = preset.seed;
  ollamaThinkInput.value = preset.think;
  ollamaFlashAttnInput.value = preset.flashAttn;
  ollamaKvCacheTypeInput.value = preset.kvCacheType;
  ollamaUseMmapInput.checked = preset.useMmap;
  ollamaUseMlockInput.checked = preset.useMlock;
}

function fillProviderFields(settings, provider) {
  const account = settings.providerAccounts?.[provider] || providerDefaults(provider);
  const preset = providerPreset(provider);

  providerInput.value = provider;
  apiKeyInput.value = account.apiKey || "";
  baseUrlInput.value = account.baseUrl || "";
  modelInput.value = account.model || "";
  apiKeyInput.placeholder = preset.keyPlaceholder;
  baseUrlInput.placeholder = preset.baseUrl || "https://example.com/v1";
  modelInput.placeholder = preset.modelPlaceholder;
  providerNote.textContent = preset.note || "";
  syncProviderControls();
}

function switchProvider(provider) {
  if (!Object.hasOwn(PROVIDERS, provider) || provider === currentSettings.provider) return;

  const providerAccounts = {
    ...currentSettings.providerAccounts,
    [currentSettings.provider]: providerAccountFromForm()
  };

  currentSettings = { ...currentSettings, provider, providerAccounts };
  fillProviderFields(currentSettings, provider);
}

function populate(settings) {
  currentSettings = settings;
  fillProviderFields(settings, settings.provider);
  temperatureInput.value = settings.temperature;
  maxTokensInput.value = settings.maxTokens;
  maxStepsInput.value = settings.maxSteps;
  toolModeInput.value = settings.toolMode;
  visionInput.checked = Boolean(settings.vision);
  nvidiaRateLimitInput.checked = settings.nvidiaRateLimit !== false;
  googleTpmInput.value = settings.googleTpm;
  googleRpdInput.value = settings.googleRpd;
  googleRpmInput.value = settings.googleRpm;
  const ollama = settings.ollama || {};
  ollamaApiModeInput.value = ollama.apiMode || "native";
  ollamaKeepAliveInput.value = ollama.keepAlive ?? "5m";
  ollamaPresetInput.value = "";
  ollamaNumCtxInput.value = ollama.numCtx ?? 8192;
  ollamaNumGpuInput.value = ollama.numGpu ?? -1;
  ollamaNumThreadInput.value = ollama.numThread ?? 0;
  ollamaNumBatchInput.value = ollama.numBatch ?? 0;
  ollamaNumKeepInput.value = ollama.numKeep ?? 0;
  ollamaNumPredictInput.value = ollama.numPredict ?? 0;
  ollamaTopKInput.value = ollama.topK ?? 40;
  ollamaTopPInput.value = ollama.topP ?? 0.9;
  ollamaMinPInput.value = ollama.minP ?? 0;
  ollamaRepeatPenaltyInput.value = ollama.repeatPenalty ?? 1.1;
  ollamaRepeatLastNInput.value = ollama.repeatLastN ?? 64;
  ollamaPresencePenaltyInput.value = ollama.presencePenalty ?? 0;
  ollamaFrequencyPenaltyInput.value = ollama.frequencyPenalty ?? 0;
  ollamaSeedInput.value = ollama.seed ?? -1;
  ollamaStopInput.value = ollama.stop || "";
  ollamaThinkInput.value = ollama.think || "auto";
  ollamaFlashAttnInput.value = ollama.flashAttn || "auto";
  ollamaKvCacheTypeInput.value = ollama.kvCacheType || "";
  ollamaUseMmapInput.checked = ollama.useMmap !== false;
  ollamaUseMlockInput.checked = Boolean(ollama.useMlock);
  ollamaRequestTimeoutMsInput.value = ollama.requestTimeoutMs ?? 180000;
  ollamaIdleTimeoutMsInput.value = ollama.idleTimeoutMs ?? 120000;
  permissionModeInput.value = settings.permissionMode;
  blockedDomainsInput.value = (settings.blockedDomains || []).join("\n");
  trustedDomainsInput.value = (settings.trustedDomains || []).join("\n");
  blockTrackersInput.checked = Boolean(settings.blockTrackers);
  trackerAllowlistInput.value = (settings.trackerAllowlist || []).join("\n");
  antiBotGuardInput.checked = Boolean(settings.antiBotGuard);
  actionDelayMsInput.value = settings.actionDelayMs;
  systemPromptExtraInput.value = settings.systemPromptExtra || "";
  syncPacingControls();
}

function readForm() {
  const provider = providerInput.value;
  const providerAccounts = {
    ...currentSettings.providerAccounts,
    [provider]: providerAccountFromForm()
  };

  return normalizeSettings({
    provider,
    providerAccounts,
    temperature: temperatureInput.value,
    maxTokens: maxTokensInput.value,
    maxSteps: maxStepsInput.value,
    toolMode: toolModeInput.value,
    vision: visionInput.checked,
    nvidiaRateLimit: nvidiaRateLimitInput.checked,
    googleTpm: googleTpmInput.value,
    googleRpd: googleRpdInput.value,
    googleRpm: googleRpmInput.value,
    ollama: ollamaFromForm(),
    permissionMode: permissionModeInput.value,
    blockedDomains: blockedDomainsInput.value,
    trustedDomains: trustedDomainsInput.value,
    blockTrackers: blockTrackersInput.checked,
    trackerAllowlist: trackerAllowlistInput.value,
    antiBotGuard: antiBotGuardInput.checked,
    actionDelayMs: actionDelayMsInput.value,
    systemPromptExtra: systemPromptExtraInput.value
  });
}

providerInput.addEventListener("change", () => switchProvider(providerInput.value));
antiBotGuardInput.addEventListener("change", syncPacingControls);
ollamaPresetInput.addEventListener("change", () => {
  applyOllamaPreset(ollamaPresetInput.value);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const saved = await saveSettings(readForm());
    populate(saved);
    setStatus("Saved.", "ok");
  } catch (error) {
    setStatus(String(error?.message || error), "err");
  }
});

testButton.addEventListener("click", async () => {
  const current = readForm();
  if (providerRequiresApiKey(current.provider) && !current.apiKey) {
    setStatus("Add an API key first.", "err");
    return;
  }

  testButton.disabled = true;
  setStatus("Testing…");

  const nativeOllama =
    current.provider === "ollama" && current.ollama?.apiMode !== "openai";
  const timeoutMs =
    current.provider === "ollama"
      ? Math.max(5000, Number(current.ollama?.requestTimeoutMs) || 180000)
      : 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Content-Type": "application/json" };
    if (current.apiKey) headers.Authorization = `Bearer ${current.apiKey}`;

    const body = nativeOllama
      ? {
          model: current.model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false,
          keep_alive: current.ollama?.keepAlive || "5m",
          options: {
            temperature: 0,
            num_predict: 16,
            num_ctx: Number(current.ollama?.numCtx) || 4096
          }
        }
      : {
          model: current.model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 16,
          temperature: 0,
          stream: false
        };

    const response = await fetch(chatCompletionsUrl(current), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      let detail = raw;
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.error || parsed?.detail || raw;
      } catch {
        // Keep raw text.
      }
      throw new Error(`HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    let content = "";
    try {
      const parsed = JSON.parse(raw);
      content = nativeOllama
        ? parsed?.message?.content || ""
        : parsed?.choices?.[0]?.message?.content || "";
    } catch {
      content = raw;
    }
    setStatus(`Connected. Model replied: ${String(content).trim().slice(0, 120) || "(empty)"}`, "ok");
  } catch (error) {
    let message =
      error?.name === "AbortError"
        ? `Test timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        : String(error?.message || error);

    if (
      current.provider === "ollama" &&
      /failed to fetch|networkerror|load failed/i.test(message)
    ) {
      message = `Could not reach Ollama at ${ollamaRootUrl(current.baseUrl)}. Start it with "ollama serve" and check the base URL. If it uses a custom host, allow this extension's origin in OLLAMA_ORIGINS.`;
    }
    setStatus(message, "err");
  } finally {
    clearTimeout(timer);
    testButton.disabled = false;
  }
});

toggleKeyButton.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleKeyButton.textContent = showing ? "Show" : "Hide";
});

clearKeyButton.addEventListener("click", async () => {
  try {
    const saved = await saveSettings({
      provider: providerInput.value,
      apiKey: ""
    });
    populate(saved);
    setStatus("API key cleared.", "ok");
  } catch (error) {
    setStatus(String(error?.message || error), "err");
  }
});

resetButton.addEventListener("click", async () => {
  if (!confirm("Reset every Beryy setting, including the API key?")) return;
  try {
    const saved = await saveSettings({ ...DEFAULT_SETTINGS });
    populate(saved);
    setStatus("Defaults restored.", "ok");
  } catch (error) {
    setStatus(String(error?.message || error), "err");
  }
});

async function init() {
  try {
    populate(await getSettings());
  } catch {
    populate(normalizeSettings({}));
  }
}

void init();
