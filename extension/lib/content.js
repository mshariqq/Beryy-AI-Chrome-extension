import { isScriptableUrl } from "../shared/policy.js";

const CONTENT_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function rawSend(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

async function assertScriptable(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    throw new Error(`Tab ${tabId} no longer exists.`);
  }
  if (!isScriptableUrl(tab.url)) {
    throw new Error(
      `Tab ${tabId} is ${tab.url || "a system page"}; Beryy cannot script chrome://, chrome-extension://, or Web Store pages. Use navigate instead.`
    );
  }
  return tab;
}

async function injectContentAllFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), allFrames: true },
    files: ["content/content.js"]
  });
}

async function runInFrames(tabId, message, { frameIds, timeoutMs = CONTENT_TIMEOUT_MS } = {}) {
  const target = { tabId: Number(tabId) };
  if (Array.isArray(frameIds) && frameIds.length) target.frameIds = frameIds;
  else target.allFrames = true;

  const run = () =>
    chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: async (payload) => {
        try {
          if (!window.__beryContent) {
            return { ok: false, error: "Beryy content script is not loaded in this frame." };
          }
          const result = await window.__beryContent.handleMessage(payload);
          return {
            ok: true,
            result,
            frame: {
              token: window.__beryContent.frameToken,
              isTopFrame: Boolean(window.__beryContent.isTopFrame),
              depth: Number(window.__beryContent.depth) || 0,
              url: location.href,
              title: document.title
            }
          };
        } catch (error) {
          return {
            ok: false,
            error: String(error?.message || error)
          };
        }
      },
      args: [message]
    });

  let injected;
  try {
    injected = await withTimeout(run(), timeoutMs, "Content script");
  } catch {
    await injectContentAllFrames(tabId);
    injected = await withTimeout(run(), timeoutMs, "Content script");
  }

  return injected.map((entry) => ({
    frameId: entry.frameId,
    ...(entry.result || { ok: false, error: "The frame returned no response." })
  }));
}

export async function sendContent(tabId, message, { timeoutMs = CONTENT_TIMEOUT_MS } = {}) {
  await assertScriptable(tabId);

  let response;
  try {
    response = await withTimeout(rawSend(tabId, message), timeoutMs, "Content script");
  } catch {
    try {
      await injectContentAllFrames(tabId);
      response = await withTimeout(rawSend(tabId, message), timeoutMs, "Content script");
    } catch (error) {
      throw new Error(
        `Could not reach the page: ${error?.message || error}. Try reloading the tab.`
      );
    }
  }

  if (!response) throw new Error("The page returned no response.");
  if (!response.ok) throw new Error(response.error || "The page reported an error.");
  return response.result;
}

export async function sendContentAll(tabId, message, options = {}) {
  await assertScriptable(tabId);
  return runInFrames(tabId, message, options);
}

export async function sendContentToFrame(tabId, frameId, message, options = {}) {
  return runInFrames(tabId, message, { ...options, frameIds: [frameId] });
}

export function firstFrameResult(results, predicate = () => true) {
  return (results || []).find(
    (entry) => entry?.ok && entry.result != null && predicate(entry)
  ) || null;
}

export function frameErrors(results) {
  return (results || [])
    .filter((entry) => !entry.ok || entry.result == null)
    .map((entry) => entry.error)
    .filter(Boolean);
}

export function frameTokenFromRef(ref) {
  const match = /^ref_(f[a-z0-9]+)_\d+$/.exec(String(ref || ""));
  return match ? match[1] : "";
}
