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
  return chrome.tabs.sendMessage(tabId, message);
}

export async function sendContent(tabId, message, { timeoutMs = CONTENT_TIMEOUT_MS } = {}) {
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

  let response;
  try {
    response = await withTimeout(rawSend(tabId, message), timeoutMs, "Content script");
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: Number(tabId) },
        files: ["content/content.js"]
      });
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
