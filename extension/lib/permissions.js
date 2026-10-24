import { getSettings } from "../shared/settings.js";
import {
  describeAction,
  domainFromUrl,
  evaluatePolicy,
  grantKey
} from "../shared/policy.js";

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const GRANTS_KEY = "beryGrants";

export class PermissionManager {
  constructor() {
    this.grants = new Set();
    this.pending = new Map();
    this.sequence = 0;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = await chrome.storage.session.get(GRANTS_KEY);
      for (const grant of stored[GRANTS_KEY] || []) this.grants.add(String(grant));
    } catch {
      // Session storage is best-effort; in-memory grants still work.
    }
  }

  async save() {
    try {
      await chrome.storage.session.set({ [GRANTS_KEY]: [...this.grants] });
    } catch {
      // Ignore quota/serialization issues.
    }
  }

  async authorize({ tool, args = {}, tab, port }) {
    await this.load();
    const settings = await getSettings();
    const host = tab?.url ? domainFromUrl(tab.url) : "";

    const decision = evaluatePolicy({
      mode: settings.permissionMode,
      host,
      tool,
      args,
      blockedDomains: settings.blockedDomains,
      trustedDomains: settings.trustedDomains,
      grants: [...this.grants]
    });

    if (!decision.needsPrompt) {
      return { ...decision, settings, host };
    }

    if (!port) {
      return {
        ...decision,
        allowed: false,
        settings,
        host,
        reason: "Permission is required, but no side panel is connected."
      };
    }

    const request = {
      requestId: `perm_${Date.now()}_${++this.sequence}`,
      tool,
      args,
      host,
      permission: decision.permission,
      action: describeAction(tool, args),
      reason: decision.reason,
      tab: tab
        ? {
            tabId: tab.tabId,
            title: tab.title,
            url: tab.url
          }
        : null
    };

    const answer = await this.ask(port, request);

    if (answer === "allow_once") {
      return {
        ...decision,
        allowed: true,
        needsPrompt: false,
        settings,
        host,
        reason: "Allowed once by the user."
      };
    }

    if (answer === "allow_domain") {
      this.grants.add(grantKey(host, "*"));
      await this.save();
      return {
        ...decision,
        allowed: true,
        needsPrompt: false,
        settings,
        host,
        reason: `Allowed for ${host || "this session"} by the user.`
      };
    }

    return {
      ...decision,
      allowed: false,
      needsPrompt: false,
      settings,
      host,
      reason: "The user denied permission for this action."
    };
  }

  ask(port, request) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve("deny");
      }, PROMPT_TIMEOUT_MS);

      this.pending.set(request.requestId, { resolve, timer, port });

      try {
        port.postMessage({ type: "permission_request", request });
      } catch {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        resolve("deny");
      }
    });
  }

  respond(requestId, decision) {
    const entry = this.pending.get(String(requestId));
    if (!entry) return false;
    this.pending.delete(String(requestId));
    clearTimeout(entry.timer);
    entry.resolve(["allow_once", "allow_domain"].includes(decision) ? decision : "deny");
    return true;
  }

  cancelForPort(port) {
    for (const [requestId, entry] of this.pending) {
      if (entry.port === port) {
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve("deny");
      }
    }
  }

  async clearGrants() {
    this.grants.clear();
    await this.save();
  }
}
