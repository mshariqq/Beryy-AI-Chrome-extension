export const PROVIDERS = Object.freeze({
  nvidia: Object.freeze({
    id: "nvidia",
    label: "NVIDIA NIM",
    shortLabel: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    keyPlaceholder: "nvapi-…",
    modelPlaceholder: "meta/llama-3.3-70b-instruct",
    requiresApiKey: true,
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
    requiresApiKey: true,
    note: "Google's OpenAI-compatible Gemini endpoint. Gemma 4 26B A4B is faster and more stable on the free tier; Gemma 4 31B is also available. Free-tier content may be used to improve Google products."
  }),
  groq: Object.freeze({
    id: "groq",
    label: "Groq",
    shortLabel: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyPlaceholder: "gsk_...",
    modelPlaceholder: "openai/gpt-oss-120b",
    requiresApiKey: true,
    note: "Groq's OpenAI-compatible endpoint. The GPT-OSS 120B free tier is about 30 requests/min, 8K tokens/min, and 1,000 requests/day per organization. Beryy retries 429s automatically."
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    keyPlaceholder: "sk-or-v1-...",
    modelPlaceholder: "openrouter/free",
    requiresApiKey: true,
    note: "OpenRouter routes across many models. openrouter/free selects a free model that supports tool calling. Free tier: 20 requests/min and 50/day, or 1,000/day after $10 in credits. Enable free-model publication in OpenRouter privacy settings if prompted."
  }),
  ollama: Object.freeze({
    id: "ollama",
    label: "Ollama (local)",
    shortLabel: "Ollama",
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
    keyPlaceholder: "Optional (only for a secured proxy)",
    modelPlaceholder: "llama3.2",
    requiresApiKey: false,
    note: "Runs models on this computer. Start Ollama with `ollama serve`, then pull a model with `ollama pull llama3.2`. Beryy automatically fixes browser-origin checks for localhost; custom hosts or proxies may still need OLLAMA_ORIGINS."
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Custom endpoint",
    shortLabel: "Custom",
    baseUrl: "",
    model: "",
    keyPlaceholder: "API key",
    modelPlaceholder: "model-id",
    requiresApiKey: true,
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

export function providerRequiresApiKey(provider) {
  return providerPreset(provider).requiresApiKey !== false;
}

export function ollamaRootUrl(baseUrl = PROVIDERS.ollama.baseUrl) {
  return String(baseUrl || PROVIDERS.ollama.baseUrl)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
}

export function ollamaOpenAIBaseUrl(baseUrl = PROVIDERS.ollama.baseUrl) {
  return `${ollamaRootUrl(baseUrl)}/v1`;
}

export function chatCompletionsUrl(settings = {}) {
  if (settings.provider === "ollama") {
    if (settings.ollama?.apiMode === "openai") {
      return `${ollamaOpenAIBaseUrl(settings.baseUrl)}/chat/completions`;
    }
    return `${ollamaRootUrl(settings.baseUrl)}/api/chat`;
  }
  return `${String(settings.baseUrl || "").replace(/\/+$/, "")}/chat/completions`;
}

export function modelListUrl(settings = {}) {
  if (settings.provider === "ollama") {
    if (settings.ollama?.apiMode === "openai") {
      return `${ollamaOpenAIBaseUrl(settings.baseUrl)}/models`;
    }
    return `${ollamaRootUrl(settings.baseUrl)}/api/tags`;
  }
  return `${String(settings.baseUrl || "").replace(/\/+$/, "")}/models`;
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
