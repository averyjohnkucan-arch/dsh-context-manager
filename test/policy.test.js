import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, settings, limits, outputBudget} from '../lib/policy.js';

test('large local models spend remaining context, not their old output default', () => {
  const info = {context: {contextWindow: 262144}, defaultMaxTokens: 32768};
  assert.equal(outputBudget(DEFAULTS, info, 20000, 'ninfer').maxTokens, 217568);
  assert.equal(outputBudget(DEFAULTS, info, 20000, 'strata').maxTokens, 217568);
  assert.equal(outputBudget(DEFAULTS, info, 20000, 'dory').maxTokens, 217568);
  assert.equal(outputBudget(DEFAULTS, info, 20000, 'cloud').maxTokens, 32768);
});
test('small contexts scale reserves and never receive a cap above available space', () => {
  const info = {context: {contextWindow: 32768}, defaultMaxTokens: 8191};
  const budget = outputBudget(DEFAULTS, info, 12000, 'strata');
  assert.equal(budget.summaryTokens, 4096); assert.equal(budget.safetyTokens, 2048);
  assert.equal(budget.maxTokens, 14624);
  assert.equal(limits(DEFAULTS, 262144).thresholdTokens, 233472);
});
test('explicit cap limits output while a full prompt fails closed', () => {
  const info = {context: {contextWindow: 262144}};
  assert.equal(outputBudget(settings({outputCap: 65534}), info, 100, 'ninfer').maxTokens, 65534);
  assert.ok(outputBudget(DEFAULTS, info, 250000, 'ninfer').maxTokens < 0);
  for (const value of [{outputCap: -1}, {summaryTokens: NaN}, {auto: 1}, {bad: 1}, {safetyTokens: 1}]) assert.throws(() => settings(value));
});
