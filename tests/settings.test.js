import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  getSettings,
  normalizeSettings,
  saveSettings
} from "../extension/shared/settings.js";

function mockStorage(initial = {}) {
  const store = { settings: JSON.parse(JSON.stringify(initial)) };

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: JSON.parse(JSON.stringify(store[key])) } : {};
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            store[key] = JSON.parse(JSON.stringify(value));
          }
        }
      }
    }
  };

  return store;
}

test("normalizeSettings returns defaults for empty input", () => {
  const settings = normalizeSettings({});
  assert.deepEqual(settings, { ...DEFAULT_SETTINGS });
});

test("normalizeSettings clamps numeric fields", () => {
  const settings = normalizeSettings({
    temperature: 99,
    maxTokens: 1,
    maxSteps: 1000
  });
  assert.equal(settings.temperature, 2);
  assert.equal(settings.maxTokens, 64);
  assert.equal(settings.maxSteps, 800);

  const low = normalizeSettings({
    temperature: -5,
    maxTokens: 999999,
    maxSteps: 0
  });
  assert.equal(low.temperature, 0);
  assert.equal(low.maxTokens, 65536);
  assert.equal(low.maxSteps, 1);
});

test("normalizeSettings validates enums", () => {
  const settings = normalizeSettings({
    toolMode: "invalid",
    permissionMode: "invalid"
  });
  assert.equal(settings.toolMode, "auto");
  assert.equal(settings.permissionMode, "ask");

  assert.equal(normalizeSettings({ toolMode: "prompt" }).toolMode, "prompt");
  assert.equal(
    normalizeSettings({ permissionMode: "read_only" }).permissionMode,
    "read_only"
  );
});

test("normalizeSettings parses domain lists", () => {
  const fromString = normalizeSettings({
    blockedDomains: "a.com\n b.com, c.com\n\n",
    trustedDomains: ["d.com", " e.com ", ""],
    trackerAllowlist: "tracker.example\n*.trusted.example"
  });
  assert.deepEqual(fromString.blockedDomains, ["a.com", "b.com", "c.com"]);
  assert.deepEqual(fromString.trustedDomains, ["d.com", "e.com"]);
  assert.deepEqual(fromString.trackerAllowlist, ["tracker.example", "*.trusted.example"]);

  const fromArray = normalizeSettings({ blockedDomains: ["x.com", "y.com"] });
  assert.deepEqual(fromArray.blockedDomains, ["x.com", "y.com"]);
});

test("normalizeSettings handles tracker and pacing fields", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.blockTrackers, true);
  assert.equal(defaults.antiBotGuard, true);
  assert.equal(defaults.actionDelayMs, 450);
  assert.deepEqual(defaults.trackerAllowlist, []);

  const custom = normalizeSettings({
    blockTrackers: false,
    antiBotGuard: "off",
    actionDelayMs: 99999
  });
  assert.equal(custom.blockTrackers, false);
  assert.equal(custom.antiBotGuard, false);
  assert.equal(custom.actionDelayMs, 5000);

  assert.equal(normalizeSettings({ actionDelayMs: -1 }).actionDelayMs, 0);
  assert.equal(normalizeSettings({ antiBotGuard: "yes" }).antiBotGuard, true);
});

test("normalizeSettings trims the base URL and keeps the API key", () => {
  const settings = normalizeSettings({
    baseUrl: "https://example.com/v1///",
    apiKey: "  secret  ",
    vision: 1
  });
  assert.equal(settings.baseUrl, "https://example.com/v1");
  assert.equal(settings.apiKey, "  secret  ");
  assert.equal(settings.vision, true);
});

test("normalizeSettings preserves an empty model fallback", () => {
  const settings = normalizeSettings({ model: "" });
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
});

test("normalizeSettings includes provider defaults", () => {
  const settings = normalizeSettings({});

  assert.equal(settings.provider, "nvidia");
  assert.equal(settings.providerAccounts.nvidia.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(settings.providerAccounts.google.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(settings.providerAccounts.google.model, "gemma-4-26b-a4b-it");
  assert.equal(settings.providerAccounts.groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(settings.providerAccounts.groq.model, "openai/gpt-oss-120b");
  assert.equal(settings.providerAccounts.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(settings.providerAccounts.openrouter.model, "openrouter/free");
});

test("getSettings migrates Groq and OpenRouter base URLs", async () => {
  mockStorage({
    baseUrl: "https://api.groq.com/openai/v1/",
    apiKey: "groq-key",
    model: "openai/gpt-oss-20b"
  });
  const groq = await getSettings();
  assert.equal(groq.provider, "groq");
  assert.equal(groq.apiKey, "groq-key");
  assert.equal(groq.model, "openai/gpt-oss-20b");

  mockStorage({
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKey: "openrouter-key",
    model: "openrouter/free"
  });
  const openrouter = await getSettings();
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.apiKey, "openrouter-key");
  assert.equal(openrouter.model, "openrouter/free");
});

test("normalizeSettings accepts the NVIDIA rate limit toggle", () => {
  assert.equal(normalizeSettings({}).nvidiaRateLimit, true);
  assert.equal(normalizeSettings({ nvidiaRateLimit: false }).nvidiaRateLimit, false);
  assert.equal(normalizeSettings({ nvidiaRateLimit: "off" }).nvidiaRateLimit, false);
});

test("normalizeSettings includes configurable Google TPM, RPD, and RPM", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.googleTpm, 150000);
  assert.equal(defaults.googleRpd, 50);
  assert.equal(defaults.googleRpm, 10);

  const custom = normalizeSettings({
    googleTpm: "200000",
    googleRpd: "100",
    googleRpm: "20"
  });
  assert.equal(custom.googleTpm, 200000);
  assert.equal(custom.googleRpd, 100);
  assert.equal(custom.googleRpm, 20);

  const clamped = normalizeSettings({
    googleTpm: 1,
    googleRpd: 0,
    googleRpm: 999999
  });
  assert.equal(clamped.googleTpm, 1000);
  assert.equal(clamped.googleRpd, 1);
  assert.equal(clamped.googleRpm, 100000);
});

test("normalizeSettings switches the active provider without losing the other account", () => {
  const settings = normalizeSettings({
    provider: "google",
    providerAccounts: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "nv-key",
        model: "meta/llama-3.3-70b-instruct"
      },
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "google-key",
        model: "gemma-4-31b-it"
      }
    }
  });

  assert.equal(settings.provider, "google");
  assert.equal(settings.apiKey, "google-key");
  assert.equal(settings.model, "gemma-4-31b-it");
  assert.equal(settings.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(settings.providerAccounts.nvidia.apiKey, "nv-key");
});

test("getSettings migrates a legacy custom endpoint", async () => {
  mockStorage({
    baseUrl: "https://example.com/v1///",
    apiKey: "legacy-key",
    model: "legacy-model"
  });

  const settings = await getSettings();
  assert.equal(settings.provider, "custom");
  assert.equal(settings.baseUrl, "https://example.com/v1");
  assert.equal(settings.apiKey, "legacy-key");
  assert.equal(settings.providerAccounts.custom.model, "legacy-model");
  assert.equal(settings.providerAccounts.nvidia.apiKey, "");
});

test("getSettings migrates a legacy Google endpoint to the Google provider", async () => {
  mockStorage({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKey: "google-key",
    model: "gemma-4-31b-it"
  });

  const settings = await getSettings();
  assert.equal(settings.provider, "google");
  assert.equal(settings.model, "gemma-4-31b-it");
  assert.equal(settings.providerAccounts.google.apiKey, "google-key");
});

test("saveSettings switches between Groq and OpenRouter accounts", async () => {
  mockStorage({
    provider: "groq",
    providerAccounts: {
      groq: {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "groq-key",
        model: "openai/gpt-oss-120b"
      },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "openrouter-key",
        model: "openrouter/free"
      }
    },
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "groq-key",
    model: "openai/gpt-oss-120b"
  });

  const openrouter = await saveSettings({ provider: "openrouter" });
  assert.equal(openrouter.apiKey, "openrouter-key");
  assert.equal(openrouter.model, "openrouter/free");
  assert.equal(openrouter.providerAccounts.groq.apiKey, "groq-key");

  const groq = await saveSettings({ provider: "groq" });
  assert.equal(groq.apiKey, "groq-key");
  assert.equal(groq.model, "openai/gpt-oss-120b");
  assert.equal(groq.providerAccounts.openrouter.apiKey, "openrouter-key");
});

test("saveSettings switches providers and keeps per-provider credentials", async () => {
  mockStorage({
    provider: "nvidia",
    providerAccounts: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "nv-key",
        model: "meta/llama-3.3-70b-instruct"
      },
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "google-key",
        model: "gemma-4-31b-it"
      }
    },
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "nv-key",
    model: "meta/llama-3.3-70b-instruct"
  });

  const google = await saveSettings({ provider: "google" });
  assert.equal(google.apiKey, "google-key");
  assert.equal(google.model, "gemma-4-31b-it");
  assert.equal(google.providerAccounts.nvidia.apiKey, "nv-key");

  const changed = await saveSettings({ model: "gemma-4-31b-it-preview" });
  assert.equal(changed.provider, "google");
  assert.equal(changed.model, "gemma-4-31b-it-preview");
  assert.equal(changed.providerAccounts.google.model, "gemma-4-31b-it-preview");
  assert.equal(changed.providerAccounts.nvidia.model, "meta/llama-3.3-70b-instruct");

  const nvidia = await saveSettings({ provider: "nvidia" });
  assert.equal(nvidia.apiKey, "nv-key");
  assert.equal(nvidia.model, "meta/llama-3.3-70b-instruct");
  assert.equal(nvidia.providerAccounts.google.apiKey, "google-key");
});
