import test from 'node:test';
import assert from 'node:assert/strict';
import { stellarTransferMode } from '../dist/index.js';

const native = { kind: 'native' };
const issued = {
  kind: 'issued',
  code: 'USDC',
  issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

test('selects createAccount only for native transfers to unfunded destinations', () => {
  assert.equal(stellarTransferMode(native, false), 'create-account');
  assert.equal(stellarTransferMode(native, true), 'payment');
});

test('requires an existing destination trustline for issued assets', () => {
  assert.throws(() => stellarTransferMode(issued, false), /must exist/);
  assert.throws(() => stellarTransferMode(issued, true, false), /does not trust/);
  assert.equal(stellarTransferMode(issued, true, true), 'payment');
});
