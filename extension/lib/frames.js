import { frameTokenFromRef } from "./content.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureContexts(cdp, tabId) {
  if (cdp.executionContexts(tabId).length) return;
  await cdp.send(tabId, "Runtime.enable", {}).catch(() => {});
  await sleep(80);
}

export async function frameTokenContexts(cdp, tabId) {
  await ensureContexts(cdp, tabId);
  const contexts = cdp.executionContexts(tabId).filter((context) => context.frameId);
  const found = new Map();

  for (const context of contexts) {
    if (context.isDefault) continue;
    const response = await cdp
      .send(
        tabId,
        "Runtime.evaluate",
        {
          expression:
            "typeof window.__beryContent === 'object' && window.__beryContent ? window.__beryContent.frameToken : ''",
          contextId: context.id,
          returnByValue: true
        },
        20000,
        context.sessionId
      )
      .catch(() => null);
    const token = response?.result?.value;
    if (typeof token === "string" && token) found.set(token, context);
  }

  return found;
}

export async function frameContextForToken(cdp, tabId, token) {
  if (!token) return null;
  let contexts = await frameTokenContexts(cdp, tabId);
  for (let attempt = 0; attempt < 8 && !contexts.has(token); attempt += 1) {
    await sleep(100);
    contexts = await frameTokenContexts(cdp, tabId);
  }
  return contexts.get(token) || null;
}

function findFramePath(tree, targetId, path = []) {
  if (!tree?.frame?.id) return null;
  const next = [...path, tree.frame.id];
  if (tree.frame.id === targetId) return next;
  for (const child of tree.childFrames || []) {
    const found = findFramePath(child, targetId, next);
    if (found) return found;
  }
  return null;
}

async function frameChain(cdp, tabId, frameId, sessionId = "") {
  const tree = await cdp
    .send(tabId, "Page.getFrameTree", {}, 20000, sessionId)
    .catch(() => null);
  const path = findFramePath(tree?.frameTree, frameId);
  if (!path) return null;

  if (!sessionId) {
    return path.length > 1 ? [{ frameId, sessionId: "" }] : [];
  }

  const descendants = path.length > 1 ? [{ frameId, sessionId }] : [];

  const ancestors = [];
  let currentSession = sessionId;
  let currentTopFrameId = path[0];
  while (currentSession) {
    const parent = cdp.sessionParent(tabId, currentSession);
    ancestors.unshift({ frameId: currentTopFrameId, sessionId: parent });
    if (!parent) break;

    const parentTree = await cdp
      .send(tabId, "Page.getFrameTree", {}, 20000, parent)
      .catch(() => null);
    const parentTopFrameId = parentTree?.frameTree?.frame?.id;
    if (!parentTopFrameId) return null;
    currentTopFrameId = parentTopFrameId;
    currentSession = parent;
  }

  return [...ancestors, ...descendants];
}

async function frameOwner(cdp, tabId, entry) {
  const owner = await cdp
    .send(
      tabId,
      "DOM.getFrameOwner",
      { frameId: entry.frameId },
      20000,
      entry.sessionId
    )
    .catch(() => null);
  return owner?.backendNodeId ? owner.backendNodeId : null;
}

export async function frameOffset(cdp, tabId, token, { scrollIntoView = false } = {}) {
  if (!token) return { x: 0, y: 0, frameId: "" };

  const context = await frameContextForToken(cdp, tabId, token);
  if (!context?.frameId) return null;

  const chain = await frameChain(cdp, tabId, context.frameId, context.sessionId);
  if (!chain) return null;
  if (!chain.length) return { x: 0, y: 0, frameId: context.frameId };

  const owners = [];
  for (const entry of chain) {
    const backendNodeId = await frameOwner(cdp, tabId, entry);
    if (!backendNodeId) return null;
    owners.push({ ...entry, backendNodeId });
  }

  if (scrollIntoView) {
    for (const entry of owners) {
      await cdp
        .send(
          tabId,
          "DOM.scrollIntoViewIfNeeded",
          { backendNodeId: entry.backendNodeId },
          20000,
          entry.sessionId
        )
        .catch(() => {});
      await sleep(80);
    }
  }

  let x = 0;
  let y = 0;
  for (const entry of owners) {
    const box = await cdp
      .send(
        tabId,
        "DOM.getBoxModel",
        { backendNodeId: entry.backendNodeId },
        20000,
        entry.sessionId
      )
      .catch(() => null);
    const quad = box?.model?.content;
    if (!Array.isArray(quad) || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    x += Math.min(...xs);
    y += Math.min(...ys);
  }

  return { x, y, frameId: context.frameId };
}

export async function frameOffsetForRef(cdp, tabId, ref, options = {}) {
  return frameOffset(cdp, tabId, frameTokenFromRef(ref), options);
}
