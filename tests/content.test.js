import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { coveredClickError, describeClickOutcome } from "../extension/lib/tools.js";
import { frameTokenFromRef } from "../extension/lib/content.js";

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

function loadContent({ top } = {}) {
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
    innerHeight: 800,
    top
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
    location: { href: "https://iframe.test/page" },
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
  const match = line.match(/\[(ref_[^\]]+)\]/);
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

test("point state reports the element under the click", async () => {
  const target = element({ tag: "button", label: "Like" });
  const { call, document } = loadContent();
  document.elementFromPoint = () => target;

  const state = await call({ type: "getPointState", x: 10, y: 20 });

  assert.equal(state.description, '<button "Like">');
  assert.equal(state.role, "button");
  assert.equal(state.ariaLabel, "Like");
});

test("point state resolves the interactive ancestor", async () => {
  const button = element({ tag: "button", label: "Like" });
  const icon = element({ tag: "span" });
  icon.parentElement = button;

  const { call, document } = loadContent();
  document.elementFromPoint = () => icon;

  const state = await call({ type: "getPointState", x: 10, y: 20 });

  assert.equal(state.description, '<button "Like">');
  assert.equal(state.ariaLabel, "Like");
});

test("find marks off-screen matches without coordinates", async () => {
  const target = element({
    tag: "button",
    label: "Comment",
    rect: { left: 0, top: -500, width: 100, height: 20 }
  });
  const body = element({ tag: "body" });
  body.querySelectorAll = () => [target];

  const { call, document } = loadContent();
  setBody(document, body);

  const output = await call({ type: "findElements", query: "Comment" });

  assert.match(output, /button "Comment" offscreen/);
  assert.doesNotMatch(output, /at \(0, -490\)/);
});

test("find includes nearby post context", async () => {
  const target = element({ tag: "button", label: "Comment" });
  const post = element({ tag: "div", label: "Feed post by Xebia" });
  target.parentElement = post;

  const body = element({ tag: "body" });
  body.querySelectorAll = () => [target];

  const { call, document } = loadContent();
  setBody(document, body);

  const output = await call({ type: "findElements", query: "Xebia Comment" });

  assert.match(output, /button "Comment" at \(50, 10\)/);
  assert.match(output, /context: "Feed post by Xebia"/);
});

test("click outcome reports target state changes", () => {
  const before = {
    description: '<button "Like">',
    ariaLabel: "Like",
    ariaPressed: "false",
    ariaExpanded: "",
    ariaChecked: "",
    disabled: false,
    checked: false,
    text: "Like"
  };
  const after = {
    ...before,
    ariaLabel: "Remove Like",
    ariaPressed: "true"
  };

  const changed = describeClickOutcome(before, after);
  assert.match(changed, /Target: <button "Like">/);
  assert.match(changed, /State changed/);
  assert.match(changed, /pressed "false" -> "true"/);
  assert.match(changed, /label "Like" -> "Remove Like"/);

  const unchanged = describeClickOutcome(before, { ...before });
  assert.match(unchanged, /No accessible state change detected/);
});

test("iframe refs carry a frame token", async () => {
  const target = element({ tag: "button", label: "Embedded action" });
  const body = element({ tag: "body", children: [target] });

  const { call, document } = loadContent({ top: {} });
  setBody(document, body);

  const output = await call({
    type: "generateAccessibilityTree",
    options: { filter: "interactive", max_chars: 10000 }
  });

  const match = output.match(/\[(ref_(f[a-z0-9]+)_\d+)\]/);
  assert.ok(match, `Expected a framed ref in ${output}`);
  assert.equal(frameTokenFromRef(match[1]), match[2]);
});

test("find includes the iframe offset in coordinates", async () => {
  const target = element({
    tag: "button",
    label: "Embedded action",
    rect: { left: 10, top: 20, width: 100, height: 20 }
  });
  const body = element({ tag: "body" });
  body.querySelectorAll = () => [target];

  const { call, document } = loadContent();
  setBody(document, body);

  const output = await call({
    type: "findElements",
    query: "Embedded action",
    options: {
      offsetX: 100,
      offsetY: 200,
      viewportWidth: 1000,
      viewportHeight: 800
    }
  });

  assert.match(output, /at \(160, 230\)/);
});

test("file input info resolves an iframe ref by index", async () => {
  const input = element({ tag: "input", label: "Resume" });
  input.type = "file";
  input.name = "resume";
  input.accept = ".pdf";
  input.multiple = false;
  const body = element({ tag: "body", children: [input] });

  const { call, document } = loadContent({ top: {} });
  setBody(document, body);
  document.querySelectorAll = (selector) =>
    selector === "input[type='file']" ? [input] : [];

  const tree = await call({
    type: "generateAccessibilityTree",
    options: { filter: "interactive", max_chars: 10000 }
  });
  const ref = refFor(tree, "Resume");

  const info = await call({ type: "getFileInputInfo", ref });
  assert.equal(info.index, 0);
  assert.equal(info.name, "resume");
  assert.equal(info.accept, ".pdf");
  assert.equal(info.token, frameTokenFromRef(ref));
});
