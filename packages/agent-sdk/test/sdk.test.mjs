import assert from 'node:assert/strict';
import test from 'node:test';
import { defineAgent } from '../dist/index.js';

test('defineAgent is inert until run is called', async () => {
  let calls = 0;
  const definition = defineAgent(async () => { calls += 1; });
  assert.equal(calls, 0);
  await definition.run({});
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(definition), true);
});
