function formatArg(arg) {
  if (!arg) return "";
  if (Object.prototype.hasOwnProperty.call(arg, "value")) {
    const value = arg.value;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (arg.unserializableValue) return String(arg.unserializableValue);
  if (arg.description) return String(arg.description);
  return String(arg.type || "");
}

function pushCapped(map, key, value, cap = 300) {
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  list.push(value);
  while (list.length > cap) list.shift();
}

export class TabEventStore {
  constructor() {
    this.consoleByTab = new Map();
    this.networkByTab = new Map();
  }

  handleEvent(tabId, method, params = {}) {
    if (!tabId) return;

    if (method === "Runtime.consoleAPICalled") {
      pushCapped(this.consoleByTab, tabId, {
        level: params.type || "log",
        text: (params.args || []).map(formatArg).join(" "),
        url: "",
        line: null,
        timestamp: Date.now()
      });
      return;
    }

    if (method === "Log.entryAdded" && params.entry) {
      const entry = params.entry;
      pushCapped(this.consoleByTab, tabId, {
        level: entry.level || "log",
        text: entry.text || "",
        url: entry.url || "",
        line: entry.lineNumber ?? null,
        timestamp: entry.timestamp || Date.now()
      });
      return;
    }

    if (method === "Network.requestWillBeSent" && params.request) {
      if (!this.networkByTab.has(tabId)) this.networkByTab.set(tabId, new Map());
      const requests = this.networkByTab.get(tabId);
      requests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url || "",
        method: params.request.method || "GET",
        type: params.type || "Other",
        status: null,
        mimeType: "",
        error: null,
        startedAt: Date.now()
      });
      while (requests.size > 300) {
        requests.delete(requests.keys().next().value);
      }
      return;
    }

    if (method === "Network.responseReceived" && params.response) {
      const request = this.networkByTab.get(tabId)?.get(params.requestId);
      if (request) {
        request.status = params.response.status ?? null;
        request.mimeType = params.response.mimeType || "";
        request.type = params.type || request.type;
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      const request = this.networkByTab.get(tabId)?.get(params.requestId);
      if (request) request.error = params.errorText || "failed";
    }
  }

  console(tabId) {
    return [...(this.consoleByTab.get(Number(tabId)) || [])];
  }

  network(tabId) {
    return [...(this.networkByTab.get(Number(tabId))?.values() || [])];
  }

  clearConsole(tabId) {
    this.consoleByTab.delete(Number(tabId));
  }

  clearNetwork(tabId) {
    this.networkByTab.delete(Number(tabId));
  }

  dropTab(tabId) {
    this.consoleByTab.delete(Number(tabId));
    this.networkByTab.delete(Number(tabId));
  }
}
