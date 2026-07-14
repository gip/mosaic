import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../dist/qr.js';
import { evmSignTypedDataPayload } from '../dist/evm/index.js';
import { freighterWcLink } from '../dist/stellar/index.js';
import { watchXamanPayload } from '../dist/xrpl/index.js';
import { backupWrapMessage } from '@mosaic/zone-keys';

test('qrSvg renders an inline SVG', () => {
  const svg = qrSvg('https://example.com/pairing?uri=wc:abc');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('currentColor'));
});

test('freighterWcLink carries the wc-redirect prefix and an encoded uri param', () => {
  const link = freighterWcLink('wc:topic@2?relay-protocol=irn&symKey=abc');
  // Freighter mobile silently drops deeplinks missing its registered
  // redirect prefix, then reads the `uri` query param.
  assert.ok(link.startsWith('freighterwallet://wc-redirect/wc?uri='));
  const encoded = link.split('uri=')[1];
  assert.equal(decodeURIComponent(encoded), 'wc:topic@2?relay-protocol=irn&symKey=abc');
});

test('watchXamanPayload rejects an already-cancelled prompt without opening a socket', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    watchXamanPayload('wss://xaman.example.test/status', { signal: abort.signal }),
    /cancelled/,
  );
});

test('watchXamanPayload closes its active socket when the prompt is cancelled', async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() {
      this.closed = false;
      socket = this;
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const abort = new AbortController();
    const pending = watchXamanPayload('wss://xaman.example.test/status', { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(socket.closed, true);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('eth_signTypedData_v4 payload includes EIP712Domain and pinned domain', () => {
  const message = backupWrapMessage({
    rootChain: 'evm',
    rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    zone: 'top',
    network: 'testnet',
  });
  const payload = evmSignTypedDataPayload(message, 'testnet');
  assert.equal(payload.primaryType, 'BackupWrap');
  assert.deepEqual(payload.domain, { name: 'MosaicZone', version: '1', chainId: 84532 });
  assert.ok(payload.types.EIP712Domain);
  assert.ok(payload.types.BackupWrap);
  // never personal_sign: the payload is a full typed-data struct
  assert.equal(payload.message.purpose, 'backup-wrap');
});
