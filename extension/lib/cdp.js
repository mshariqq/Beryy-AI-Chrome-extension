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
      this.attached.set(tabId, { domains: new Set() });

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
    } catch (error) {
      this.attached.delete(tabId);
      throw error;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  async ensureDomain(tabId, domain) {
    const state = this.attached.get(tabId);
    if (!state) throw new Error(`Not attached to tab ${tabId}`);
    if (state.domains.has(domain)) return;
    await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
    state.domains.add(domain);
  }

  async send(tabId, method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    await this.ensureAttached(tabId);
    const domain = method.split(".")[0];
    if (domain) {
      try {
        await this.ensureDomain(tabId, domain);
      } catch {
        // Some methods (e.g. Input.*) have no enable command. That is fine.
      }
    }
    return withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      timeoutMs,
      `CDP ${method}`
    );
  }

  isAttached(tabId) {
    return this.attached.has(tabId);
  }

  markDetached(tabId) {
    this.attached.delete(tabId);
  }

  async detach(tabId) {
    this.attached.delete(tabId);
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
