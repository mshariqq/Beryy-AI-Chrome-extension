import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  defaultProviderAccounts,
  normalizeProvider,
  normalizeProviderAccount,
  providerDefaults
} from "./providers.js";

const DEFAULT_ACCOUNTS = defaultProviderAccounts();

export const DEFAULT_OLLAMA_SETTINGS = Object.freeze({
  apiMode: "native",
  keepAlive: "5m",
  numCtx: 8192,
  numPredict: 0,
  numGpu: -1,
  numThread: 0,
  numBatch: 0,
  numKeep: 0,
  topK: 40,
  topP: 0.9,
  minP: 0,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: -1,
  stop: "",
  think: "auto",
  flashAttn: "auto",
  kvCacheType: "",
  useMmap: true,
  useMlock: false,
  requestTimeoutMs: 180000,
  idleTimeoutMs: 120000
});

export const DEFAULT_SETTINGS = Object.freeze({
  provider: DEFAULT_PROVIDER,
  providerAccounts: DEFAULT_ACCOUNTS,
  baseUrl: DEFAULT_ACCOUNTS[DEFAULT_PROVIDER].baseUrl,
  apiKey: "",
  model: DEFAULT_ACCOUNTS[DEFAULT_PROVIDER].model,
  temperature: 0.2,
  maxTokens: 4096,
  maxSteps: 12,
  toolMode: "auto",
  vision: false,
  nvidiaRateLimit: true,
  googleTpm: 150000,
  googleRpd: 50,
  googleRpm: 10,
  ollama: DEFAULT_OLLAMA_SETTINGS,
  permissionMode: "ask",
  blockedDomains: [],
  trustedDomains: [],
  blockTrackers: true,
  trackerAllowlist: [],
  antiBotGuard: true,
  actionDelayMs: 450,
  systemPromptExtra: ""
});

function list(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function flag(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (value === undefined || value === null || value === "") return fallback;
  return Boolean(value);
}

function ollamaNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  return Math.round(clampNumber(value, fallback, min, max));
}

function ollamaFloat(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  return clampNumber(value, fallback, min, max);
}

export function normalizeOllamaSettings(input = {}) {
  const merged = {
    ...DEFAULT_OLLAMA_SETTINGS,
    ...(input && typeof input === "object" && !Array.isArray(input) ? input : {})
  };
  const keepAlive = String(merged.keepAlive ?? "").trim();
  const stop = Array.isArray(merged.stop)
    ? merged.stop.join("\n")
    : String(merged.stop ?? "");
  const apiMode = ["native", "openai"].includes(merged.apiMode)
    ? merged.apiMode
    : DEFAULT_OLLAMA_SETTINGS.apiMode;
  const think = ["auto", "on", "off", "low", "medium", "high"].includes(merged.think)
    ? merged.think
    : DEFAULT_OLLAMA_SETTINGS.think;
  const flashAttn = ["auto", "on", "off"].includes(merged.flashAttn)
    ? merged.flashAttn
    : DEFAULT_OLLAMA_SETTINGS.flashAttn;
  const kvCacheType = ["", "f16", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1"].includes(
    merged.kvCacheType
  )
    ? merged.kvCacheType
    : DEFAULT_OLLAMA_SETTINGS.kvCacheType;

  return {
    apiMode,
    keepAlive: /^(?:-1|\d+(?:\.\d+)?(?:ms|s|m|h)?)$/i.test(keepAlive)
      ? keepAlive
      : DEFAULT_OLLAMA_SETTINGS.keepAlive,
    numCtx: ollamaNumber(merged.numCtx, DEFAULT_OLLAMA_SETTINGS.numCtx, 512, 1048576),
    numPredict: ollamaNumber(merged.numPredict, DEFAULT_OLLAMA_SETTINGS.numPredict, 0, 65536),
    numGpu: ollamaNumber(merged.numGpu, DEFAULT_OLLAMA_SETTINGS.numGpu, -1, 1000),
    numThread: ollamaNumber(merged.numThread, DEFAULT_OLLAMA_SETTINGS.numThread, 0, 512),
    numBatch: ollamaNumber(merged.numBatch, DEFAULT_OLLAMA_SETTINGS.numBatch, 0, 8192),
    numKeep: ollamaNumber(merged.numKeep, DEFAULT_OLLAMA_SETTINGS.numKeep, 0, 65536),
    topK: ollamaNumber(merged.topK, DEFAULT_OLLAMA_SETTINGS.topK, 0, 1000),
    topP: ollamaFloat(merged.topP, DEFAULT_OLLAMA_SETTINGS.topP, 0, 1),
    minP: ollamaFloat(merged.minP, DEFAULT_OLLAMA_SETTINGS.minP, 0, 1),
    repeatPenalty: ollamaFloat(
      merged.repeatPenalty,
      DEFAULT_OLLAMA_SETTINGS.repeatPenalty,
      0,
      5
    ),
    repeatLastN: ollamaNumber(
      merged.repeatLastN,
      DEFAULT_OLLAMA_SETTINGS.repeatLastN,
      0,
      100000
    ),
    presencePenalty: ollamaFloat(
      merged.presencePenalty,
      DEFAULT_OLLAMA_SETTINGS.presencePenalty,
      -2,
      2
    ),
    frequencyPenalty: ollamaFloat(
      merged.frequencyPenalty,
      DEFAULT_OLLAMA_SETTINGS.frequencyPenalty,
      -2,
      2
    ),
    seed: ollamaNumber(merged.seed, DEFAULT_OLLAMA_SETTINGS.seed, -1, 2147483647),
    stop: stop.slice(0, 4000),
    think,
    flashAttn,
    kvCacheType,
    useMmap: flag(merged.useMmap, DEFAULT_OLLAMA_SETTINGS.useMmap),
    useMlock: flag(merged.useMlock, DEFAULT_OLLAMA_SETTINGS.useMlock),
    requestTimeoutMs: ollamaNumber(
      merged.requestTimeoutMs,
      DEFAULT_OLLAMA_SETTINGS.requestTimeoutMs,
      5000,
      1800000
    ),
    idleTimeoutMs: ollamaNumber(
      merged.idleTimeoutMs,
      DEFAULT_OLLAMA_SETTINGS.idleTimeoutMs,
      5000,
      1800000
    )
  };
}

function inferProvider(input) {
  if (Object.hasOwn(PROVIDERS, input.provider)) return input.provider;

  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  for (const [id, preset] of Object.entries(PROVIDERS)) {
    if (preset.baseUrl && baseUrl === preset.baseUrl) return id;
  }
  if (baseUrl) return "custom";
  return DEFAULT_PROVIDER;
}

function buildProviderAccounts(input, merged, provider) {
  const supplied =
    input.providerAccounts && typeof input.providerAccounts === "object"
      ? input.providerAccounts
      : null;
  const accounts = {};

  for (const id of Object.keys(PROVIDERS)) {
    const saved = supplied?.[id];
    const value = saved && typeof saved === "object" ? { ...saved } : providerDefaults(id);

    if (id === provider) {
      if (!supplied) {
        value.baseUrl = merged.baseUrl ?? providerDefaults(id).baseUrl;
        value.apiKey = merged.apiKey ?? "";
        value.model = merged.model ?? providerDefaults(id).model;
      } else {
        if (input.baseUrl !== undefined) value.baseUrl = input.baseUrl;
        if (input.apiKey !== undefined) value.apiKey = input.apiKey;
        if (input.model !== undefined) value.model = input.model;
      }
    }

    accounts[id] = normalizeProviderAccount(id, value);
  }

  return accounts;
}

export function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  const provider = inferProvider(input);
  const providerAccounts = buildProviderAccounts(input, merged, provider);
  const active = providerAccounts[provider];
  const toolMode = ["auto", "native", "prompt"].includes(merged.toolMode)
    ? merged.toolMode
    : "auto";
  const permissionMode = ["ask", "auto", "read_only"].includes(merged.permissionMode)
    ? merged.permissionMode
    : "ask";

  return {
    provider,
    providerAccounts,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    temperature: clampNumber(merged.temperature, DEFAULT_SETTINGS.temperature, 0, 2),
    maxTokens: Math.round(clampNumber(merged.maxTokens, DEFAULT_SETTINGS.maxTokens, 64, 65536)),
    maxSteps: Math.round(clampNumber(merged.maxSteps, DEFAULT_SETTINGS.maxSteps, 1, 800)),
    toolMode,
    vision: flag(merged.vision, DEFAULT_SETTINGS.vision),
    nvidiaRateLimit: flag(merged.nvidiaRateLimit, DEFAULT_SETTINGS.nvidiaRateLimit),
    googleTpm: Math.round(
      clampNumber(merged.googleTpm, DEFAULT_SETTINGS.googleTpm, 1000, 100000000)
    ),
    googleRpd: Math.round(
      clampNumber(merged.googleRpd, DEFAULT_SETTINGS.googleRpd, 1, 1000000)
    ),
    googleRpm: Math.round(
      clampNumber(merged.googleRpm, DEFAULT_SETTINGS.googleRpm, 1, 100000)
    ),
    ollama: normalizeOllamaSettings(merged.ollama),
    permissionMode,
    blockedDomains: list(merged.blockedDomains),
    trustedDomains: list(merged.trustedDomains),
    blockTrackers: flag(merged.blockTrackers, DEFAULT_SETTINGS.blockTrackers),
    trackerAllowlist: list(merged.trackerAllowlist),
    antiBotGuard: flag(merged.antiBotGuard, DEFAULT_SETTINGS.antiBotGuard),
    actionDelayMs: Math.round(
      clampNumber(merged.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs, 0, 5000)
    ),
    systemPromptExtra: String(merged.systemPromptExtra || "")
  };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored.settings || {});
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const requestedProvider = patch?.provider;
  const provider = requestedProvider
    ? normalizeProvider(requestedProvider, current.provider)
    : current.provider;
  let nextPatch = { ...patch, provider };

  if (provider !== current.provider) {
    const target =
      patch?.providerAccounts?.[provider] ||
      current.providerAccounts[provider] ||
      normalizeProviderAccount(provider);
    nextPatch = {
      ...nextPatch,
      baseUrl: patch.baseUrl ?? target.baseUrl,
      apiKey: patch.apiKey ?? target.apiKey,
      model: patch.model ?? target.model
    };
  } else if (patch?.providerAccounts?.[provider]) {
    const active = normalizeProviderAccount(provider, patch.providerAccounts[provider]);
    nextPatch = {
      ...nextPatch,
      baseUrl: patch.baseUrl ?? active.baseUrl,
      apiKey: patch.apiKey ?? active.apiKey,
      model: patch.model ?? active.model
    };
  }

  const next = normalizeSettings({ ...current, ...nextPatch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getPublicSettings() {
  const settings = await getSettings();
  const providerAccounts = Object.fromEntries(
    Object.entries(settings.providerAccounts).map(([provider, account]) => [
      provider,
      { ...account, apiKey: account.apiKey ? "configured" : "" }
    ])
  );

  return {
    ...settings,
    providerAccounts,
    apiKey: settings.apiKey ? "configured" : ""
  };
}
