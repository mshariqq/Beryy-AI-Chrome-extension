import {
  DEFAULT_SETTINGS,
  getSettings,
  normalizeSettings,
  saveSettings
} from "../shared/settings.js";
import {
  PROVIDERS,
  providerDefaults,
  providerPreset
} from "../shared/providers.js";

const $ = (id) => document.getElementById(id);

const form = $("settings-form");
const providerInput = $("provider");
const providerNote = $("provider-note");
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
  nvidiaRateLimitRow.hidden = providerInput.value !== "nvidia";
  googleRateLimitRow.hidden = providerInput.value !== "google";
}

function providerAccountFromForm() {
  return {
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim()
  };
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
  if (!current.apiKey) {
    setStatus("Add an API key first.", "err");
    return;
  }

  testButton.disabled = true;
  setStatus("Testing…");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${current.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${current.apiKey}`
      },
      body: JSON.stringify({
        model: current.model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 16,
        temperature: 0,
        stream: false
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      let detail = raw;
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.detail || raw;
      } catch {
        // Keep raw text.
      }
      throw new Error(`HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    let content = "";
    try {
      const parsed = JSON.parse(raw);
      content = parsed?.choices?.[0]?.message?.content || "";
    } catch {
      content = raw;
    }
    setStatus(`Connected. Model replied: ${String(content).trim().slice(0, 120) || "(empty)"}`, "ok");
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Test timed out after 30 seconds."
        : String(error?.message || error);
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
