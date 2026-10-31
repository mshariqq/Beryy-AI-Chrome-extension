# Beryy + opencode — Complete Setup Guide

A step-by-step guide for new users. When you're done, an AI model running in your **opencode terminal** will be able to control your **real Chrome browser** through the Beryy extension — click, type, navigate, screenshot, and read pages, with Beryy's permission system still in charge.

This is the same integration model opencode uses for Playwright: a local MCP server. Beryy just points it at your everyday browser instead of a throwaway Chromium.

---

## What you will build

```
opencode chat  ──stdio──►  beryy-mcp.js  ──WebSocket──►  opencode-bridge.js  ──WebSocket──►  Beryy extension  ──►  your Chrome tabs
   (the model)              (MCP server)                  (local relay)                        (in Chrome)
```

- **You type in opencode**: *"Search for SHA REEQ in my browser"*
- **The model calls** the `navigate` tool → the bridge forwards it → the extension navigates a real tab → the model reads the page back to you.

---

## Prerequisites

| Requirement | Check with |
|---|---|
| Node.js 18+ | `node --version` |
| opencode installed | `opencode --version` |
| Google Chrome 116+ | — |
| A clone of this repo | `git clone https://github.com/mshariqq/Beryy-AI-Chrome-extension.git && cd Beryy-AI-Chrome-extension && npm install` |

---

## Step 1 — Load the Beryy extension into Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder of this repo
5. Keep this tab open — you'll reload the extension during setup

---

## Step 2 — Start the bridge

```bash
node opencode-bridge.js
```

Expected output:

```
[bridge] WebSocket server listening on ws://localhost:51777
[bridge] URL written to C:\Users\<you>\.beryy\ws-url
[bridge] Waiting for the Beryy extension to connect...
```

- Uses port 51777, falling back to 51778–51780 if busy.
- Keep this terminal open. Leave it running in the background whenever you use opencode + Beryy.

---

## Step 3 — Connect the extension to the bridge

1. Open the Beryy **side panel**: click the Beryy icon in the Chrome toolbar
2. The extension discovers the bridge automatically by probing ports 51777–51780
3. The bridge terminal should now print:

```
[bridge] Extension connected (chrome-extension://<your-id>)
```

If you don't see this:
- Reload the extension in `chrome://extensions`
- Open the background service worker console (`chrome://extensions` → Beryy → **Inspect views: service worker**) and look for `WS bridge: connected`

---

## Step 4 — Register Beryy as an MCP server in opencode

Create or edit **`opencode.json`** in your project root (or your global config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "beryy": {
      "type": "local",
      "command": ["node", "C:/path/to/Beryy-chrome-ext/opencode-tool/beryy-mcp.js"],
      "enabled": true
    }
  }
}
```

> Replace the path with your actual absolute path to `beryy-mcp.js`.

Then **restart opencode**. List your tools to confirm (`tools` command or ask the model) — you should see Beryy's browser tools.

---

## Step 5 — Use it

In the opencode chat, just talk normally:

- *"Open example.com in my browser and tell me what the page is about"*
- *"Search for SHA REEQ in my browser and summarize the results"*
- *"Read the page I have open and extract the prices"*

The model has these tools:

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | List (or create) the Beryy tab group — call first |
| `tabs_create_mcp` / `tabs_close_mcp` | Open / close tabs in the group |
| `navigate` | Go to a URL, or back/forward |
| `read_page` | Accessibility tree with stable element refs |
| `get_page_text` | Readable text of the page |
| `find` | Find elements by natural language ("the search bar") |
| `computer` | Click, type, key presses, scroll, screenshot, hover, drag |

The bridge also runs local tools itself: `read_file`, `write_file`, `list_files`, `run_command`.

---

## Step 6 — Permissions (important!)

Remote tool calls go through the **same permission system** as the side panel:

- **Ask mode (default)** — a permission prompt appears **in the Beryy side panel**. If the side panel is closed, permission-requiring tools are rejected with an error. Keep the side panel open while using opencode.
- **Trusted domains / session grants** — domains you've approved skip the prompt, from the side panel or settings.
- **Auto mode** — everything allowed; enable in Beryy **Options → Permissions** if you want zero prompts.
- Read-only actions (`read_page`, `get_page_text`, `find`, `tabs_context_mcp`) never prompt.

---

## Verify everything works

```bash
# Terminal 1 — bridge running
node opencode-bridge.js

# Terminal 2 — sanity checks
node test-bridge.js                                  # local tools + connection status
node opencode-tool/beryy-tool.js tabs_context_mcp createIfEmpty true   # creates/reuses the Beryy tab group
node opencode-tool/beryy-tool.js navigate url https://example.com      # watch a real tab navigate
```

Then in opencode chat: *"Search for SHA REEQ in my browser"*.

> **Windows tip:** passing JSON args like `'{"url": "…"}'` from PowerShell/cmd strips the quotes. Use the `key value` form (`navigate url https://example.com`) — the opencode MCP path is unaffected (JSON travels over stdio).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No extension connected` | Side panel not open, or bridge not running. Start the bridge, reload the extension, open the side panel. |
| Extension connects but tools time out | You're running old extension code. Reload in `chrome://extensions` after pulling. Check the service worker console for `WS bridge: connected`. |
| `Tabs can only be moved to and from normal windows` | Close DevTools windows or click into a normal Chrome window, then retry. |
| Tools don't appear in opencode | Check `opencode.json` syntax and the absolute path to `beryy-mcp.js`; restart opencode. |
| Tool rejected with "Permission is required" | Open the Beryy side panel and approve the prompt, or add the domain to trusted domains / switch to Auto mode. |
| Bridge port busy | It auto-falls back to 51778–51780; the extension probes the same range. |
| Who can connect? | Only Chrome extensions (by `Origin` header) and local Node clients. Web pages are rejected. Don't run the bridge on an untrusted machine — `run_command` executes locally. |

---

## How it works (for the curious)

- `opencode-bridge.js` — WebSocket relay. Connection roles come from the `Origin` header: `chrome-extension://…` = the extension, no origin (Node) = tool client, anything else = rejected. Forwards `executeTool` requests to the extension with a 120s timeout and keeps connections alive with 20s pings.
- `extension/shared/ws-bridge.js` — runs in the MV3 service worker, discovers the bridge by port probing, executes tools through the same permission-checked path as the side panel, and the regular traffic keeps the service worker alive.
- `opencode-tool/beryy-mcp.js` — MCP stdio server (newline-delimited JSON-RPC) exposing the tool catalog; opencode spawns it per session, exactly like `@playwright/mcp`.
- `opencode-tool/beryy-tool.js` — standalone CLI client for testing without opencode.

See `BRIDGE_README.md` for protocol details and `tests/bridge.test.js` for the wire format in action.
