function parseEvent(raw) {
  let event = "message";
  const data = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/**
 * Incremental Server-Sent Events parser. Feed it arbitrary text chunks and it
 * returns complete events. This is intentionally dependency-free so the same
 * code can be unit tested in Node and used in the extension.
 */
export function createSSEParser() {
  let buffer = "";

  return {
    push(chunk) {
      buffer += String(chunk ?? "").replace(/\r\n/g, "\n");
      const events = [];
      let boundary;

      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent(raw);
        if (event) events.push(event);
      }

      return events;
    },

    flush() {
      if (!buffer.trim()) {
        buffer = "";
        return [];
      }
      const event = parseEvent(buffer);
      buffer = "";
      return event ? [event] : [];
    }
  };
}

export function isDoneEvent(event) {
  return event && event.data.trim() === "[DONE]";
}

export function parseJSONEvent(event) {
  if (!event || isDoneEvent(event)) return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}
