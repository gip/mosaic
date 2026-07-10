import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cmpDecimals,
  divDecimals,
  dropsToXrp,
  formatScaled,
  isZeroDecimal,
  mulRatio,
  parseScaled,
} from '../dist/decimal.js';

test('parseScaled / formatScaled round-trip', () => {
  assert.equal(formatScaled(parseScaled('123.456', 15), 15), '123.456');
  assert.equal(formatScaled(parseScaled('0.0000001', 15), 15), '0.0000001');
  assert.equal(formatScaled(parseScaled('42', 15), 15), '42');
  assert.equal(formatScaled(parseScaled('1.000', 15), 15), '1');
});

test('parseScaled handles scientific notation', () => {
  assert.equal(formatScaled(parseScaled('1e-10', 15), 15), '0.0000000001');
  assert.equal(formatScaled(parseScaled('1.5E3', 15), 15), '1500');
  assert.equal(formatScaled(parseScaled('2.5e-2', 15), 15), '0.025');
});

test('parseScaled rejects garbage', () => {
  assert.throws(() => parseScaled('abc', 15));
  assert.throws(() => parseScaled('', 15));
  assert.throws(() => parseScaled('1.2.3', 15));
});

test('divDecimals truncates at 15 decimals', () => {
  assert.equal(divDecimals('4400', '2000'), '2.2');
  assert.equal(divDecimals('10004.1214612255', '9169.26031'), '1.09105');
  assert.equal(divDecimals('1', '3'), '0.333333333333333');
  assert.throws(() => divDecimals('1', '0'));
});

test('mulRatio scales exactly', () => {
  assert.equal(mulRatio('370.9456847', 2000000n, 370951n), '1999.971342306665839');
  assert.equal(mulRatio('523.0225800', 1000000n, 185469n), '2820');
  assert.throws(() => mulRatio('1', 1n, 0n));
});

test('dropsToXrp is exact', () => {
  assert.equal(dropsToXrp('9169260310'), '9169.26031');
  assert.equal(dropsToXrp('1'), '0.000001');
  assert.equal(dropsToXrp('0'), '0');
  // Beyond float53 precision: 100 billion XRP + 1 drop survives.
  assert.equal(dropsToXrp('100000000000000001'), '100000000000.000001');
  assert.throws(() => dropsToXrp('1.5'));
  assert.throws(() => dropsToXrp('-3'));
});

test('cmpDecimals and isZeroDecimal', () => {
  assert.equal(cmpDecimals('1.1', '1.2'), -1);
  assert.equal(cmpDecimals('2', '2.0'), 0);
  assert.equal(cmpDecimals('10', '9.999999'), 1);
  assert.equal(isZeroDecimal('0'), true);
  assert.equal(isZeroDecimal('0.000'), true);
  assert.equal(isZeroDecimal('0.0001'), false);
});
