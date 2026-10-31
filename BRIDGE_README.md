# Beryy ↔ Opencode Bridge

This connects the Beryy Chrome extension to opencode's tool system via a WebSocket bridge, so a model running in opencode can control your real Chrome browser (navigation, clicks, typing, screenshots, accessibility tree) — the same way opencode integrates Playwright.

## How opencode + Playwright work (and how Beryy mirrors it)

opencode has no built-in browser. It launches **`@playwright/mcp`** as a local **MCP server** declared in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp@latest"]
    }
  }
}
```

Playwright MCP talks CDP to a Chromium instance and exposes tools (`browser_navigate`, `browser_snapshot` with element refs, `browser_click`, `browser_take_screenshot`, …). Beryy replaces the "drive a fresh Chromium via CDP" part with "drive your real Chrome via the Beryy extension", and ships its own MCP server instead.

## Architecture

```
┌──────────────────┐   WebSocket (role: extension)   ┌─────────────────────┐
│ Beryy extension  │ ◄──────────────────────────────► │  opencode-bridge.js │
│ (background SW)  │                                  │  (Node.js relay)    │
└──────────────────┘                                  └──────────┬──────────┘
        ▲                                                        │ stdio (MCP)
        │ chrome.debugger / tabs / scripting                     ▼
┌──────────────────┐                                  ┌─────────────────────┐
│ Your real tabs   │                                  │ opencode model      │
└──────────────────┘                                  └─────────────────────┘
```

- `opencode-bridge.js` — WebSocket relay. Connection roles are decided by the `Origin` header: `chrome-extension://…` = the extension (one at a time), no Origin (Node client) = tool, anything else = rejected (so web pages can't connect to `ws://localhost:51777` and drive your browser).
- `extension/shared/ws-bridge.js` — runs inside the background service worker, discovers the bridge by probing ports 51777–51780, and executes browser tools through the same permission-checked code path as the side panel. If the side panel is open, permission prompts appear there; otherwise permission-requiring tools are rejected.
- `opencode-tool/beryy-mcp.js` — MCP stdio server (JSON-RPC over newline-delimited JSON). This is what opencode launches.
- `opencode-tool/beryy-tool.js` — plain CLI client for testing without opencode.
- Local tools (`read_file`, `write_file`, `list_files`, `run_command`) are executed by the bridge process itself.

## Quick Start

### 1. Start the bridge

```bash
node opencode-bridge.js
```

It listens on port 51777 (falls back to 51778–51780) and writes the URL to `~/.beryy/ws-url`.

### 2. Open the Beryy sidepanel

Click the Beryy icon in Chrome. The extension discovers and connects to the bridge automatically. Bridge logs show `Extension connected (chrome-extension://…)`.

### 3. Register the MCP server with opencode

Add to `opencode.json` (project root or global config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "beryy": {
      "type": "local",
      "command": ["node", "C:/Users/user/Dev/Beryy-chrome-ext/opencode-tool/beryy-mcp.js"],
      "enabled": true
    }
  }
}
```

Restart opencode. The Beryy tools (`navigate`, `computer`, `read_page`, `find`, `tabs_*`, …) now appear alongside the built-in tools.

### Testing without opencode

```bash
node test-bridge.js
node opencode-tool/beryy-tool.js tabs_context_mcp '{"createIfEmpty": true}'
node opencode-tool/beryy-tool.js find '{"query": "search bar"}'
```

## Message protocol (WebSocket)

```jsonc
// request
{ "type": "request", "id": "ext_1", "method": "executeTool", "params": { "tool": "navigate", "args": { "url": "https://example.com" } } }
// response
{ "type": "response", "id": "ext_1", "payload": { "ok": true, "result": { "navigated": true } } }
// notification
{ "type": "notification", "method": "extension_status", "params": { "connected": true } }
```

Methods on the bridge: `executeTool`, `ping`, `status`. Keepalive `ping` notifications flow every 20s (this also keeps the MV3 service worker alive).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No extension connected" | Open the Beryy sidepanel; check the background service worker console for `WS bridge:` logs |
| Bridge port busy | The bridge falls back to 51778–51780 automatically; the extension probes the same range |
| Tools appear in opencode but time out | Make sure `node opencode-bridge.js` is running and the sidepanel is open |
| Permission prompts | Remote tool calls follow the same permission model as the side panel. Open the sidepanel to approve prompts, or loosen the permission mode in Beryy settings |
| Security | The bridge rejects any WebSocket connection with a web-page `Origin`. It also runs `run_command`/`write_file` locally — only run it on a trusted machine |

## Note on the native messaging host

The `native/` directory and `install-native-host.js` are an earlier discovery mechanism (native messaging instead of port probing) that the current code does not use. Port probing is what actually happens. They can be removed without affecting the bridge.
