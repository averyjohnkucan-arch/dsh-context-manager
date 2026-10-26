export const DEFAULTS = Object.freeze({
  auto: true, summaryTokens: 16384, safetyTokens: 8192,
  minimumOutputTokens: 4096, retainTokens: 32768,
  outputCap: 0, autoContinue: true,
});

export function settings(input = {}) {
  for (const key of Object.keys(input)) if (!(key in DEFAULTS)) throw new Error(`Unknown context setting: ${key}`);
  const value = {...DEFAULTS, ...input};
  for (const key of ['auto', 'autoContinue']) if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  for (const key of ['summaryTokens', 'safetyTokens', 'minimumOutputTokens', 'retainTokens', 'outputCap']) {
    const min = key === 'outputCap' || key === 'retainTokens' ? 0 : 256;
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > 1048576) throw new Error(`${key} must be an integer from ${min} to 1048576`);
  }
  return Object.freeze(value);
}

// Reserves scale down for smaller models; a 32K route must not inherit a 64K reserve.
export function limits(config, contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048) throw new Error('Model must declare a context window of at least 2048 tokens');
  const summaryTokens = Math.min(config.summaryTokens, Math.floor(contextWindow / 8));
  const safetyTokens = Math.min(config.safetyTokens, Math.floor(contextWindow / 16));
  const minimumOutputTokens = Math.min(config.minimumOutputTokens, Math.floor(contextWindow / 16));
  return {contextWindow, summaryTokens, safetyTokens, minimumOutputTokens,
    retainTokens: Math.min(config.retainTokens, Math.floor(contextWindow / 8)),
    thresholdTokens: contextWindow - summaryTokens - safetyTokens - minimumOutputTokens};
}

export function outputBudget(config, info, promptTokens, provider) {
  const resolved = limits(config, info.context?.contextWindow);
  let maxTokens = Math.floor(resolved.contextWindow - promptTokens - resolved.summaryTokens - resolved.safetyTokens);
  // These local adapters expose defaults, not architectural output ceilings.
  // Cloud routes retain their provider-declared cap.
  if (!['ninfer', 'strata', 'dory'].includes(provider) && info.defaultMaxTokens) maxTokens = Math.min(maxTokens, info.defaultMaxTokens);
  if (config.outputCap) maxTokens = Math.min(maxTokens, config.outputCap);
  return {...resolved, promptTokens, maxTokens};
}
