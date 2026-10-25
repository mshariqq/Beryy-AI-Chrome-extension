const CDP_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class CDP {
  constructor() {
    this.attached = new Map();
    this.attaching = new Map();
    this.contexts = new Map();
  }

  async ensureAttached(tabId) {
    if (this.attached.has(tabId)) return;
    if (this.attaching.has(tabId)) return this.attaching.get(tabId);

    const attach = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (error) {
        const message = String(error?.message || error);
        if (message.includes("Another debugger is already attached")) {
          throw new Error(
            `Could not attach to tab ${tabId}: another debugger (DevTools) is already attached. Close DevTools for this tab and retry.`
          );
        }
        throw new Error(`Could not attach to tab ${tabId}: ${message}`);
      }

      // Do not inherit a viewport override from a previous build or another
      // debugger. Screenshots are clipped to CSS pixels in takeScreenshot.
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Emulation.clearDeviceMetricsOverride",
          {}
        );
      } catch {
        // Not fatal on browsers that do not expose this command.
      }

      // Let input land on background/unfocused tabs without stealing focus.
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Emulation.setFocusEmulationEnabled",
          { enabled: true }
        );
      } catch {
        // Older Chromium builds may not support this. Input can still work.
      }
    })();

    this.attaching.set(tabId, attach);
    try {
      await attach;
      this.attached.set(tabId, {
        domains: new Set(),
        sessionDomains: new Map(),
        sessionParents: new Map()
      });
      this.contexts.set(tabId, new Map());

      // Console and network tools read from chrome.debugger events, so turn
      // those domains on as soon as Beryy attaches to a tab.
      for (const domain of ["Runtime", "Log", "Network"]) {
        try {
          await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
          this.attached.get(tabId)?.domains.add(domain);
        } catch {
          // Not every Chromium build exposes every domain.
        }
      }

      // Same-process iframes share this target's execution contexts. OOPIFs
      // (cross-site iframes) need flat CDP sessions in Chrome 125+.
      try {
        await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }]
        });
      } catch {
        // Older Chromium browsers fall back to same-process iframe support.
      }
    } catch (error) {
      this.attached.delete(tabId);
      this.contexts.delete(tabId);
      throw error;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  async attachSession(tabId, sessionId) {
    if (!sessionId) return;
    const state = this.attached.get(tabId);
    if (!state) return;

    let domains = state.sessionDomains.get(sessionId);
    if (!domains) {
      domains = new Set();
      state.sessionDomains.set(sessionId, domains);
    }

    for (const domain of ["Runtime", "Page"]) {
      try {
        await chrome.debugger.sendCommand({ tabId, sessionId }, `${domain}.enable`, {});
        domains.add(domain);
      } catch {
        // The OOPIF may have navigated away before it was enabled.
      }
    }

    // Auto-attach is not recursive. Enable it again on each child session so
    // nested OOPIFs are also reachable.
    try {
      await chrome.debugger.sendCommand({ tabId, sessionId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }]
      });
    } catch {
      // Nested OOPIFs are unavailable on older Chromium builds.
    }
  }

  async ensureDomain(tabId, domain, sessionId = "") {
    const state = this.attached.get(tabId);
    if (!state) throw new Error(`Not attached to tab ${tabId}`);
    const domains = sessionId
      ? state.sessionDomains.get(sessionId) || new Set()
      : state.domains;
    if (domains.has(domain)) return;
    await chrome.debugger.sendCommand(
      sessionId ? { tabId, sessionId } : { tabId },
      `${domain}.enable`,
      {}
    );
    domains.add(domain);
    if (sessionId) state.sessionDomains.set(sessionId, domains);
  }

  async send(tabId, method, params = {}, timeoutMs = CDP_TIMEOUT_MS, sessionId = "") {
    await this.ensureAttached(tabId);
    const domain = method.split(".")[0];
    if (domain) {
      try {
        await this.ensureDomain(tabId, domain, sessionId);
      } catch {
        // Some methods (e.g. Input.*) have no enable command. That is fine.
      }
    }
    return withTimeout(
      chrome.debugger.sendCommand(
        sessionId ? { tabId, sessionId } : { tabId },
        method,
        params
      ),
      timeoutMs,
      `CDP ${method}`
    );
  }

  isAttached(tabId) {
    return this.attached.has(tabId);
  }

  handleEvent(tabId, method, params = {}, sessionId = "") {
    if (!tabId) return;
    let contexts = this.contexts.get(tabId);
    if (!contexts) {
      contexts = new Map();
      this.contexts.set(tabId, contexts);
    }

    if (method === "Target.attachedToTarget") {
      const childSessionId = params.sessionId;
      if (childSessionId) {
        const state = this.attached.get(tabId);
        if (state) {
          state.sessionDomains.set(childSessionId, new Set());
          state.sessionParents.set(childSessionId, sessionId || "");
        }
        this.attachSession(tabId, childSessionId);
      }
      return;
    }

    if (method === "Target.detachedFromTarget") {
      const childSessionId = params.sessionId;
      if (!childSessionId) return;
      for (const [key, context] of contexts) {
        if (context.sessionId === childSessionId) contexts.delete(key);
      }
      const state = this.attached.get(tabId);
      state?.sessionDomains.delete(childSessionId);
      state?.sessionParents.delete(childSessionId);
      return;
    }

    if (method === "Runtime.executionContextCreated" && params.context) {
      const context = params.context;
      const key = `${sessionId || "root"}:${context.id}`;
      contexts.set(key, {
        key,
        id: context.id,
        sessionId,
        origin: context.origin || "",
        name: context.name || "",
        frameId: context.auxData?.frameId || "",
        isDefault: Boolean(context.auxData?.isDefault)
      });
      return;
    }

    if (method === "Runtime.executionContextDestroyed" && params.executionContextId != null) {
      contexts.delete(`${sessionId || "root"}:${params.executionContextId}`);
      return;
    }

    if (method === "Runtime.executionContextsCleared") {
      if (!sessionId) {
        contexts.clear();
      } else {
        for (const [key, context] of contexts) {
          if (context.sessionId === sessionId) contexts.delete(key);
        }
      }
    }
  }

  executionContexts(tabId) {
    return [...(this.contexts.get(tabId)?.values() || [])];
  }

  sessionParent(tabId, sessionId) {
    if (!sessionId) return "";
    return this.attached.get(tabId)?.sessionParents.get(sessionId) || "";
  }

  markDetached(tabId) {
    this.attached.delete(tabId);
    this.contexts.delete(tabId);
  }

  async detach(tabId) {
    this.attached.delete(tabId);
    this.contexts.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached.
    }
  }

  async detachAll() {
    const ids = [...this.attached.keys()];
    await Promise.all(ids.map((tabId) => this.detach(tabId)));
  }
}
