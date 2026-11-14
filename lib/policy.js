export const DEFAULTS = Object.freeze({outputBuffer: 32768, retainPercent: 30});

export function settings(input = {}) {
  for (const key of Object.keys(input)) if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
  const next = {...DEFAULTS, ...input};
  if (!Number.isSafeInteger(next.outputBuffer) || next.outputBuffer < 1 || next.outputBuffer > 16777216) throw new Error('Output buffer must be an integer from 1 to 16777216');
  if (!Number.isFinite(next.retainPercent) || next.retainPercent <= 0 || next.retainPercent >= 100) throw new Error('Verbatim retention must be greater than 0 and less than 100 percent');
  return Object.freeze(next);
}

export function migrate(input = {}) {
  if ('outputBuffer' in input || 'retainPercent' in input) return settings(input);
  return settings(); // v1 knobs describe a different policy; do not reinterpret them.
}

export function policy(config, capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 2048) throw new Error('Model must declare a context capacity of at least 2048 tokens');
  const retainTokens = Math.floor(capacity * config.retainPercent / 100);
  if (retainTokens + config.outputBuffer + 1 >= capacity) throw new Error('Retention plus output buffer leaves no room for a checkpoint; lower one of these settings');
  return {...config, capacity, retainTokens};
}

export function outputBudget(config, info, promptTokens, provider) {
  const p = policy(config, info.context?.contextWindow);
  let maxTokens = Math.floor(p.capacity - promptTokens - 1);
  // Local adapter defaults are convenience caps; cloud endpoints can have hard ceilings.
  if (!['ninfer', 'strata', 'dory', 'lfm'].includes(provider) && info.defaultMaxTokens) maxTokens = Math.min(maxTokens, info.defaultMaxTokens);
  if (maxTokens < 1) throw new Error('Request fills the context window; compact history or shorten the pending input');
  return {...p, promptTokens, freeTokens: p.capacity - promptTokens, maxTokens};
}

export function summaryBudget({capacity, targetCapacity = capacity, sourceTokens, inputTokens, retainedTokens, overheadTokens, outputBuffer}) {
  const maxTokens = Math.floor(Math.min(sourceTokens - 1, capacity - inputTokens - 1,
    targetCapacity - retainedTokens - overheadTokens - outputBuffer - 1));
  if (maxTokens < 1) throw new Error('No room for a useful summary while preserving the requested verbatim tail and output buffer');
  return maxTokens;
}
