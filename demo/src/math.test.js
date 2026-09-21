import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, mul } from './math.js';

test('add works', () => {
  assert.equal(add(2, 3), 5);
});

test('mul works', () => {
  assert.equal(mul(2, 3), 6);
});
