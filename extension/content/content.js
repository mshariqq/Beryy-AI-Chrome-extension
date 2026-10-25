// Beryy content script: accessibility tree, element refs, form input, text
// extraction, local element search, and screenshot-to-file-input uploads.
// Runs in the isolated world, so the page cannot observe the ref map.
(function () {
  if (window.__beryContentLoaded) return;
  window.__beryContentLoaded = true;

  const isTopFrame = (() => {
    try {
      return !window.top || window.top === window;
    } catch {
      return true;
    }
  })();
  const frameToken = `f${Math.random().toString(36).slice(2, 8)}`;
  const frameDepth = (() => {
    let depth = 0;
    let current = window;
    try {
      while (current.parent && current.parent !== current && depth < 50) {
        depth += 1;
        current = current.parent;
      }
    } catch {
      // Cross-origin parent access is limited; keep the depth found so far.
    }
    return depth;
  })();

  let refCounter = 0;
  const elementMap = Object.create(null);
  const reverseMap = new WeakMap();

  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
    label: "label",
    option: "option"
  };

  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "path", "meta", "link", "head"]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "switch",
    "combobox",
    "slider",
    "spinbutton",
    "option",
    "treeitem"
  ]);

  function getOrAssignRef(element) {
    const existing = reverseMap.get(element);
    if (existing && elementMap[existing]?.deref() === element) return existing;
    const ref = isTopFrame
      ? `ref_${++refCounter}`
      : `ref_${frameToken}_${++refCounter}`;
    elementMap[ref] = new WeakRef(element);
    reverseMap.set(element, ref);
    return ref;
  }

  function resolveRef(refId) {
    const weak = elementMap[String(refId)];
    if (!weak) return null;
    const element = weak.deref();
    if (!element) {
      delete elementMap[String(refId)];
      return null;
    }
    if (!element.isConnected) return null;
    return element;
  }

  function getRole(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;

    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (["button", "submit", "reset", "file", "image"].includes(type)) return "button";
      if (type === "hidden") return "";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return TAG_TO_ROLE[tag] || "";
  }

  function getAccessibleName(element) {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().slice(0, 200);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .filter(Boolean);
      if (names.length) return names.join(" ").slice(0, 200);
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "img" && element.alt) return element.alt.trim().slice(0, 200);
    if (element.getAttribute("title")) return element.getAttribute("title").trim().slice(0, 200);
    if (element.getAttribute("placeholder")) {
      return element.getAttribute("placeholder").trim().slice(0, 200);
    }
    if (tag === "input" && ["submit", "button", "reset"].includes((element.type || "").toLowerCase())) {
      if (element.value) return element.value.trim().slice(0, 200);
    }

    if (element.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent) return label.textContent.trim().slice(0, 200);
      } catch {
        // Ignore invalid selectors.
      }
    }
    if (element.closest("label")?.textContent) {
      return element.closest("label").textContent.trim().slice(0, 200);
    }

    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span", "option"].includes(tag)) {
      const text = element.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    const role = element.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (element.tabIndex >= 0) return true;
    if (element.onclick || element.getAttribute("onclick")) return true;
    if (element.isContentEditable) return true;
    return false;
  }

  function isVisible(element) {
    if (element.hidden) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (typeof element.checkVisibility === "function") {
      try {
        if (!element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          return false;
        }
      } catch {
        // Fall through to the manual checks.
      }
    }
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      const tag = element.tagName.toLowerCase();
      return tag === "body" || tag === "html";
    }
    return true;
  }

  function describeElement(element) {
    if (!element) return "nothing";
    const tag = element.tagName.toLowerCase();
    const ref = reverseMap.get(element);
    const name = getAccessibleName(element);
    return `<${tag}${ref ? ` ${ref}` : ""}${name ? ` "${name.slice(0, 60)}"` : ""}>`;
  }

  function elementState(element) {
    if (!element) return null;
    const tag = element.tagName.toLowerCase();
    return {
      description: describeElement(element),
      role: getRole(element) || tag,
      name: getAccessibleName(element).slice(0, 160),
      text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
      ariaLabel: element.getAttribute("aria-label") || "",
      ariaPressed: element.getAttribute("aria-pressed") || "",
      ariaExpanded: element.getAttribute("aria-expanded") || "",
      ariaChecked: element.getAttribute("aria-checked") || "",
      disabled:
        Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      checked: element.checked === true
    };
  }

  function elementContext(element, cache) {
    let node = element.parentElement;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      if (node === document.body || node === document.documentElement) break;
      const label = node.getAttribute?.("aria-label");
      if (label && label.length <= 160 && /post|article|feed/i.test(label)) {
        return label.trim();
      }
      node = node.parentElement;
    }

    const container =
      element.closest?.(
        '[data-urn^="urn:li:activity"], article, [role="article"], .feed-shared-update-v2, [data-urn]'
      ) || element.closest?.(".comments-comment-item, li");
    if (!container) return "";
    if (cache?.has(container)) return cache.get(container);
    const text = String(container.innerText || container.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    cache?.set(container, text);
    return text;
  }

  function deepQueryAll(root, selector) {
    const found = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      found.push(...node.querySelectorAll(selector));
      for (const element of node.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  function findControl(element) {
    const tag = element.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return element;
    if (element.isContentEditable) return element;

    if (element.shadowRoot) {
      const inner = element.shadowRoot.querySelector("input, textarea, select, [contenteditable='true']");
      if (inner) return inner;
    }

    for (const child of element.querySelectorAll("*")) {
      const childTag = child.tagName.toLowerCase();
      if (["input", "textarea", "select"].includes(childTag)) return child;
      if (child.isContentEditable) return child;
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select, [contenteditable='true']");
        if (deep) return deep;
      }
    }
    return null;
  }

  function generateAccessibilityTree(options = {}) {
    const filter = options.filter === "interactive" ? "interactive" : "all";
    const requestedDepth = Number(options.depth);
    const maxDepth = Number.isFinite(requestedDepth)
      ? Math.max(1, Math.min(200, requestedDepth))
      : filter === "interactive"
        ? 100
        : 40;
    const maxChars = Number.isFinite(Number(options.max_chars)) ? Number(options.max_chars) : 50000;
    const startRef = options.ref_id;

    let start = document.body || document.documentElement;
    if (startRef) {
      start = resolveRef(startRef);
      if (!start) return `Error: ${startRef} was not found. Ref IDs reset after navigation; call read_page again.`;
    }

    let output = "";
    let charCount = 0;
    let truncated = false;
    let depthLimited = false;

    const append = (line) => {
      if (truncated) return;
      if (charCount + line.length > maxChars) {
        output += `${line.slice(0, Math.max(0, maxChars - charCount))}\n... (truncated)`;
        charCount = maxChars;
        truncated = true;
        return;
      }
      output += `${line}\n`;
      charCount += line.length + 1;
    };

    const walk = (element, depth, indent) => {
      if (truncated || depth > maxDepth || !element || element.nodeType !== 1) return;

      const tag = element.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (!isVisible(element)) return;

      const role = getRole(element);
      const name = getAccessibleName(element);
      const interactive = isInteractive(element);
      const hasVisibleChildren = element.children.length > 0;

      const shouldShow =
        filter === "interactive"
          ? interactive
          : Boolean(role || name || ["body", "html"].includes(tag));

      if (shouldShow) {
        const ref = getOrAssignRef(element);
        let line = `${indent}${role || tag}`;
        if (name) line += ` "${name.replace(/\s+/g, " ").slice(0, 100)}"`;
        line += ` [${ref}]`;

        if (tag === "a" && element.href) line += ` href="${element.href.slice(0, 160)}"`;
        if (tag === "img" && element.src) line += ` src="${element.src.slice(0, 120)}"`;
        if (tag === "input") {
          const type = (element.type || "text").toLowerCase();
          line += ` type="${type}"`;
          if (type === "password") {
            if (element.value) line += ` value="••••••"`;
          } else if (element.value) {
            line += ` value="${String(element.value).slice(0, 80)}"`;
          }
          if (element.checked) line += " checked";
          if (element.disabled) line += " disabled";
        }
        if (tag === "textarea" && element.value) {
          line += ` value="${String(element.value).slice(0, 80)}"`;
        }
        if (tag === "select") {
          line += element.disabled ? " disabled" : "";
        }
        if (element.getAttribute("aria-expanded")) {
          line += ` expanded=${element.getAttribute("aria-expanded")}`;
        }
        if (element.getAttribute("aria-checked")) {
          line += ` checked=${element.getAttribute("aria-checked")}`;
        }

        append(line);

        if (tag === "select") {
          for (const option of element.options) {
            const selected = option.selected ? " (selected)" : "";
            append(`${indent}  option "${option.text.trim().slice(0, 100)}"${selected} value="${option.value.slice(0, 80)}"`);
          }
        }
      }

      // Recurse even when a container is not shown, so children are reachable.
      if (depth < maxDepth) {
        const children = element.shadowRoot ? element.shadowRoot.children : element.children;
        for (const child of children) {
          walk(child, depth + 1, indent + "  ");
        }
      } else if (element.children.length > 0) {
        depthLimited = true;
      }
    };

    walk(start, 0, "");
    if (depthLimited && !truncated) {
      append(
        `... (depth limit ${maxDepth} reached; call read_page with a higher depth or use find)`
      );
    }
    if (!output) return "No accessible elements found on this page.";
    return truncated ? output : output.trimEnd();
  }

function getRefCoordinates(ref, scrollIntoView = true) {
    const element = resolveRef(ref);
    if (!element) return null;

    if (scrollIntoView) {
      try {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch {
        try {
          element.scrollIntoView(true);
        } catch {
          // Ignore.
        }
      }
    }

    // Re-verify position after potential scroll/layout shift
    return new Promise(resolve => {
      setTimeout(() => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return resolve(null);

        const x = Math.min(Math.max(0, rect.left + rect.width / 2), window.innerWidth - 1);
        const y = Math.min(Math.max(0, rect.top + rect.height / 2), window.innerHeight - 1);

        let coveredBy = null;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) {
          coveredBy = describeElement(hit);
        }

        resolve({
          x,
          y,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          tag: element.tagName.toLowerCase(),
          role: getRole(element) || element.tagName.toLowerCase(),
          name: getAccessibleName(element).slice(0, 120),
          description: describeElement(element),
          text: (element.textContent || "").trim().slice(0, 80),
          state: elementState(element),
          onscreen:
            rect.top + rect.height > 0 &&
            rect.left + rect.width > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth,
          coveredBy
        });
      }, 50);
    });
  }

function scrollToRef(ref) {
    return getRefCoordinates(ref, true).then(result => {
      if (!result) throw new Error(`${ref} was not found or is no longer visible.`);
      return result;
    });
  }

  function actionableElement(element) {
    let node = element;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const tag = node.tagName?.toLowerCase();
      if (
        isInteractive(node) ||
        ["button", "a", "input", "textarea", "select", "label"].includes(tag)
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return element;
  }

  function getPointState(x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    const hit = document.elementFromPoint(px, py);
    if (!hit) return null;
    const element = actionableElement(hit);
    return { x: px, y: py, ...elementState(element) };
  }

  function getRefState(ref) {
    const element = resolveRef(ref);
    return element ? elementState(element) : null;
  }

  function focusRef(ref) {
    const element = resolveRef(ref);
    if (!element) return false;
    const control = findControl(element) || element;
    try {
      control.focus({ preventScroll: false });
    } catch {
      // Fall through to the plain focus call.
    }
    if (document.activeElement !== control) {
      try {
        control.focus();
      } catch {
        // Ignore focus failures.
      }
    }
    return document.activeElement === control || control.contains(document.activeElement);
  }

  function getFocusInfo() {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      return {
        token: frameToken,
        isTopFrame,
        active: false,
        editable: false,
        focused: document.hasFocus(),
        tag: ""
      };
    }
    const editable = Boolean(active.isContentEditable) ||
      ["input", "textarea", "select"].includes(active.tagName.toLowerCase());
    return {
      token: frameToken,
      isTopFrame,
      active: true,
      editable,
      focused: document.hasFocus(),
      tag: active.tagName.toLowerCase()
    };
  }


  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function setFormInput(ref, value) {
    const element = resolveRef(ref);
    if (!element) {
      throw new Error(`${ref} was not found. Refs reset after navigation; call read_page again.`);
    }

    const control = findControl(element) || element;
    try {
      control.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      // Ignore.
    }

    const tag = control.tagName.toLowerCase();

    if (tag === "select") {
      const desired = String(value).toLowerCase();
      const option = [...control.options].find(
        (candidate) =>
          candidate.value.toLowerCase() === desired ||
          candidate.text.trim().toLowerCase() === desired
      );
      if (!option) throw new Error(`No option matching "${value}" in ${ref}.`);
      control.value = option.value;
      dispatchInputEvents(control);
      return `Set ${ref} select to "${option.text.trim()}".`;
    }

    if (tag === "input") {
      const type = (control.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        const desired = value === true || value === "true" || value === 1 || value === "1";
        if (type === "radio" && !desired) {
          if (control.checked) {
            control.checked = false;
            dispatchInputEvents(control);
          }
        } else if (control.checked !== desired) {
          control.click();
        }
        return `Set ${ref} ${type} to ${desired}.`;
      }
      if (type === "file") {
        throw new Error("Use upload_image for file inputs.");
      }
    }

    if (control.isContentEditable && tag !== "input" && tag !== "textarea") {
      control.focus();
      control.textContent = String(value);
      dispatchInputEvents(control);
      return `Set ${ref} contenteditable to "${String(value).slice(0, 60)}".`;
    }

    const proto =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(control, String(value));
    else control.value = String(value);

    dispatchInputEvents(control);
    return `Set ${ref} ${tag} to "${String(value).slice(0, 60)}".`;
  }

  function getPageText(maxChars = 50000) {
    const selectors = [
      "article",
      "main",
      "[class*='articleBody']",
      "[class*='article-body']",
      "[class*='post-content']",
      "[class*='entry-content']",
      "[class*='content-body']",
      "[role='main']",
      ".content",
      "#content"
    ];

    let best = null;
    let bestLength = 0;
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element)) continue;
        const length = (element.textContent || "").length;
        if (length > bestLength) {
          best = element;
          bestLength = length;
        }
      }
    }

    if (!best) best = document.body || document.documentElement;
    const raw = best?.innerText || best?.textContent || "";
    const text = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const limit = Math.max(100, Math.min(200000, Number(maxChars) || 50000));
    const clipped = text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;

    return `Title: ${document.title}\nURL: ${location.href}\nSource element: <${best ? best.tagName.toLowerCase() : "body"}>\n---\n${clipped}`;
  }

  function findElements(query, options = {}) {
    const rawQuery = String(query || "").trim().toLowerCase();
    if (!rawQuery) return "Provide a query, e.g. 'search bar' or 'Sign in'.";
    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    const offsetX = Number(options.offsetX) || 0;
    const offsetY = Number(options.offsetY) || 0;
    const viewportWidth = Number.isFinite(Number(options.viewportWidth))
      ? Number(options.viewportWidth)
      : window.innerWidth;
    const viewportHeight = Number.isFinite(Number(options.viewportHeight))
      ? Number(options.viewportHeight)
      : window.innerHeight;

    const candidates = [];
    const contextCache = new WeakMap();
    let visited = 0;

    const visit = (root) => {
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const element of all) {
        visited += 1;
        if (visited > 8000) return;
        if (!isVisible(element)) continue;

        const tag = element.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;

        const role = getRole(element);
        const name = getAccessibleName(element).toLowerCase();
        const text = (element.textContent || "").trim().toLowerCase().slice(0, 300);
        const placeholder = (element.getAttribute("placeholder") || "").toLowerCase();
        const identity = `${element.id || ""} ${element.className || ""}`.toLowerCase();

        let score = 0;
        if (name === rawQuery) score += 18;
        else if (name.includes(rawQuery)) score += 12;

        for (const token of tokens) {
          if (name.includes(token)) score += 4;
          if (role.includes(token)) score += 2;
          if (placeholder.includes(token)) score += 2;
          if (identity.includes(token)) score += 1;
          if (text.includes(token)) score += 1;
        }

        if (score === 0) continue;
        if (isInteractive(element)) score += 3;
        if (role === "button" || role === "link" || role === "textbox") score += 2;

        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const left = rect.left + offsetX;
        const top = rect.top + offsetY;

        const context = elementContext(element, contextCache);
        if (context) {
          const contextLower = context.toLowerCase();
          if (contextLower.includes(rawQuery)) score += 6;
          for (const token of tokens) {
            if (contextLower.includes(token)) score += 2;
          }
        }

        const onscreen =
          top + rect.height > 0 &&
          left + rect.width > 0 &&
          top < viewportHeight &&
          left < viewportWidth;
        if (onscreen) score += 24;

        candidates.push({
          element,
          score,
          role: role || tag,
          name: getAccessibleName(element).slice(0, 80),
          context,
          onscreen,
          x: Math.round(left + rect.width / 2),
          y: Math.round(top + rect.height / 2)
        });
      }

      for (const element of root.querySelectorAll ? root.querySelectorAll("*") : []) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };

    visit(document.body || document.documentElement);

    candidates.sort((a, b) => {
      if (a.onscreen !== b.onscreen) return a.onscreen ? -1 : 1;
      return b.score - a.score || a.y - b.y;
    });
    const top = candidates.slice(0, 20);
    if (!top.length) {
      return `No elements matched "${query}". Try a different phrase, or use read_page to inspect the page.`;
    }

    const lines = top.map((item, index) => {
      const ref = getOrAssignRef(item.element);
      const where = item.onscreen
        ? `at (${item.x}, ${item.y})`
        : "offscreen; click the ref to scroll it into view";
      const context = item.context ? ` — context: "${item.context}"` : "";
      return `${index + 1}. [${ref}] ${item.role} "${item.name}" ${where}${context}`;
    });

    return `Found ${top.length} match${top.length === 1 ? "" : "es"} for "${query}":\n${lines.join("\n")}`;
  }

  function fileInputFor(ref) {
    const element = resolveRef(ref);
    if (!element) return null;
    if (element.tagName.toLowerCase() === "input" && element.type === "file") return element;
    return deepQueryAll(element.shadowRoot || element, "input[type='file']")[0] || null;
  }

  function fileInputsInFrame() {
    return deepQueryAll(document, "input[type='file']");
  }

  function getFileInputInfo(ref) {
    const input = fileInputFor(ref);
    if (!input) throw new Error(`${ref} is not a file input.`);
    const inputs = fileInputsInFrame();
    const index = inputs.indexOf(input);
    if (index < 0) throw new Error(`${ref} is not a file input.`);
    return {
      index,
      token: frameToken,
      url: location.href,
      name: input.name || "",
      accept: input.accept || "",
      multiple: Boolean(input.multiple)
    };
  }

  function fileInputByIndex(index) {
    return fileInputsInFrame()[Number(index)] || null;
  }

  function notifyFileInput(index) {
    const input = fileInputByIndex(index);
    if (!input) return false;
    dispatchInputEvents(input);
    return true;
  }

  async function setFileInputFromDataUrl(ref, dataUrl, filename) {
    const input = fileInputFor(ref);
    if (!input) throw new Error(`${ref} is not a file input.`);

    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const file = new File([blob], filename || "bery-screenshot.jpg", { type: blob.type || "image/jpeg" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    dispatchInputEvents(input);
    return `Attached ${file.name} (${file.size} bytes) to ${ref}.`;
  }

  function handleMessage(message) {
    switch (message?.type) {
      case "generateAccessibilityTree":
        return generateAccessibilityTree(message.options || {});
      case "getRefCoordinates":
        return getRefCoordinates(message.ref, message.scrollIntoView !== false);
      case "getRefState":
        return getRefState(message.ref);
      case "focusRef":
        return focusRef(message.ref);
      case "getFocusInfo":
        return getFocusInfo();
      case "getPointState":
        return getPointState(message.x, message.y);
      case "scrollToRef":
        return scrollToRef(message.ref);
      case "setFormInput":
        return setFormInput(message.ref, message.value);
      case "getPageText":
        return getPageText(message.maxChars);
      case "findElements":
        return findElements(message.query, message.options);
      case "getFrameInfo":
        return {
          token: frameToken,
          isTopFrame,
          depth: frameDepth,
          url: location.href,
          title: document.title
        };
      case "getFileInputInfo":
        return getFileInputInfo(message.ref);
      case "setFileInputFromDataUrl":
        return setFileInputFromDataUrl(message.ref, message.dataUrl, message.filename);
      default:
        throw new Error(`Unknown content message: ${message?.type}`);
    }
  }

  window.__beryContent = {
    frameToken,
    isTopFrame,
    depth: frameDepth,
    handleMessage,
    fileInputByIndex,
    notifyFileInput
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    Promise.resolve()
      .then(() => handleMessage(message))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });
})();

