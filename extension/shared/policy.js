export const PERMISSIONS = Object.freeze({
  READ: "read",
  NAVIGATE: "navigate",
  CLICK: "click",
  TYPE: "type",
  JAVASCRIPT: "javascript",
  UPLOAD: "upload",
  CONTROL: "control"
});

const READ_TOOLS = new Set([
  "tabs_context_mcp",
  "read_page",
  "get_page_text",
  "find",
  "read_console_messages",
  "read_network_requests"
]);

const CONTROL_TOOLS = new Set([
  "tabs_close_mcp",
  "resize_window",
  "set_tab_focus"
]);

const NO_PERMISSION_TOOLS = new Set(["tabs_context_mcp", "tabs_create_mcp"]);

const READ_ACTIONS = new Set(["screenshot", "scroll", "scroll_to", "zoom", "wait"]);
const TYPE_ACTIONS = new Set(["type", "key"]);
const CLICK_ACTIONS = new Set([
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "left_click_drag"
]);

export function domainFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol === "file:") return "file://";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isScriptableUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return ["http:", "https:", "file:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function normalizeDomainPattern(value) {
  let pattern = String(value || "").trim().toLowerCase();
  if (!pattern) return "";
  if (pattern.includes("://")) {
    try {
      pattern = new URL(pattern).hostname;
    } catch {
      // Keep the raw value and let matching fail closed.
    }
  }
  return pattern
    .replace(/^\*\./, "")
    .replace(/^\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

export function domainMatches(host, pattern) {
  const h = String(host || "").toLowerCase();
  const p = normalizeDomainPattern(pattern);
  if (!h || !p) return false;
  if (p === "file://") return h === "file://";
  return h === p || h.endsWith(`.${p}`);
}

export function findMatchingDomain(host, patterns = []) {
  for (const pattern of patterns) {
    if (domainMatches(host, pattern)) return pattern;
  }
  return null;
}

export function permissionTypeForTool(tool, args = {}) {
  if (READ_TOOLS.has(tool)) return PERMISSIONS.READ;
  if (NO_PERMISSION_TOOLS.has(tool)) return PERMISSIONS.READ;
  if (CONTROL_TOOLS.has(tool)) return PERMISSIONS.CONTROL;
  if (tool === "navigate") return PERMISSIONS.NAVIGATE;
  if (tool === "form_input") return PERMISSIONS.TYPE;
  if (tool === "javascript_tool") return PERMISSIONS.JAVASCRIPT;
  if (tool === "upload_image") return PERMISSIONS.UPLOAD;

  if (tool === "computer") {
    const action = String(args.action || "");
    if (READ_ACTIONS.has(action)) return PERMISSIONS.READ;
    if (TYPE_ACTIONS.has(action)) return PERMISSIONS.TYPE;
    if (CLICK_ACTIONS.has(action)) return PERMISSIONS.CLICK;
    return PERMISSIONS.CONTROL;
  }

  return PERMISSIONS.CONTROL;
}

export function isMutating(permission) {
  return permission !== PERMISSIONS.READ;
}

export function grantKey(host, permission) {
  return `${host || "browser"}|${permission || "*"}`;
}

export function hasGrant(host, permission, grants = []) {
  return (
    grants.includes(grantKey(host, "*")) ||
    grants.includes(grantKey(host, permission))
  );
}

export function evaluatePolicy({
  mode = "ask",
  host = "",
  tool = "",
  args = {},
  blockedDomains = [],
  trustedDomains = [],
  grants = []
} = {}) {
  const permission = permissionTypeForTool(tool, args);

  if (NO_PERMISSION_TOOLS.has(tool)) {
    return {
      allowed: true,
      needsPrompt: false,
      permission,
      host,
      reason: "Tool does not touch page content."
    };
  }

  if (host && findMatchingDomain(host, blockedDomains)) {
    return {
      allowed: false,
      needsPrompt: false,
      permission,
      host,
      reason: `${host} is blocked in Beryy settings.`
    };
  }

  if (mode === "auto") {
    return {
      allowed: true,
      needsPrompt: false,
      permission,
      host,
      reason: "Automatic mode allows this action."
    };
  }

  if (mode === "read_only") {
    if (permission === PERMISSIONS.READ) {
      return {
        allowed: true,
        needsPrompt: false,
        permission,
        host,
        reason: "Read-only mode allows page reads."
      };
    }
    return {
      allowed: false,
      needsPrompt: false,
      permission,
      host,
      reason: `Read-only mode blocks ${permission} actions. Switch permission mode in Beryy settings.`
    };
  }

  if (host && findMatchingDomain(host, trustedDomains)) {
    return {
      allowed: true,
      needsPrompt: false,
      permission,
      host,
      reason: `${host} is a trusted domain.`
    };
  }

  if (hasGrant(host, permission, grants)) {
    return {
      allowed: true,
      needsPrompt: false,
      permission,
      host,
      reason: "Previously allowed for this session."
    };
  }

  return {
    allowed: false,
    needsPrompt: true,
    permission,
    host,
    reason: `Beryy needs permission to ${permission}${host ? ` on ${host}` : ""}.`
  };
}

export function describeAction(tool, args = {}) {
  if (tool === "computer") {
    const action = args.action || "action";
    if (args.coordinate) return `${action} at (${args.coordinate.join(", ")})`;
    if (args.ref) return `${action} on ${args.ref}`;
    return action;
  }
  if (tool === "navigate") return `navigate to ${args.url || "a URL"}`;
  if (tool === "form_input") return `set ${args.ref || "a field"}`;
  if (tool === "javascript_tool") return "run JavaScript in the page";
  if (tool === "upload_image") return `attach an image to ${args.ref || "a file input"}`;
  return tool;
}
