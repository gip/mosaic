import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSseStream } from '../dist/sse.js';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks) {
  const messages = [];
  await readSseStream(streamOf(chunks), (m) => messages.push(m.data));
  return messages;
}

test('parses simple data events', async () => {
  assert.deepEqual(await collect(['data: one\n\ndata: two\n\n']), ['one', 'two']);
});

test('handles events split across chunk boundaries', async () => {
  assert.deepEqual(await collect(['data: {"a"', ':1', '}\n', '\nda', 'ta: 2\n\n']), ['{"a":1}', '2']);
});

test('joins multi-line data and ignores other fields', async () => {
  assert.deepEqual(
    await collect(['retry: 1000\nevent: open\ndata: line1\ndata: line2\n\n: keepalive\n\n']),
    ['line1\nline2'],
  );
});

test('handles CRLF line endings and final unterminated event', async () => {
  assert.deepEqual(await collect(['data: a\r\n\r\n', 'data: b']), ['a', 'b']);
});

test('propagates stream errors', async () => {
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('data: x\n\n'));
      else controller.error(new Error('boom'));
    },
  });
  const messages = [];
  await assert.rejects(
    readSseStream(body, (m) => messages.push(m.data)),
    /boom/,
  );
  assert.deepEqual(messages, ['x']);
});
