import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import {coordinateCompactors} from '../lib/integration.js';

test('Cordis 4.1 boot and resume compactor config uses the explicit fiber', async () => {
  const ctx = new Context();
  for (const name of ['llm', 'sessions', 'tokenMeter']) ctx.provide(name, {});
  const integration = await coordinateCompactors(ctx);
  try {
    // Mount twice in isolated contexts, as separate restored chats do.
    for (let i = 0; i < 2; i++) {
      const child = ctx.isolate('compaction');
      const fiber = child.plugin(BasicCompactionEngine, {auto: true});
      await fiber;
      assert.equal(child.compaction.config.auto, false);
    }
    await integration.dispose();
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (runtime.callback === BasicCompactionEngine) assert.equal(fiber.ctx.compaction.config.auto, true);
    }
  } finally { await ctx.fiber.dispose(); }
});
