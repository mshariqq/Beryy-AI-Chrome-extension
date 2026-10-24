import { isScriptableUrl } from "../shared/policy.js";

const GROUP_TITLE = "Beryy";
const GROUP_COLOR = "blue";

export class TabManager {
  constructor() {
    this.tabGroupId = null;
    this.tabGroupTabs = new Set();
  }

  async recover() {
    try {
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
      if (!groups.length) return null;
      const group = groups[0];
      const tabs = await chrome.tabs.query({ groupId: group.id });
      this.tabGroupId = group.id;
      this.tabGroupTabs = new Set(tabs.map((tab) => tab.id));
      return group.id;
    } catch {
      return null;
    }
  }

  async ensureGroup(createIfEmpty = false) {
    // Always verify against live browser state: MV3 can evict the service
    // worker and every in-memory value with it.
    if (this.tabGroupId !== null) {
      try {
        const group = await chrome.tabGroups.get(this.tabGroupId);
        if (group && group.title === GROUP_TITLE) {
          const tabs = await chrome.tabs.query({ groupId: this.tabGroupId });
          this.tabGroupTabs = new Set(tabs.map((tab) => tab.id));
          if (this.tabGroupTabs.size > 0) return this.tabGroupId;
        }
      } catch {
        // Group is gone. Fall through and try to recover by title.
      }
      this.tabGroupId = null;
      this.tabGroupTabs.clear();
    }

    const recovered = await this.recover();
    if (recovered) return recovered;

    if (!createIfEmpty) return null;

    const target = await this.pickSeedTab();
    let tab = target;
    if (!tab) {
      const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: window.id });
    }

    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    this.tabGroupId = groupId;
    this.tabGroupTabs = new Set([tab.id]);
    return groupId;
  }

  async pickSeedTab() {
    let [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) {
      const [fallback] = await chrome.tabs.query({ active: true });
      active = fallback;
    }
    if (!active) return null;

    // Do not steal a tab the user already grouped, and do not try to script
    // chrome:// pages. In both cases a fresh blank tab is safer.
    if (active.groupId !== -1 || !isScriptableUrl(active.url)) return null;
    return active;
  }

  async context(createIfEmpty = false) {
    const groupId = await this.ensureGroup(createIfEmpty);
    if (groupId === null) {
      return { tabGroupId: null, tabs: [] };
    }

    const tabs = await chrome.tabs.query({ groupId });
    this.tabGroupTabs = new Set(tabs.map((tab) => tab.id));

    return {
      tabGroupId: groupId,
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        active: Boolean(tab.active),
        windowId: tab.windowId
      }))
    };
  }

  async isInGroup(tabId) {
    if (!Number.isFinite(Number(tabId))) return false;
    if (this.tabGroupId === null) await this.recover();
    if (this.tabGroupId === null) return false;
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      return tab.groupId === this.tabGroupId;
    } catch {
      return false;
    }
  }

  async resolveTabId(requested) {
    if (requested !== undefined && requested !== null && requested !== "") {
      const tabId = Number(requested);
      if (!(await this.isInGroup(tabId))) {
        throw new Error(
          `Tab ${tabId} is not in the Beryy tab group. Call tabs_context_mcp to see valid tab IDs.`
        );
      }
      return tabId;
    }

    const context = await this.context(false);
    if (!context.tabs.length) {
      throw new Error(
        "No Beryy tab group exists. Call tabs_context_mcp with createIfEmpty=true first."
      );
    }
    const active = context.tabs.find((tab) => tab.active);
    return (active || context.tabs[0]).tabId;
  }

  async getTabInfo(tabId) {
    const id = Number(tabId);
    if (!(await this.isInGroup(id))) {
      throw new Error(`Tab ${id} is not in the Beryy tab group.`);
    }
    const tab = await chrome.tabs.get(id);
    return {
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: Boolean(tab.active),
      windowId: tab.windowId,
      groupId: tab.groupId
    };
  }

  async createTab(url = "about:blank") {
    const context = await this.context(true);
    const first = context.tabs[0];
    const windowId =
      first?.windowId ??
      (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;

    const tab = await chrome.tabs.create({
      url: url || "about:blank",
      active: false,
      windowId
    });

    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: context.tabGroupId });
    } catch {
      // The group may have disappeared between context() and create. The new
      // tab still exists; the next tabs_context_mcp call will recover.
    }

    this.tabGroupTabs.add(tab.id);
    return tab;
  }

  async closeTabs(ids) {
    const closed = [];
    const skipped = [];
    for (const id of ids) {
      const tabId = Number(id);
      if (await this.isInGroup(tabId)) {
        await chrome.tabs.remove(tabId);
        closed.push(tabId);
        this.tabGroupTabs.delete(tabId);
      } else {
        skipped.push(tabId);
      }
    }
    if (this.tabGroupTabs.size === 0) this.tabGroupId = null;
    return { closed, skipped };
  }

  async focus(tabId) {
    const tab = await chrome.tabs.get(Number(tabId));
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return tab;
  }

  onRemoved(tabId) {
    this.tabGroupTabs.delete(Number(tabId));
    if (this.tabGroupTabs.size === 0) this.tabGroupId = null;
  }
}
