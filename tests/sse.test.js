import test from "node:test";
import assert from "node:assert/strict";
import {
  createSSEParser,
  isDoneEvent,
  parseJSONEvent
} from "../extension/shared/sse.js";

test("parses an event split across chunk boundaries", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"a"'), []);
  assert.deepEqual(parser.push(":1}\n\n"), [
    { event: "message", data: '{"a":1}' }
  ]);
});

test("parses multiple events and preserves the event name", () => {
  const parser = createSSEParser();
  const events = parser.push(
    "event: custom\ndata: one\ndata: two\n\ndata: third\n\n"
  );
  assert.deepEqual(events, [
    { event: "custom", data: "one\ntwo" },
    { event: "message", data: "third" }
  ]);
});

test("ignores comments and keepalive blocks", () => {
  const parser = createSSEParser();
  const events = parser.push(": keepalive\n\ndata: [DONE]\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "[DONE]");
});

test("handles CRLF line endings", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"x":2}\r\n\r\n'), [
    { event: "message", data: '{"x":2}' }
  ]);
});

test("flushes a trailing event without a blank line", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"tail":true}'), []);
  assert.deepEqual(parser.flush(), [
    { event: "message", data: '{"tail":true}' }
  ]);
  assert.deepEqual(parser.flush(), []);
});

test("recognizes done events and parses JSON payloads", () => {
  const parser = createSSEParser();
  const [done] = parser.push("data: [DONE]\n\n");
  assert.equal(isDoneEvent(done), true);
  assert.equal(parseJSONEvent(done), null);

  const [event] = parser.push('data: {"ok":true}\n\n');
  assert.equal(isDoneEvent(event), false);
  assert.deepEqual(parseJSONEvent(event), { ok: true });

  const [bad] = parser.push("data: not-json\n\n");
  assert.equal(parseJSONEvent(bad), null);
});
