import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOLS,
  TOOL_NAMES,
  buildPromptToolSpec,
  getTool
} from "../extension/shared/tools.js";

test("exposes 16 uniquely named tools", () => {
  assert.equal(TOOLS.length, 16);
  assert.equal(TOOL_NAMES.size, TOOLS.length);
  for (const tool of TOOLS) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.name, "string");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(typeof tool.function.parameters.properties, "object");
  }
});

test("every required argument is declared in properties", () => {
  for (const { function: tool } of TOOLS) {
    for (const required of tool.parameters.required || []) {
      assert.ok(
        Object.hasOwn(tool.parameters.properties, required),
        `${tool.name} requires undeclared property ${required}`
      );
    }
  }
});

test("includes the core browser tools", () => {
  for (const name of [
    "tabs_context_mcp",
    "tabs_create_mcp",
    "tabs_close_mcp",
    "navigate",
    "computer",
    "read_page",
    "get_page_text",
    "find",
    "form_input",
    "javascript_tool",
    "read_console_messages",
    "read_network_requests",
    "resize_window",
    "set_tab_focus",
    "upload_image",
    "file_upload"
  ]) {
    assert.ok(TOOL_NAMES.has(name), `missing tool ${name}`);
  }
});

test("getTool finds tools by name", () => {
  assert.equal(getTool("read_page")?.function.name, "read_page");
  assert.equal(getTool("not_a_tool"), null);
});

test("buildPromptToolSpec describes every tool", () => {
  const spec = buildPromptToolSpec();
  for (const { function: tool } of TOOLS) {
    assert.match(spec, new RegExp(`- ${tool.name}\\(`));
  }
  assert.match(spec, /read_page\(/);
  assert.match(spec, /upload_image\(imageId\*:string, ref\*:string/);
});
