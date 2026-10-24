# Beryy

A side-panel browser agent for Chrome that reads, clicks, types, and navigates the web — with your permission.

<p align="center">
  <img src="screenshots/beryy-screenshot1.png" alt="Beryy side panel in action" width="700">
  <br>
  <img src="screenshots/beryy-icon.png" alt="Beryy icon" width="128">
</p>

---

## Overview

Beryy lives in your browser's side panel. You give it a goal — *"Find the pricing page and extract the enterprise tier"* — and it drives the browser: scrolling, clicking, filling forms, taking screenshots, and reporting back. Every action requires your permission unless you explicitly grant trust.

**Key capabilities**

| Feature | Details |
|---------|---------|
| **Multi-provider LLM support** | NVIDIA NIM, Google AI Studio (Gemma), or any OpenAI-compatible endpoint |
| **Native tool use** | `navigate`, `read_page`, `find`, `form_input`, `click`, `scroll`, `get_page_text`, `tabs_context_mcp`, `switch_tab`, `close_tab`, `wait`, `screenshot` |
| **Vision** | Screenshots sent to vision-capable models (GPT-4o, Gemini, LLaVA, etc.) |
| **Auto context compaction** | Summarizes history at 85% context window; keeps recent 30%, compresses the rest |
| **Tracker blocking** | Declarative Net Request ruleset; allowlists for first-party assets |
| **Anti-bot pacing** | Human-like delays with jitter; respects domain rules |
| **Persistent chats** | Multi-conversation history with titles, restore on reload |
| **Granular permissions** | Ask / Trusted domains / Session grant / Read-only modes |
| **Dual provider accounts** | Separate API keys & models for NVIDIA and Google; switch instantly |
| **Rate limiting** | Optional 40 RPM guard for NVIDIA NIM |

---

## Quick Start

1. **Install**  
   ```bash
   git clone https://github.com/mshariqq/Beryy---AI-Chrome-extension.git
   cd Beryy---AI-Chrome-extension
   npm install
   ```
   - Open Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder

2. **Configure**  
   - Click the Beryy toolbar icon → **Options**  
   - Choose provider: **NVIDIA NIM**, **Google AI Studio**, or **Custom**  
   - Paste your API key, pick a model, save

3. **Run**  
   - Open the side panel (toolbar icon)  
   - Type a task: *"Go to example.com, find the pricing link, click it, and tell me the enterprise price"*  
   - Approve each action in the permission prompt (or pre-grant trust)

---

## Screenshots

| Side panel in action | Icon |
|----------------------|------|
| ![Side panel](screenshots/beryy-screenshot1.png) | ![Icon](screenshots/beryy-icon.png) |

---

## Architecture

```
extension/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker: side panel, DNR, tab mgmt
├── content/
│   └── content.js         # Injected script: DOM interaction, refs, clicks
├── sidepanel/
│   ├── index.html         # Side panel UI
│   ├── sidepanel.js       # UI controller, agent bridge
│   ├── agent.js           # Agent loop, tool execution, context mgmt
│   ├── provider.js        # LLM streaming, retries, rate limits
├── options/
│   ├── options.html       # Settings page
│   ├── options.js         # Provider/key/model management
│   └── options.css
├── shared/
│   ├── settings.js        # Settings schema, migration, validation
│   ├── providers.js       # Provider presets (NVIDIA, Google, Custom)
│   ├── vision.js          # Vision capability detection
│   ├── context.js         # Context estimation, compaction logic
│   ├── rate-limit.js      # NVIDIA 40 RPM sliding window
│   ├── tools.js           # Tool definitions & prompt specs
│   ├── prompt.js          # System prompt builder
│   ├── sse.js             # SSE parser for streaming
│   ├── pacing.js          # Anti-bot pacing
│   ├── policy.js          # Permission policies
│   └── tracker-rules.js   # Tracker rule utilities
├── rules/
│   └── trackers.json      # DNR tracker ruleset
└── lib/                   # Minimal polyfills (CDP, tabs, screenshot, etc.)
```

**Data flow**  
User input → `Agent.run()` → `buildMessages()` → `streamChat()` (retries, rate limits) → tool calls → `execute()` → DOM via content script → results → next loop.

---

## Providers

| Provider | Base URL | Default Model | Notes |
|----------|----------|---------------|-------|
| **NVIDIA NIM** | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` | 40 RPM limit (toggleable) |
| **Google AI Studio** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemma-4-26b-a4b-it` | Free tier; `gemma-4-31b-it` also available |
| **Custom** | Your OpenAI-compatible endpoint | — | Any `/v1/chat/completions` endpoint |

> **Vision**: Only sent when `settings.vision=true` **and** the model matches a known vision pattern (GPT-4o, Gemini, LLaVA, etc.). Text-only models (Llama 3.x, Nemotron 3/4, etc.) never receive screenshots.

---

## Settings Reference

| Setting | Description |
|---------|-------------|
| `provider` | Active provider: `nvidia`, `google`, `custom` |
| `providerAccounts` | Per-provider `{baseUrl, apiKey, model}` |
| `nvidiaRateLimit` | Enforce 40 RPM for NVIDIA (default: on) |
| `vision` | Enable screenshot upload for vision models |
| `toolMode` | `auto` (native tools) / `prompt` (XML fallback) |
| `maxSteps` | Max agent steps per turn (default: 20) |
| `maxTokens` | Output token limit |
| `temperature` | Sampling temperature |
| `blockedDomains` | Comma-separated domains to block |
| `trustedDomains` | Domains that auto-grant permission |
| `permissionMode` | `ask` / `trusted` / `session` / `read_only` |
| `pacingEnabled` | Human-like delay between actions |
| `baseDelayMs` / `jitterMs` | Pacing parameters |

---

## Testing

```bash
npm run verify   # lint + unit tests (95 tests)
```

Tests cover:
- Settings migration & validation
- Provider streaming, retries, rate limits
- Agent loop, tool execution, context compaction
- Vision gating, screenshot pruning
- Tracker blocking & DNR allowlist
- SSE parsing, tool-call extraction

---

## Security & Privacy

- **No telemetry** — zero network calls except to your configured LLM endpoint
- **API keys stored locally** in `chrome.storage.local` (never synced)
- **All URLs allowed** by `<all_urls>` host permission; you control which sites the agent visits
- **No hardcoded secrets** — placeholders only (`nvapi-…`, `AIza…`)
- **Content Security Policy** compliant — no inline scripts, no `eval`

---

## Contributing

1. Fork → feature branch → PR
2. `npm run verify` must pass
3. Follow existing code style (ES modules, no build step, vanilla JS)
4. Add tests for new behavior

---

## Developer

**SHA REEQ** — Developer from Hyderabad, India  
🌐 Portfolio: [https://mshariqq.github.io](https://mshariqq.github.io)  
💬 Contact: [WhatsApp](https://wa.me/917997807419)

---

## Support

If you find Beryy useful, consider buying me a coffee:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://wa.me/917997807419)

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgments

- Built for Chrome MV3 with side panel API
- Inspired by open-source browser agents and the open LLM ecosystem
- Tracker ruleset derived from public filter lists

---

<p align="center">
  <img src="screenshots/beryy-icon.png" alt="Beryy icon" width="128">
  <br>
  <strong>Beryy</strong> — Your browser, automated.
</p>