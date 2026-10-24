import { CDP } from "./lib/cdp.js";
import { TabEventStore } from "./lib/events.js";
import { PermissionManager } from "./lib/permissions.js";
import { ScreenshotStore } from "./lib/screenshot.js";
import { TabManager } from "./lib/tabs.js";
import { executeTool } from "./lib/tools.js";
import { getSettings, saveSettings } from "./shared/settings.js";
import { domainFromUrl } from "./shared/policy.js";
import { nextActionDelay } from "./shared/pacing.js";
import {
  ALLOW_RULE_ID_START,
  TRACKER_RULESET_ID,
  buildTrackerAllowRules
} from "./shared/tracker-rules.js";

const cdp = new CDP();
const tabs = new TabManager();
const events = new TabEventStore();
const permissions = new PermissionManager();
const screenshots = new ScreenshotStore();
const ports = new Set();

const NO_TAB_TOOLS = new Set(["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp"]);

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // Port disconnected.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolContext(settings) {
  return { cdp, tabs, events, screenshots, settings };
}

let trackerSyncQueue = Promise.resolve();

async function applyTrackerSettings() {
  const settings = await getSettings();
  const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const enabled = enabledRulesets.includes(TRACKER_RULESET_ID);

  if (settings.blockTrackers && !enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [TRACKER_RULESET_ID]
    });
  } else if (!settings.blockTrackers && enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [TRACKER_RULESET_ID]
    });
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= ALLOW_RULE_ID_START)
    .map((rule) => rule.id);
  const addRules = settings.blockTrackers
    ? buildTrackerAllowRules(settings.trackerAllowlist)
    : [];

  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
  }
}

function syncTrackerRules() {
  const run = () =>
    applyTrackerSettings().catch((error) => {
      console.warn("Beryy: could not update tracker rules", error);
    });
  trackerSyncQueue = trackerSyncQueue.then(run, run);
  return trackerSyncQueue;
}

async function handleExecute(port, message) {
  const { id, tool } = message;
  const args = { ...(message.args || {}) };

  try {
    let tab = null;

    if (!NO_TAB_TOOLS.has(tool)) {
      const tabId = await tabs.resolveTabId(args.tabId);
      tab = await tabs.getTabInfo(tabId);
      args.tabId = tabId;
    } else if (tool === "tabs_close_mcp") {
      const first = Array.isArray(args.tabIds) ? args.tabIds[0] : args.tabId;
      if (first != null) {
        try {
          tab = await tabs.getTabInfo(first);
        } catch {
          tab = null;
        }
      }
    }

    const decision = await permissions.authorize({ tool, args, tab, port });
    if (!decision.allowed) {
      post(port, {
        type: "tool_error",
        id,
        error: decision.reason,
        permission: { host: decision.host, type: decision.permission }
      });
      return;
    }

    // The page can navigate while the user is deciding. Re-check the domain at
    // the last instant before the action so a redirect cannot turn an approved
    // click into a click on a different site.
    if (tab && decision.permission !== "control") {
      const fresh = await chrome.tabs.get(tab.tabId);
      const freshHost = domainFromUrl(fresh.url);
      const expectedHost = decision.host || domainFromUrl(tab.url);
      if (expectedHost && freshHost !== expectedHost) {
        throw new Error(
          `Blocked: the tab changed from ${expectedHost} to ${freshHost || "an unknown page"} after permission was granted. Ask the user before continuing.`
        );
      }
    }

    const result = await executeTool(toolContext(decision.settings), tool, args);
    const delay = nextActionDelay(decision.settings, tool, args);
    if (delay) await sleep(delay);
    post(port, {
      type: "tool_result",
      id,
      result,
      permission: { host: decision.host, type: decision.permission }
    });
  } catch (error) {
    post(port, {
      type: "tool_error",
      id,
      error: String(error?.message || error)
    });
  }
}

async function handlePortMessage(port, message) {
  if (!message || typeof message !== "object") return;

  try {
    switch (message.type) {
      case "permission_response": {
        permissions.respond(message.requestId, message.decision);
        return;
      }

      case "ping": {
        post(port, { type: "pong", id: message.id });
        return;
      }

      case "get_settings": {
        post(port, { type: "settings", settings: await getSettings() });
        return;
      }

      case "save_settings": {
        const settings = await saveSettings(message.patch || {});
        post(port, { type: "settings", settings });
        return;
      }

      case "get_tab_context": {
        post(port, {
          type: "tab_context",
          context: await tabs.context(Boolean(message.createIfEmpty))
        });
        return;
      }

      case "get_active_tab": {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        post(port, {
          type: "active_tab",
          tab: tab
            ? {
                tabId: tab.id,
                url: tab.url || "",
                title: tab.title || "",
                windowId: tab.windowId
              }
            : null
        });
        return;
      }

      case "resolve_tab": {
        const tabId = await tabs.resolveTabId(message.tabId);
        post(port, { type: "tab_info", tab: await tabs.getTabInfo(tabId) });
        return;
      }

      case "focus_tab": {
        await tabs.focus(message.tabId);
        post(port, { type: "focused", tabId: message.tabId });
        return;
      }

      case "clear_grants": {
        await permissions.clearGrants();
        post(port, { type: "grants_cleared" });
        return;
      }

      case "execute_tool": {
        await handleExecute(port, message);
        return;
      }

      default:
        post(port, { type: "error", error: `Unknown message type: ${message.type}` });
    }
  } catch (error) {
    post(port, {
      type: "error",
      id: message.id,
      error: String(error?.message || error)
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  ports.add(port);

  port.onMessage.addListener((message) => {
    void handlePortMessage(port, message);
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    permissions.cancelForPort(port);
  });

  post(port, { type: "ready" });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  events.handleEvent(source.tabId, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  cdp.markDetached(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.onRemoved(tabId);
  cdp.markDetached(tabId);
  events.dropTab(tabId);
});

async function bootstrap() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Older Chrome builds: the action click fallback below still works.
  }

  try {
    await chrome.sidePanel.setOptions({
      path: "sidepanel/index.html",
      enabled: true
    });
  } catch {
    // Ignore.
  }

  await tabs.recover();
  await syncTrackerRules();
  chrome.alarms.create("bery-recover", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void syncTrackerRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bery-recover") {
    void tabs.recover();
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

void bootstrap();

