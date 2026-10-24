import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { coveredClickError } from "../extension/lib/tools.js";

const contentSource = readFileSync(
  fileURLToPath(new URL("../extension/content/content.js", import.meta.url)),
  "utf8"
);

function element({
  tag = "div",
  text = "",
  role = null,
  label = null,
  href = null,
  children = [],
  rect = { left: 0, top: 0, width: 100, height: 20 },
  id = "",
  className = ""
} = {}) {
  const attributes = new Map();
  if (role) attributes.set("role", role);
  if (label) attributes.set("aria-label", label);

  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children,
    shadowRoot: null,
    hidden: false,
    textContent: text,
    href,
    src: null,
    id,
    className,
    tabIndex: -1,
    onclick: null,
    isContentEditable: false,
    isConnected: true,
    options: [],
    checkVisibility: () => true,
    getAttribute: (name) => attributes.get(name) ?? null,
    getBoundingClientRect: () => rect,
    scrollIntoView() {},
    contains: (candidate) => candidate === node,
    querySelectorAll: () => [],
    closest: () => null
  };

  return node;
}

function loadContent() {
  let messageListener = null;

  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    }
  };

  const window = {
    __beryContentLoaded: false,
    innerWidth: 1000,
    innerHeight: 800
  };

  const document = {
    body: null,
    documentElement: null,
    elementFromPoint: () => null,
    querySelectorAll: () => [],
    getElementById: () => null
  };

  const context = vm.createContext({
    window,
    document,
    chrome,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    CSS: { escape: (value) => String(value) },
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    setInterval: (fn, ms) => setInterval(fn, ms)
  });

  vm.runInContext(contentSource, context);

  const call = (message) =>
    new Promise((resolve, reject) => {
      messageListener(message, null, (response) => {
        if (response?.ok) resolve(response.result);
        else reject(new Error(response?.error || "Content script failed"));
      });
    });

  return { call, document };
}

function setBody(document, body) {
  document.body = body;
  document.documentElement = body;
}

function refFor(output, text) {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(`"${text}"`));
  assert.ok(line, `Expected ${text} in accessibility tree`);
  const match = line.match(/\[(ref_\d+)\]/);
  assert.ok(match, `Expected a ref for ${text}`);
  return match[1];
}

test("read_page reaches deeply nested interactive elements", async () => {
  let deep = element({ tag: "a", text: "Deep link", href: "https://example.test/deep" });
  for (let index = 0; index < 38; index += 1) {
    deep = element({ children: [deep] });
  }
  const body = element({ tag: "body", children: [deep] });

  const { call, document } = loadContent();
  setBody(document, body);

  const output = await call({
    type: "generateAccessibilityTree",
    options: { filter: "all", max_chars: 10000 }
  });

  assert.match(output, /Deep link/);
  assert.doesNotMatch(output, /depth limit/);
});

test("read_page reports when the depth limit hides content", async () => {
  let deep = element({ tag: "a", text: "Deep link", href: "https://example.test/deep" });
  for (let index = 0; index < 38; index += 1) {
    deep = element({ children: [deep] });
  }
  const body = element({ tag: "body", children: [deep] });

  const { call, document } = loadContent();
  setBody(document, body);

  const output = await call({
    type: "generateAccessibilityTree",
    options: { filter: "all", depth: 5, max_chars: 10000 }
  });

  assert.doesNotMatch(output, /Deep link/);
  assert.match(output, /depth limit 5 reached/);
});

test("ref coordinates report a covering dialog", async () => {
  const target = element({ tag: "a", text: "Images", href: "https://images.test/" });
  const overlay = element({
    tag: "div",
    role: "dialog",
    label: "Consent dialog",
    rect: { left: 0, top: 0, width: 1000, height: 800 }
  });
  const body = element({ tag: "body", children: [target] });

  const { call, document } = loadContent();
  setBody(document, body);

  const tree = await call({
    type: "generateAccessibilityTree",
    options: { filter: "all", max_chars: 10000 }
  });
  const ref = refFor(tree, "Images");

  document.elementFromPoint = () => overlay;

  const point = await call({
    type: "getRefCoordinates",
    ref,
    scrollIntoView: true
  });

  assert.equal(point.coveredBy, '<div "Consent dialog">');
  assert.match(coveredClickError(ref, point), /covered by <div "Consent dialog">/);
});

test("coveredClickError is empty for an uncovered target", () => {
  assert.equal(coveredClickError("ref_1", { x: 10, y: 20, coveredBy: null }), "");
});
