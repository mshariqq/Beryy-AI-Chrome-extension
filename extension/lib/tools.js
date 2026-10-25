import { sendContent, sendContentAll, sendContentToFrame, firstFrameResult, frameErrors, frameTokenFromRef } from "./content.js";
import { takeRegionScreenshot, takeScreenshot, viewport } from "./screenshot.js";
import { frameContextForToken, frameOffset } from "./frames.js";
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

function requireAbsolutePaths(paths) {
  const list = Array.isArray(paths)
    ? paths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!list.length) throw new Error("paths must contain at least one file path.");
  for (const filePath of list) {
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(filePath)) {
      throw new Error(`File path must be absolute: ${filePath}`);
    }
  }
  return list;
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

function waitAfterClick(tabId, previousUrl, graceMs = 800, loadMs = 8000) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;
    let loadTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(loadTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const watchLoad = () => {
      clearTimeout(graceTimer);
      if (!loadTimer) loadTimer = setTimeout(() => finish(true), loadMs);
    };
    const listener = (id, info, tab) => {
      if (id !== tabId || settled) return;
      if (info.status === "loading") {
        watchLoad();
        return;
      }
      if (info.status === "complete") {
        finish(true);
        return;
      }
      if (tab?.url && tab.url !== previousUrl) {
        clearTimeout(graceTimer);
        if (tab.status === "complete") finish(true);
        else watchLoad();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    graceTimer = setTimeout(() => finish(false), graceMs);
    cancel = () => finish(false);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (settled) return;
        if (tab.status === "loading") watchLoad();
        else if (tab.url && tab.url !== previousUrl) {
          if (tab.status === "complete") finish(true);
          else watchLoad();
        }
      })
      .catch(() => {});
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

async function dispatchKey(cdp, tabId, combo, explicitModifiers = 0, sessionId = "") {
  const parts = String(combo || "").split("+").filter(Boolean);
  let modifiers = explicitModifiers;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const bit = MODIFIER_BITS[parts[i].toLowerCase()];
    if (bit) modifiers |= bit;
  }
  const key = parts.length ? parts[parts.length - 1] : "";
  const info = keyInfo(key);
  const wantsText = Boolean(info.text) && modifiers === 0;

  await cdp.send(
    tabId,
    "Input.dispatchKeyEvent",
    {
      type: wantsText ? "keyDown" : "rawKeyDown",
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers,
      text: wantsText ? info.text : undefined
    },
    20000,
    sessionId
  );

  await cdp.send(
    tabId,
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers
    },
    20000,
    sessionId
  );
}

async function typeText(cdp, tabId, text, sessionId = "") {
  const value = String(text ?? "");
  if (value.length > 500) {
    await cdp.send(tabId, "Input.insertText", { text: value }, 20000, sessionId);
    return;
  }

  for (const char of value) {
    if (char === "\n") {
      await dispatchKey(cdp, tabId, "Enter", 0, sessionId);
    } else {
      await cdp.send(tabId, "Input.insertText", { text: char }, 20000, sessionId);
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

function shortValue(value) {
  if (typeof value === "boolean") return String(value);
  const text = String(value ?? "").replace(/\s+/g, " ").slice(0, 80);
  return `"${text}"`;
}

export function describeClickOutcome(before, after, navigated = false) {
  const parts = [];
  if (before?.description) parts.push(`Target: ${before.description}.`);
  if (navigated) {
    parts.push("Page navigated.");
    return parts.join(" ");
  }
  if (!before) return parts.join(" ");
  if (!after) {
    parts.push("The target was removed after the click.");
    return parts.join(" ");
  }

  const changes = [];
  if (before.description !== after.description) {
    changes.push(`target ${before.description} -> ${after.description}`);
  }
  const fields = [
    ["label", "ariaLabel"],
    ["pressed", "ariaPressed"],
    ["expanded", "ariaExpanded"],
    ["checked", "ariaChecked"],
    ["disabled", "disabled"],
    ["text", "text"]
  ];
  for (const [label, key] of fields) {
    if (String(before[key] ?? "") === String(after[key] ?? "")) continue;
    changes.push(`${label} ${shortValue(before[key])} -> ${shortValue(after[key])}`);
  }

  if (changes.length) {
    parts.push(`State changed: ${changes.join("; ")}.`);
  } else {
    parts.push(
      "No accessible state change detected; verify with find or read_page before claiming success."
    );
  }
  return parts.join(" ");
}

function frameFailure(results, fallback) {
  return new Error(frameErrors(results)[0] || fallback);
}

async function refPoint(ctx, tabId, ref) {
  const results = await sendContentAll(tabId, {
    type: "getRefCoordinates",
    ref,
    scrollIntoView: true
  });
  const hit = firstFrameResult(
    results,
    (entry) => Number.isFinite(entry.result?.x) && Number.isFinite(entry.result?.y)
  );
  if (!hit) {
    throw frameFailure(results, `Could not resolve ${ref}. Call read_page again to refresh refs.`);
  }

  let offset = { x: 0, y: 0 };
  if (!hit.frame?.isTopFrame) {
    offset = await frameOffset(ctx.cdp, tabId, hit.frame?.token || frameTokenFromRef(ref), {
      scrollIntoView: true
    }).catch(() => null);
    if (!offset) {
      throw new Error(`Could not locate the frame for ${ref}. Call read_page again to refresh refs.`);
    }
  }

  const x = hit.result.x + offset.x;
  const y = hit.result.y + offset.y;
  const vp = await viewport(ctx.cdp, tabId).catch(() => null);
  if (vp && (x < 0 || y < 0 || x >= vp.width || y >= vp.height)) {
    throw new Error(
      `${ref} is outside the visible viewport. Scroll the page so its frame is visible, then retry.`
    );
  }

  const covered = coveredClickError(ref, hit.result);
  if (covered) throw new Error(covered);

  return {
    ...hit.result,
    x,
    y,
    frameX: hit.result.x,
    frameY: hit.result.y,
    frameOffset: offset
  };
}

async function refState(tabId, ref) {
  const results = await sendContentAll(tabId, { type: "getRefState", ref });
  return firstFrameResult(results)?.result || null;
}

async function keyboardSession(ctx, tabId, ref) {
  const targetRef = String(ref || "").trim();
  if (targetRef) {
    const results = await sendContentAll(tabId, {
      type: "focusRef",
      ref: targetRef
    }).catch(() => []);
    const focused = firstFrameResult(results, (entry) => entry.result === true);
    if (!focused) {
      throw new Error(`Could not focus ${targetRef}. Call read_page again to refresh refs.`);
    }
    const token = frameTokenFromRef(targetRef);
    if (!token) return "";
    const context = await frameContextForToken(ctx.cdp, tabId, token).catch(() => null);
    return context?.sessionId || "";
  }

  const results = await sendContentAll(tabId, { type: "getFocusInfo" }).catch(() => []);
  const activeFrames = results.filter(
    (entry) => entry.ok && entry.result?.active && entry.result?.editable
  );
  const focused = activeFrames.find((entry) => entry.result.focused) || activeFrames[0];
  if (!focused || focused.result.isTopFrame) return "";
  const context = await frameContextForToken(
    ctx.cdp,
    tabId,
    focused.result.token
  ).catch(() => null);
  return context?.sessionId || "";
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
      let targetState = null;
      const ref = args.ref ? String(args.ref) : "";
      if (ref) {
        const point = await refPoint(ctx, tabId, ref);
        x = point.x;
        y = point.y;
        targetState = point.state || null;
      } else {
        [x, y] = requireCoordinate(args);
      }

      // Clamp coordinates to viewport bounds
      const vp = await viewport(ctx.cdp, tabId).catch(() => null);
      if (vp) {
        x = Math.max(0, Math.min(x, vp.width - 1));
        y = Math.max(0, Math.min(y, vp.height - 1));
      }

      if (!targetState) {
        targetState = await sendContent(tabId, {
          type: "getPointState",
          x,
          y
        }).catch(() => null);
      }

      const clickCount =
        action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      const before = await chrome.tabs.get(tabId).catch(() => null);
      await mouseClick(ctx.cdp, tabId, x, y, {
        button: action === "right_click" ? "right" : "left",
        clickCount,
        modifiers
      });

      // Wait for navigation only when the click actually starts one.
      let navigated = false;
      if (action === "left_click" || action === "double_click") {
        navigated = await waitAfterClick(tabId, before?.url || "").promise;
      }

      const afterState = ref
        ? await refState(tabId, ref).catch(() => null)
        : await sendContent(tabId, { type: "getPointState", x, y }).catch(() => null);
      const outcome = describeClickOutcome(targetState, afterState, navigated);

      // Take screenshot after click so model sees result
      const shot = await takeScreenshot(ctx.cdp, tabId);
      const shotResult = screenshotResult(
        shot,
        `${action} at (${Math.round(x)}, ${Math.round(y)})${outcome ? ` ${outcome}` : ""}`,
        ctx.screenshots,
        ctx.settings?.vision
      );
      return shotResult;
    }

    case "hover": {
      let x;
      let y;
      if (args.ref) {
        const point = await refPoint(ctx, tabId, args.ref);
        x = point.x;
        y = point.y;
      } else {
        [x, y] = requireCoordinate(args);
      }

      // Clamp coordinates to viewport bounds
      const vp = await viewport(ctx.cdp, tabId).catch(() => null);
      if (vp) {
        x = Math.max(0, Math.min(x, vp.width - 1));
        y = Math.max(0, Math.min(y, vp.height - 1));
      }

      await mouseMove(ctx.cdp, tabId, x, y, modifiers);
      return textResult(`Hovered at (${Math.round(x)}, ${Math.round(y)})`);
    }

    case "type": {
      if (typeof args.text !== "string") throw new Error("text is required for type.");
      const sessionId = await keyboardSession(ctx, tabId, args.ref);
      await typeText(ctx.cdp, tabId, args.text, sessionId);
      return textResult(`Typed ${args.text.length} characters.`);
    }

    case "key": {
      if (!args.text) throw new Error("text is required for key (e.g. 'Enter' or 'ctrl+a').");
      const repeat = Math.max(1, Math.min(100, Number(args.repeat) || 1));
      const sessionId = await keyboardSession(ctx, tabId, args.ref);
      for (let i = 0; i < repeat; i += 1) {
        await dispatchKey(ctx.cdp, tabId, args.text, modifiers, sessionId);
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
      const point = await refPoint(ctx, tabId, args.ref);
      return textResult(`Scrolled ${args.ref} into view at (${Math.round(point.x)}, ${Math.round(point.y)}).`);
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
        const point = await refPoint(ctx, tabId, args.ref);
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
      const results = await sendContentAll(tabId, {
        type: "generateAccessibilityTree",
        options: {
          filter: args.filter || "all",
          depth: args.depth,
          max_chars: args.max_chars,
          ref_id: args.ref_id
        }
      });

      if (args.ref_id) {
        const hit = firstFrameResult(
          results,
          (entry) =>
            typeof entry.result === "string" && !entry.result.startsWith("Error:")
        );
        if (!hit) {
          const reported = results.find(
            (entry) => entry.ok && typeof entry.result === "string"
          )?.result;
          throw new Error(
            reported || `${args.ref_id} was not found. Call read_page again.`
          );
        }
        return textResult(hit.result);
      }

      const frames = results
        .filter((entry) => entry.ok && typeof entry.result === "string")
        .sort(
          (a, b) =>
            (Number(a.frame?.depth) || 0) - (Number(b.frame?.depth) || 0) ||
            Number(Boolean(b.frame?.isTopFrame)) - Number(Boolean(a.frame?.isTopFrame))
        );
      const parts = [];
      for (const entry of frames) {
        const tree = entry.result.trim();
        if (!tree || tree === "No accessible elements found on this page.") continue;
        const label = entry.frame?.isTopFrame
          ? ""
          : `Frame: ${entry.frame?.url || "unknown"}${entry.frame?.title ? ` - ${entry.frame.title}` : ""}\n`;
        parts.push(`${label}${tree}`);
      }
      return textResult(parts.join("\n\n") || "No accessible elements found on this page.");
    }

    case "get_page_text": {
      const { tabId } = await getTabForTool(ctx, args);
      const limit = Math.max(100, Math.min(200000, Number(args.max_chars) || 50000));
      const results = await sendContentAll(tabId, {
        type: "getPageText",
        maxChars: limit
      });
      const frames = results
        .filter((entry) => entry.ok && typeof entry.result === "string" && entry.result.trim())
        .sort(
          (a, b) =>
            (Number(a.frame?.depth) || 0) - (Number(b.frame?.depth) || 0) ||
            Number(Boolean(b.frame?.isTopFrame)) - Number(Boolean(a.frame?.isTopFrame))
        );

      const top = frames.find((entry) => entry.frame?.isTopFrame);
      let output = top?.result || "";
      for (const entry of frames) {
        if (entry === top || output.length >= limit) continue;
        const text = entry.result.trim();
        if (text.length < 40) continue;
        const header = `\n\n--- Frame: ${entry.frame?.url || "unknown"} ---\n`;
        const remaining = limit - output.length - header.length;
        if (remaining <= 0) break;
        output += `${header}${text.slice(0, remaining)}`;
      }
      return textResult(output || "No page text found.");
    }

    case "find": {
      const { tabId } = await getTabForTool(ctx, args);
      const query = String(args.query || "");
      const frameInfos = await sendContentAll(tabId, { type: "getFrameInfo" });
      const frames = frameInfos
        .filter((entry) => entry.ok && entry.result)
        .sort(
          (a, b) =>
            (Number(a.result.depth) || 0) - (Number(b.result.depth) || 0) ||
            Number(Boolean(b.result.isTopFrame)) - Number(Boolean(a.result.isTopFrame))
        );
      const vp = await viewport(ctx.cdp, tabId).catch(() => null);
      const parts = [];

      for (const frame of frames) {
        let offset = { x: 0, y: 0 };
        let offsetKnown = Boolean(frame.result.isTopFrame);
        if (!frame.result.isTopFrame) {
          const found = await frameOffset(ctx.cdp, tabId, frame.result.token).catch(() => null);
          if (found) {
            offset = found;
            offsetKnown = true;
          }
        }

        const results = await sendContentToFrame(tabId, frame.frameId, {
          type: "findElements",
          query,
          options: {
            offsetX: offset.x,
            offsetY: offset.y,
            viewportWidth: vp?.width,
            viewportHeight: vp?.height
          }
        });
        const hit = firstFrameResult(results, (entry) => typeof entry.result === "string");
        if (!hit || hit.result.startsWith("No elements matched")) continue;
        const label = frame.result.isTopFrame
          ? ""
          : `Frame: ${frame.result.url || "unknown"}${offsetKnown ? "" : " (coordinates relative to frame)"}\n`;
        parts.push(`${label}${hit.result}`);
      }

      if (!parts.length) {
        return textResult(
          `No elements matched "${query}". Try a different phrase, or use read_page to inspect the page.`
        );
      }
      return textResult(parts.join("\n\n"));
    }

    case "form_input": {
      const { tabId } = await getTabForTool(ctx, args);
      if (!args.ref) throw new Error("ref is required for form_input.");
      const results = await sendContentAll(tabId, {
        type: "setFormInput",
        ref: args.ref,
        value: args.value
      });
      const hit = firstFrameResult(results);
      if (!hit) throw frameFailure(results, `Could not set ${args.ref}. Call read_page again.`);
      return textResult(hit.result);
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
      const results = await sendContentAll(tabId, {
        type: "setFileInputFromDataUrl",
        ref: args.ref,
        dataUrl: `data:image/jpeg;base64,${data}`,
        filename: args.filename || "bery-screenshot.jpg"
      });
      const hit = firstFrameResult(results);
      if (!hit) throw frameFailure(results, `Could not attach the image to ${args.ref}.`);
      return textResult(hit.result);
    }

    case "file_upload": {
      const { tabId } = await getTabForTool(ctx, args);
      if (!args.ref) throw new Error("ref is required for file_upload.");
      const files = requireAbsolutePaths(args.paths);
      const results = await sendContentAll(tabId, {
        type: "getFileInputInfo",
        ref: args.ref
      });
      const hit = firstFrameResult(results);
      if (!hit) {
        throw frameFailure(results, `${args.ref} is not a file input. Call read_page again.`);
      }

      const info = hit.result;
      const token = info.token || frameTokenFromRef(args.ref);
      const context = await frameContextForToken(ctx.cdp, tabId, token).catch(() => null);
      if (!context) {
        throw new Error("Could not locate the frame for this file input. Call read_page again.");
      }

      const evaluated = await ctx.cdp.send(
        tabId,
        "Runtime.evaluate",
        {
          expression: `window.__beryContent.fileInputByIndex(${Number(info.index)})`,
          contextId: context.id,
          returnByValue: false
        },
        20000,
        context.sessionId
      );
      const objectId = evaluated?.result?.objectId;
      if (!objectId) throw new Error(`Could not resolve ${args.ref} to a file input.`);

      await ctx.cdp.send(
        tabId,
        "DOM.setFileInputFiles",
        { files, objectId },
        20000,
        context.sessionId
      );
      await ctx.cdp
        .send(
          tabId,
          "Runtime.evaluate",
          {
            expression: `window.__beryContent.notifyFileInput(${Number(info.index)})`,
            contextId: context.id,
            returnByValue: true
          },
          20000,
          context.sessionId
        )
        .catch(() => {});
      return textResult(
        `Attached ${files.length} file${files.length === 1 ? "" : "s"} to ${args.ref}.`
      );
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
