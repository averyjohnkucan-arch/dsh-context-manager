import test from 'node:test';
import assert from 'node:assert/strict';
import {settings, migrate, policy, outputBudget, summaryBudget} from '../lib/policy.js';

test('retention uses total capacity and buffer does not reserve normal output', () => {
  for (const capacity of [131072, 262144, 1000000]) {
    const config = settings({outputBuffer: 8192, retainPercent: 30});
    assert.equal(policy(config, capacity).retainTokens, Math.floor(capacity * .3));
    assert.equal(outputBudget(config, {context: {contextWindow: capacity}, defaultMaxTokens: 1000}, 10000, 'ninfer').maxTokens, capacity - 10001);
  }
});
test('cloud hard output cap is respected without becoming a compaction threshold', () => {
  const p = outputBudget(settings(), {context: {contextWindow: 1000000}, defaultMaxTokens: 32768}, 900000, 'cloud');
  assert.equal(p.maxTokens, 32768); assert.equal(p.outputBuffer, 32768); assert.equal(p.retainTokens, 300000);
});
test('summary budget fits its separate request and final buffer', () => {
  assert.equal(summaryBudget({capacity: 1000000, inputTokens: 590100, sourceTokens: 590000, retainedTokens: 400000, overheadTokens: 100, outputBuffer: 32768}), 409899);
  assert.equal(summaryBudget({capacity: 1000000, inputTokens: 20000, sourceTokens: 10000, retainedTokens: 300000, overheadTokens: 100, outputBuffer: 32768}), 9999);
});
test('invalid combinations fail clearly and v1 settings migrate to the fresh policy', () => {
  for (const value of [{retainPercent: 100}, {retainPercent: 0}, {outputBuffer: 0}, {outputBuffer: 1.5}, {auto: true}]) assert.throws(() => settings(value));
  assert.throws(() => policy(settings(), 32768), /leaves no room/);
  assert.deepEqual(migrate({auto: true, retainTokens: 32768}), {outputBuffer: 32768, retainPercent: 30});
});
