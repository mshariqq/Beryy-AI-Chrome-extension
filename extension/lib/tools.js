import { sendContent } from "./content.js";
import { takeRegionScreenshot, takeScreenshot } from "./screenshot.js";
import { formatTabContext } from "../shared/prompt.js";
import { domainFromUrl, findMatchingDomain } from "../shared/policy.js";

const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  shift: 8
};

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: { key: " ", code: "Space", vk: 32, text: " " }
};

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("url is required.");
  if (value === "back" || value === "forward") return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    cancel = () => finish(false);
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { promise, cancel };
}

function parseModifiers(value) {
  let mask = 0;
  for (const part of String(value || "").toLowerCase().split("+")) {
    if (MODIFIER_BITS[part]) mask |= MODIFIER_BITS[part];
  }
  return mask;
}

function keyInfo(raw) {
  const value = String(raw || "");
  const lower = value.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) {
    const n = Number(lower.slice(1));
    return { key: `F${n}`, code: `F${n}`, vk: 111 + n };
  }
  if (value.length === 1) {
    if (/[a-z]/i.test(value)) {
      const upper = value.toUpperCase();
      return { key: value, code: `Key${upper}`, vk: upper.charCodeAt(0), text: value };
    }
    if (/[0-9]/.test(value)) {
      return { key: value, code: `Digit${value}`, vk: value.charCodeAt(0), text: value };
    }
    return { key: value, code: "", vk: value.charCodeAt(0), text: value };
  }
  return { key: value, code: value, vk: 0 };
}

async function dispatchKey(cdp, tabId, combo, explicitModifiers = 0) {
  const parts = String(combo || "").split("+").filter(Boolean);
  let modifiers = explicitModifiers;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const bit = MODIFIER_BITS[parts[i].toLowerCase()];
    if (bit) modifiers |= bit;
  }
  const key = parts.length ? parts[parts.length - 1] : "";
  const info = keyInfo(key);
  const wantsText = Boolean(info.text) && modifiers === 0;

  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: wantsText ? "keyDown" : "rawKeyDown",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers,
    text: wantsText ? info.text : undefined
  });

  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers
  });
}

async function typeText(cdp, tabId, text) {
  const value = String(text ?? "");
  if (value.length > 500) {
    await cdp.send(tabId, "Input.insertText", { text: value });
    return;
  }

  for (const char of value) {
    if (char === "\n") {
      await dispatchKey(cdp, tabId, "Enter");
    } else {
      await cdp.send(tabId, "Input.insertText", { text: char });
    }
  }
}

async function mouseMove(cdp, tabId, x, y, modifiers = 0) {
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    modifiers
  });
}

async function mouseClick(cdp, tabId, x, y, options = {}) {
  const { button = "left", clickCount = 1, modifiers = 0 } = options;
  await mouseMove(cdp, tabId, x, y, modifiers);
  await sleep(120);
  for (let count = 1; count <= clickCount; count += 1) {
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: count,
      modifiers
    });
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: count,
      modifiers
    });
  }
}

function requireCoordinate(args, label = "coordinate") {
  const coordinate = args.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 2) {
    throw new Error(`${label} must be [x, y].`);
  }
  return [Number(coordinate[0]), Number(coordinate[1])];
}

export function coveredClickError(ref, point) {
  if (!point?.coveredBy) return "";
  return `${ref} is covered by ${point.coveredBy}. Dismiss that overlay, then call read_page again.`;
}

async function refPoint(tabId, ref) {
  const result = await sendContent(tabId, {
    type: "getRefCoordinates",
    ref,
    scrollIntoView: true
  });
  if (!result || !Number.isFinite(result.x) || !Number.isFinite(result.y)) {
    throw new Error(`Could not resolve ${ref}. Call read_page again to refresh refs.`);
  }

  const covered = coveredClickError(ref, result);
  if (covered) throw new Error(covered);

  return result;
}

function screenshotResult(shot, label, screenshots, vision) {
  const imageId = screenshots.add(shot.data);
  const dimensions = shot.width && shot.height ? ` (${shot.width}x${shot.height} CSS px)` : "";
  const visionNote = vision
    ? ""
    : " Vision is off, so this image is not visible to the model; use read_page, find, or get_page_text for page state.";
  return {
    content: [
      { type: "text", text: `${label}${dimensions} - ID: ${imageId}.${visionNote}` },
      { type: "image", data: shot.data, mimeType: shot.mimeType }
    ],
    meta: { imageId }
  };
}

async function getTabForTool(ctx, args) {
  const tabId = await ctx.tabs.resolveTabId(args.tabId);
  return { tabId, info: await ctx.tabs.getTabInfo(tabId) };
}

async function computer(ctx, args) {
  const { tabId } = await getTabForTool(ctx, args);
  const action = String(args.action || "");
  const modifiers = parseModifiers(args.modifiers);

  switch (action) {
    case "screenshot": {
      const shot = await takeScreenshot(ctx.cdp, tabId);
      return screenshotResult(shot, "Captured screenshot", ctx.screenshots, ctx.settings?.vision);
    }

    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      let x;
      let y;
      if (args.ref) {
        const point = await refPoint(tabId, args.ref);
        x = point.x;
        y = point.y;
      } else {
        [x, y] = requireCoordinate(args);
      }
      const clickCount =
        action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      await mouseClick(ctx.cdp, tabId, x, y, {
        button: action === "right_click" ? "right" : "left",
        clickCount,
        modifiers
      });

      // Wait for potential navigation after left clicks
      if (action === "left_click" || action === "double_click") {
        try {
          await waitForTabLoad(tabId, 8000);
        } catch {
          // Navigation timeout - continue anyway
        }
      }

      // Take screenshot after click so model can see result
      const shot = await takeScreenshot(ctx.cdp, tabId);
      const shotResult = screenshotResult(
        shot,
        `${action} at (${Math.round(x)}, ${Math.round(y)})`,
        ctx.screenshots,
        ctx.settings?.vision
      );
      return shotResult;
    }

    case "hover": {
      let x;
      let y;
      if (args.ref) {
        const point = await refPoint(tabId, args.ref);
        x = point.x;
        y = point.y;
      } else {
        [x, y] = requireCoordinate(args);
      }
      await mouseMove(ctx.cdp, tabId, x, y, modifiers);
      return textResult(`Hovered at (${Math.round(x)}, ${Math.round(y)})`);
    }

    case "type": {
      if (typeof args.text !== "string") throw new Error("text is required for type.");
      await typeText(ctx.cdp, tabId, args.text);
      return textResult(`Typed ${args.text.length} characters.`);
    }

    case "key": {
      if (!args.text) throw new Error("text is required for key (e.g. 'Enter' or 'ctrl+a').");
      const repeat = Math.max(1, Math.min(100, Number(args.repeat) || 1));
      for (let i = 0; i < repeat; i += 1) {
        await dispatchKey(ctx.cdp, tabId, args.text, modifiers);
      }
      return textResult(`Pressed ${args.text}${repeat > 1 ? ` ${repeat} times` : ""}.`);
    }

    case "wait": {
      const seconds = Math.max(0, Math.min(30, Number(args.duration) || 0));
      await sleep(seconds * 1000);
      return textResult(`Waited ${seconds} seconds.`);
    }

    case "scroll": {
      let x = 400;
      let y = 300;
      if (args.coordinate) [x, y] = requireCoordinate(args);
      const amount = Math.max(1, Math.min(10, Number(args.scroll_amount) || 3));
      const direction = String(args.scroll_direction || "down").toLowerCase();
      const delta = amount * 100;
      const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
      const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;

      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers
      });
      await sleep(350);
      const shot = await takeScreenshot(ctx.cdp, tabId);
      return screenshotResult(
        shot,
        `Scrolled ${direction} at (${x}, ${y})`,
        ctx.screenshots,
        ctx.settings?.vision
      );
    }

    case "scroll_to": {
      if (!args.ref) throw new Error("ref is required for scroll_to.");
      const result = await sendContent(tabId, { type: "scrollToRef", ref: args.ref });
      return textResult(`Scrolled ${args.ref} into view at (${Math.round(result.x)}, ${Math.round(result.y)}).`);
    }

    case "zoom": {
      if (!Array.isArray(args.region) || args.region.length !== 4) {
        throw new Error("region must be [x0, y0, x1, y1].");
      }
      const shot = await takeRegionScreenshot(ctx.cdp, tabId, args.region);
      return screenshotResult(shot, "Captured zoomed region", ctx.screenshots, ctx.settings?.vision);
    }

    case "left_click_drag": {
      if (!Array.isArray(args.start_coordinate) || args.start_coordinate.length !== 2) {
        throw new Error("start_coordinate must be [x, y].");
      }
      const [x1, y1] = args.start_coordinate.map(Number);
      let x2;
      let y2;
      if (args.ref) {
        const point = await refPoint(tabId, args.ref);
        x2 = point.x;
        y2 = point.y;
      } else {
        [x2, y2] = requireCoordinate(args);
      }

      await mouseMove(ctx.cdp, tabId, x1, y1, modifiers);
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: x1,
        y: y1,
        button: "left",
        clickCount: 1,
        modifiers
      });
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
          button: "left",
          modifiers
        });
      }
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x2,
        y: y2,
        button: "left",
        clickCount: 1,
        modifiers
      });
      return textResult(`Dragged from (${x1}, ${y1}) to (${Math.round(x2)}, ${Math.round(y2)}).`);
    }

    default:
      throw new Error(`Unknown computer action: ${action}`);
  }
}

function formatConsole(entries, limit) {
  if (!entries.length) return "No console messages captured for this tab.";
  return entries
    .slice(-limit)
    .map((entry) => {
      const location = entry.url ? ` (${entry.url}${entry.line != null ? `:${entry.line}` : ""})` : "";
      return `[${entry.level}] ${entry.text}${location}`;
    })
    .join("\n");
}

function formatNetwork(entries, limit) {
  if (!entries.length) return "No network requests captured for this tab.";
  return entries
    .slice(-limit)
    .map((entry) => {
      const status = entry.status ?? (entry.error ? `ERR ${entry.error}` : "pending");
      return `${entry.method} ${entry.url} -> ${status} [${entry.type}]`;
    })
    .join("\n");
}

export async function executeTool(ctx, tool, args = {}) {
  switch (tool) {
    case "tabs_context_mcp": {
      const context = await ctx.tabs.context(Boolean(args.createIfEmpty));
      return textResult(
        context.tabGroupId
          ? formatTabContext(context)
          : "No Beryy tab group yet. Call tabs_context_mcp with createIfEmpty=true to start one."
      );
    }

    case "tabs_create_mcp": {
      const tab = await ctx.tabs.createTab(args.url || "about:blank");
      return textResult(`Created tab ${tab.id}: ${tab.url || "about:blank"}`);
    }

    case "tabs_close_mcp": {
      let ids = [];
      if (Array.isArray(args.tabIds) && args.tabIds.length) ids = args.tabIds;
      else if (args.tabId != null) ids = [args.tabId];
      if (!ids.length) throw new Error("Provide tabId or tabIds.");

      const result = await ctx.tabs.closeTabs(ids);
      const parts = [];
      if (result.closed.length) parts.push(`Closed: ${result.closed.join(", ")}`);
      if (result.skipped.length) parts.push(`Skipped (not in group): ${result.skipped.join(", ")}`);
      return textResult(parts.join("\n") || "Nothing to close.");
    }

    case "navigate": {
      const { tabId } = await getTabForTool(ctx, args);
      const target = normalizeUrl(args.url);

      if (target === "back" || target === "forward") {
        const load = waitForTabLoad(tabId);
        try {
          if (target === "back") await chrome.tabs.goBack(tabId);
          else await chrome.tabs.goForward(tabId);
        } catch (error) {
          load.cancel();
          throw new Error(`Cannot go ${target}: ${error?.message || error}`);
        }
        const loaded = await load.promise;
        return textResult(`Went ${target} in tab ${tabId}${loaded ? "" : " (still loading)"}.`);
      }

      const host = domainFromUrl(target);
      if (host && findMatchingDomain(host, ctx.settings.blockedDomains)) {
        throw new Error(`${host} is blocked in Beryy settings.`);
      }

      const load = waitForTabLoad(tabId);
      try {
        await chrome.tabs.update(tabId, { url: target });
      } catch (error) {
        load.cancel();
        throw error;
      }
      const loaded = await load.promise;
      return textResult(
        `Navigated tab ${tabId} to ${target}${loaded ? "" : " (still loading - take a screenshot to check)"}.`
      );
    }

    case "computer":
      return computer(ctx, args);

    case "read_page": {
      const { tabId } = await getTabForTool(ctx, args);
      const tree = await sendContent(tabId, {
        type: "generateAccessibilityTree",
        options: {
          filter: args.filter || "all",
          depth: args.depth,
          max_chars: args.max_chars,
          ref_id: args.ref_id
        }
      });
      return textResult(tree);
    }

    case "get_page_text": {
      const { tabId } = await getTabForTool(ctx, args);
      const pageText = await sendContent(tabId, {
        type: "getPageText",
        maxChars: args.max_chars
      });
      return textResult(pageText);
    }

    case "find": {
      const { tabId } = await getTabForTool(ctx, args);
      const matches = await sendContent(tabId, {
        type: "findElements",
        query: String(args.query || "")
      });
      return textResult(matches);
    }

    case "form_input": {
      const { tabId } = await getTabForTool(ctx, args);
      if (!args.ref) throw new Error("ref is required for form_input.");
      const message = await sendContent(tabId, {
        type: "setFormInput",
        ref: args.ref,
        value: args.value
      });
      return textResult(message);
    }

    case "javascript_tool": {
      if (args.action && args.action !== "javascript_exec") {
        throw new Error("action must be javascript_exec.");
      }
      if (typeof args.text !== "string") throw new Error("text is required.");
      const { tabId } = await getTabForTool(ctx, args);
      const result = await ctx.cdp.send(tabId, "Runtime.evaluate", {
        expression: args.text,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        includeCommandLineAPI: true
      });

      if (result?.exceptionDetails) {
        const details = result.exceptionDetails;
        const description =
          details.exception?.description ||
          details.text ||
          "JavaScript threw an exception.";
        throw new Error(description);
      }

      const value = result?.result?.value;
      if (value === undefined) {
        return textResult(result?.result?.description || "undefined");
      }
      return textResult(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }

    case "read_console_messages": {
      const { tabId, info } = await getTabForTool(ctx, args);
      await ctx.cdp.send(tabId, "Runtime.enable", {}).catch(() => {});
      await ctx.cdp.send(tabId, "Log.enable", {}).catch(() => {});
      const host = domainFromUrl(info.url);
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      let entries = ctx.events.console(tabId);

      if (host) {
        entries = entries.filter((entry) => !entry.url || domainFromUrl(entry.url) === host);
      }
      if (args.onlyErrors) {
        entries = entries.filter((entry) => entry.level === "error" || entry.level === "assert");
      }
      if (args.pattern) {
        let matcher;
        try {
          matcher = new RegExp(String(args.pattern), "i");
        } catch {
          matcher = null;
        }
        entries = entries.filter((entry) =>
          matcher ? matcher.test(entry.text) : entry.text.includes(String(args.pattern))
        );
      }

      const output = formatConsole(entries, limit);
      if (args.clear) ctx.events.clearConsole(tabId);
      return textResult(output);
    }

    case "read_network_requests": {
      const { tabId } = await getTabForTool(ctx, args);
      await ctx.cdp.send(tabId, "Network.enable", {}).catch(() => {});
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      let entries = ctx.events.network(tabId);

      if (args.urlPattern) {
        let matcher;
        try {
          matcher = new RegExp(String(args.urlPattern), "i");
        } catch {
          matcher = null;
        }
        entries = entries.filter((entry) =>
          matcher ? matcher.test(entry.url) : entry.url.includes(String(args.urlPattern))
        );
      }

      const output = formatNetwork(entries, limit);
      if (args.clear) ctx.events.clearNetwork(tabId);
      return textResult(output);
    }

    case "resize_window": {
      const { info } = await getTabForTool(ctx, args);
      const width = Math.max(320, Number(args.width) || 1280);
      const height = Math.max(240, Number(args.height) || 800);
      await chrome.windows.update(info.windowId, { width, height });
      return textResult(`Resized window ${info.windowId} to ${width}x${height}.`);
    }

    case "set_tab_focus": {
      if (args.tabId == null) throw new Error("tabId is required.");
      const tab = await ctx.tabs.focus(args.tabId);
      return textResult(`Focused tab ${tab.id}.`);
    }

    case "upload_image": {
      const { tabId } = await getTabForTool(ctx, args);
      const data = ctx.screenshots.get(args.imageId);
      if (!data) throw new Error(`Unknown imageId ${args.imageId}. Take a new screenshot first.`);
      if (!args.ref) throw new Error("ref is required for upload_image.");
      const message = await sendContent(tabId, {
        type: "setFileInputFromDataUrl",
        ref: args.ref,
        dataUrl: `data:image/jpeg;base64,${data}`,
        filename: args.filename || "bery-screenshot.jpg"
      });
      return textResult(message);
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
