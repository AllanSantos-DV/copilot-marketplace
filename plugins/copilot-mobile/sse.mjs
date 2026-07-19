// SSE (Server-Sent Events) framing — the SINGLE SOURCE OF TRUTH for every text/event-stream
// writer and parser in the daemon. Pure, dependency-free, byte-for-byte identical to the frames
// the code used to hand-roll inline (`data: ${json}\n\n`, `: ${comment}\n\n`) so the refactor is
// provably behavior-preserving.
//
// NOTE ON DUPLICATION: `bridge/sse.mjs` is an intentional, byte-identical COPY of this file. The
// bridge is packaged and shipped independently (it must never `import` from ../daemon/src — the two
// are separate npm surfaces), so the DRY unit here is "one canonical module, copied per package"
// rather than a shared import. Keep the two files in sync when either changes.

/** Frame a pre-stringified data payload: `data: <payload>\n\n`. */
export function sseData(payload) {
  return `data: ${payload}\n\n`;
}

/** Frame an object as a JSON data event: `data: <json>\n\n`. */
export function sseEvent(obj) {
  return sseData(JSON.stringify(obj));
}

/** Frame an SSE comment / keep-alive: `: <text>\n\n`. Comments are ignored by parsers. */
export function sseComment(text) {
  return `: ${text}\n\n`;
}

/**
 * Incremental SSE parser. Returns a `push(chunk)` function that buffers across chunk boundaries,
 * splits complete frames on the blank-line delimiter (`\n\n`), and invokes `onEvent(payload)` with
 * the trimmed text after each `data:` line (skipping `:` keep-alive comments and empty payloads).
 * Mirrors the hand-rolled loop it replaces exactly.
 */
export function createSseParser(onEvent) {
  let buf = "";
  return function push(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const s = line.trimStart();
        if (!s.startsWith("data:")) continue; // ignore ":" keep-alive comments
        const payload = s.slice(5).trim();
        if (!payload) continue;
        onEvent(payload);
      }
    }
  };
}
