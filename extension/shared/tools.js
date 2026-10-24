function fn(name, description, parameters) {
  return {
    type: "function",
    function: { name, description, parameters }
  };
}

const tabId = {
  type: "number",
  description: "Tab ID from tabs_context_mcp. Omit to use the active tab in the Beryy group."
};

export const TOOLS = [
  fn(
    "tabs_context_mcp",
    "Get the Beryy tab group context (tab IDs, URLs, titles). Call this before using any other browser tool. If no group exists, call with createIfEmpty=true.",
    {
      type: "object",
      properties: {
        createIfEmpty: {
          type: "boolean",
          description: "Create the Beryy tab group (adopting the active tab, or a new blank tab) if none exists."
        }
      }
    }
  ),

  fn(
    "tabs_create_mcp",
    "Create a new tab in the Beryy tab group.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to open. Defaults to about:blank." }
      }
    }
  ),

  fn(
    "tabs_close_mcp",
    "Close one or more tabs in the Beryy tab group.",
    {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Single tab ID to close." },
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Batch form: tab IDs to close."
        }
      }
    }
  ),

  fn(
    "navigate",
    "Navigate a tab to a URL, or go back/forward in history. Use 'back' or 'forward' as the URL for history navigation.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "URL (https:// is added if missing), or 'back' / 'forward'." },
        tabId
      },
      required: ["url"]
    }
  ),

  fn(
    "computer",
    "Mouse, keyboard, scrolling, and screenshots. Prefer element refs from read_page/find over coordinates when possible. Screenshots are returned by the screenshot, scroll, and zoom actions. Coordinates are CSS pixels in the latest screenshot.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click",
            "right_click",
            "double_click",
            "triple_click",
            "hover",
            "type",
            "key",
            "screenshot",
            "wait",
            "scroll",
            "scroll_to",
            "left_click_drag",
            "zoom"
          ],
          description: "The action to perform."
        },
        tabId,
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "[x, y] for clicks, hover, scroll, and the end point of a drag."
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "[x, y] start point for left_click_drag."
        },
        ref: {
          type: "string",
          description: "Element ref from read_page/find, e.g. ref_12. Can replace coordinate for clicks; required for scroll_to."
        },
        text: {
          type: "string",
          description: "Text to type, or a key combo for the key action (e.g. 'ctrl+a', 'Enter')."
        },
        duration: {
          type: "number",
          minimum: 0,
          maximum: 30,
          description: "Seconds to wait (wait action)."
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"]
        },
        scroll_amount: {
          type: "number",
          minimum: 1,
          maximum: 10,
          description: "Scroll ticks (default 3)."
        },
        region: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "[x0, y0, x1, y1] region for zoom."
        },
        repeat: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description: "Repeat count for the key action."
        },
        modifiers: {
          type: "string",
          description: "Modifier keys for clicks: ctrl, shift, alt, cmd, combined with +."
        }
      },
      required: ["action"]
    }
  ),

  fn(
    "read_page",
    "Get an accessibility tree of the page with stable element refs. Use this to understand the page and to get refs for form_input and ref-based clicks.",
    {
      type: "object",
      properties: {
        tabId,
        filter: {
          type: "string",
          enum: ["interactive", "all"],
          description: "interactive = controls only; all = full tree (default)."
        },
        depth: {
          type: "number",
          description:
            "Max tree depth (default 40, or 100 for interactive pages). The result warns if this limit is reached."
        },
        ref_id: { type: "string", description: "Scope the tree to this element ref and its descendants." },
        max_chars: { type: "number", description: "Max output characters (default 50000)." }
      }
    }
  ),

  fn(
    "get_page_text",
    "Extract the main readable text of the page (article/main content first).",
    {
      type: "object",
      properties: {
        tabId,
        max_chars: { type: "number", description: "Max output characters (default 50000)." }
      }
    }
  ),

  fn(
    "find",
    "Find elements by natural-language purpose or text. Returns up to 20 matches with refs and coordinates. Use this before clicking when the target is not obvious.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find, e.g. 'search bar' or 'Sign in button'." },
        tabId
      },
      required: ["query"]
    }
  ),

  fn(
    "form_input",
    "Set a form control's value by element ref (input, textarea, select, checkbox, radio, contenteditable).",
    {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from read_page/find." },
        value: {
          description: "Value to set. Boolean for checkboxes, option value/text for selects.",
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
        },
        tabId
      },
      required: ["ref", "value"]
    }
  ),

  fn(
    "javascript_tool",
    "Execute JavaScript in the page's main world and return the result of the last expression.",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["javascript_exec"], description: "Must be javascript_exec." },
        text: { type: "string", description: "JavaScript source to evaluate." },
        tabId
      },
      required: ["action", "text"]
    }
  ),

  fn(
    "read_console_messages",
    "Read recent console messages for a tab.",
    {
      type: "object",
      properties: {
        tabId,
        onlyErrors: { type: "boolean" },
        clear: { type: "boolean" },
        pattern: { type: "string", description: "Regex filter." },
        limit: { type: "number", description: "Max messages (default 100)." }
      }
    }
  ),

  fn(
    "read_network_requests",
    "Read recent network requests for a tab.",
    {
      type: "object",
      properties: {
        tabId,
        urlPattern: { type: "string", description: "Substring or regex filter." },
        clear: { type: "boolean" },
        limit: { type: "number", description: "Max requests (default 100)." }
      }
    }
  ),

  fn(
    "resize_window",
    "Resize the window containing a tab.",
    {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        tabId
      },
      required: ["width", "height"]
    }
  ),

  fn(
    "set_tab_focus",
    "Bring a tab to the front (select it and focus its window) so the user can see it.",
    {
      type: "object",
      properties: { tabId },
      required: ["tabId"]
    }
  ),

  fn(
    "upload_image",
    "Attach a previously captured Beryy screenshot to a file input element.",
    {
      type: "object",
      properties: {
        imageId: { type: "string", description: "Image ID returned by a screenshot action." },
        ref: { type: "string", description: "File input element ref." },
        tabId,
        filename: { type: "string", description: "Optional filename." }
      },
      required: ["imageId", "ref"]
    }
  )
];

export const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.function.name));

export function getTool(name) {
  return TOOLS.find((tool) => tool.function.name === name) || null;
}

export function buildPromptToolSpec() {
  return TOOLS.map(({ function: tool }) => {
    const properties = tool.parameters.properties || {};
    const required = new Set(tool.parameters.required || []);
    const args = Object.entries(properties)
      .map(([key, schema]) => {
        const type = schema.type || (schema.anyOf ? "string|number|boolean" : "any");
        return `${key}${required.has(key) ? "*" : ""}:${type}`;
      })
      .join(", ");
    return `- ${tool.name}(${args}) — ${tool.description}`;
  }).join("\n");
}
