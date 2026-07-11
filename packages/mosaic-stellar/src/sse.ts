/**
 * Minimal Server-Sent-Events reader over a fetch body stream. Only the subset
 * Horizon uses: `data:` lines (possibly multi-line), events separated by blank
 * lines, `:` comment keep-alives, `event:`/`retry:` fields ignored.
 */

export interface SseMessage {
  data: string;
}

/**
 * Read SSE messages from a byte stream, invoking `onMessage` for each complete
 * event that carries data. Resolves when the stream ends, rejects on stream
 * error (including aborts).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) onMessage({ data: dataLines.join('\n') });
    dataLines = [];
  };

  const handleLine = (line: string) => {
    if (line === '') {
      flush();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // event:/retry:/id:/comments are ignored — Horizon's payload is in data.
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer !== '') handleLine(buffer.replace(/\r$/, ''));
    flush();
  } finally {
    reader.releaseLock();
  }
}
