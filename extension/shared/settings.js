import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  defaultProviderAccounts,
  normalizeProvider,
  normalizeProviderAccount,
  providerDefaults
} from "./providers.js";

const DEFAULT_ACCOUNTS = defaultProviderAccounts();

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

function inferProvider(input) {
  if (Object.hasOwn(PROVIDERS, input.provider)) return input.provider;

  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  if (baseUrl === PROVIDERS.google.baseUrl) return "google";
  if (baseUrl === PROVIDERS.nvidia.baseUrl) return DEFAULT_PROVIDER;
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
    maxSteps: Math.round(clampNumber(merged.maxSteps, DEFAULT_SETTINGS.maxSteps, 1, 40)),
    toolMode,
    vision: flag(merged.vision, DEFAULT_SETTINGS.vision),
    nvidiaRateLimit: flag(merged.nvidiaRateLimit, DEFAULT_SETTINGS.nvidiaRateLimit),
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
