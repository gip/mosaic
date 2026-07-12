import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalancesFeed, fetchBalances } from '../dist/index.js';

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = `524C555344${'0'.repeat(30)}`;

const XRP = { symbol: 'XRP', kind: 'native' };
const RLUSD = { symbol: 'RLUSD', kind: 'issued', code: 'RLUSD', issuer: ISSUER };

const REQ = {
  network: 'testnet',
  addresses: ['rAlice', 'rBob'],
  assets: [XRP, RLUSD],
};

class FakeWebSocket {
  static instances = [];
  static script = null; // (sentMessage) => response payload
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ id: msg.id, type: 'response', ...FakeWebSocket.script(msg) }) });
    });
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

test('happy path: account_info + per-issuer account_lines, hex-currency matching', async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = (msg) => {
    if (msg.command === 'account_info') {
      assert.equal(msg.ledger_index, 'validated');
      const balance = msg.account === 'rAlice' ? '9169260310' : '25000000';
      return { status: 'success', result: { account_data: { Balance: balance } } };
    }
    assert.equal(msg.command, 'account_lines');
    assert.equal(msg.peer, ISSUER);
    if (msg.account === 'rAlice') {
      return {
        status: 'success',
        result: {
          lines: [
            // Noise from another currency of the same issuer.
            { account: ISSUER, currency: 'USD', balance: '7' },
            // The RLUSD line uses the 40-char hex form on-ledger.
            { account: ISSUER, currency: RLUSD_HEX, balance: '123.45' },
          ],
        },
      };
    }
    return { status: 'success', result: { lines: [] } };
  };

  const snapshot = await fetchBalances(REQ, { fetch, webSocket: FakeWebSocket });

  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, 'wss://s.altnet.rippletest.net:51233');
  assert.equal(ws.closed, true); // ephemeral socket released
  assert.equal(ws.sent.length, 4); // (info + lines) × 2 addresses

  assert.equal(snapshot.network, 'testnet');
  const [alice, bob] = snapshot.accounts;
  assert.equal(alice.address, 'rAlice');
  assert.equal(alice.funded, true);
  assert.deepEqual(alice.balances, [
    { asset: XRP, amount: '9169.26031' },
    { asset: RLUSD, amount: '123.45' },
  ]);
  assert.deepEqual(bob.balances, [
    { asset: XRP, amount: '25' },
    { asset: RLUSD, amount: '0' },
  ]);
});

test('actNotFound accounts report funded: false with zero balances', async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = (msg) => {
    if (msg.account === 'rAlice') return { status: 'error', error: 'actNotFound' };
    if (msg.command === 'account_info') {
      return { status: 'success', result: { account_data: { Balance: '5000000' } } };
    }
    return { status: 'success', result: { lines: [] } };
  };

  const snapshot = await fetchBalances(REQ, { fetch, webSocket: FakeWebSocket });
  const [alice, bob] = snapshot.accounts;
  assert.equal(alice.funded, false);
  assert.deepEqual(alice.balances, [
    { asset: XRP, amount: '0' },
    { asset: RLUSD, amount: '0' },
  ]);
  assert.equal(bob.funded, true);
  assert.deepEqual(bob.balances[0], { asset: XRP, amount: '5' });
});

test('non-actNotFound rippled errors reject the fetch', async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = (msg) =>
    msg.command === 'account_info'
      ? { status: 'error', error: 'tooBusy' }
      : { status: 'success', result: { lines: [] } };

  await assert.rejects(fetchBalances(REQ, { fetch, webSocket: FakeWebSocket }), /tooBusy/);
});

test('native-only requests skip account_lines entirely', async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => ({ status: 'success', result: { account_data: { Balance: '1' } } });

  const snapshot = await fetchBalances(
    { ...REQ, addresses: ['rAlice'], assets: [XRP] },
    { fetch, webSocket: FakeWebSocket },
  );
  assert.equal(FakeWebSocket.instances[0].sent.length, 1);
  assert.deepEqual(snapshot.accounts[0].balances, [{ asset: XRP, amount: '0.000001' }]);
});

test('empty address list resolves without opening a socket', async () => {
  FakeWebSocket.instances = [];
  const snapshot = await fetchBalances(
    { ...REQ, addresses: [] },
    { fetch, webSocket: FakeWebSocket },
  );
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepEqual(snapshot.accounts, []);
});

test('createBalancesFeed constructs synchronously without network I/O', () => {
  const feed = createBalancesFeed(REQ);
  assert.equal(feed.status, 'idle');
  assert.equal(feed.latest, null);
  assert.deepEqual(feed.request.addresses, ['rAlice', 'rBob']);
});
