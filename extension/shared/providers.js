export const PROVIDERS = Object.freeze({
  nvidia: Object.freeze({
    id: "nvidia",
    label: "NVIDIA NIM",
    shortLabel: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    keyPlaceholder: "nvapi-…",
    modelPlaceholder: "meta/llama-3.3-70b-instruct",
    note: "NVIDIA's OpenAI-compatible endpoint. Models must be enabled for your NVIDIA account."
  }),
  google: Object.freeze({
    id: "google",
    label: "Google AI Studio",
    shortLabel: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemma-4-26b-a4b-it",
    keyPlaceholder: "AIza…",
    modelPlaceholder: "gemma-4-26b-a4b-it",
    note: "Google's OpenAI-compatible Gemini endpoint. Gemma 4 26B A4B is faster and more stable on the free tier; Gemma 4 31B is also available. Free-tier content may be used to improve Google products."
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Custom endpoint",
    shortLabel: "Custom",
    baseUrl: "",
    model: "",
    keyPlaceholder: "API key",
    modelPlaceholder: "model-id",
    note: "Any OpenAI-compatible endpoint with a /chat/completions route."
  })
});

export const DEFAULT_PROVIDER = "nvidia";

export function normalizeProvider(value, fallback = DEFAULT_PROVIDER) {
  return Object.hasOwn(PROVIDERS, value) ? value : fallback;
}

export function providerPreset(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

export function providerLabel(provider) {
  return providerPreset(provider).label;
}

export function providerDefaults(provider) {
  const preset = providerPreset(provider);
  return {
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.model
  };
}

export function normalizeProviderAccount(provider, value = {}) {
  const preset = providerPreset(provider);
  const baseUrl = value?.baseUrl ?? preset.baseUrl;
  const model = value?.model ?? preset.model;

  return {
    baseUrl: String(baseUrl || preset.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: String(value?.apiKey ?? ""),
    model: String(model || preset.model)
  };
}

export function defaultProviderAccounts() {
  return Object.fromEntries(
    Object.keys(PROVIDERS).map((provider) => [
      provider,
      normalizeProviderAccount(provider, providerDefaults(provider))
    ])
  );
}
