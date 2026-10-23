import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

const native = fiber => fiber.runtime?.callback === BasicCompactionEngine ||
  fiber.entry?.options.name === '@deepseek-ai/dsh-compaction-basic';

// Web presets own isolated copies of the native compactor. Disabling the host
// loader row does not reach them, including revisions retained by live chats.
// Use Cordis's config and lifecycle APIs; never edit presets or engine methods.
export async function coordinateCompactors(ctx) {
  const managed = new Set();
  const remove = ctx.on('internal/config', function(_raw, next) {
    const config = next();
    if (!native(this)) return config;
    managed.add(this);
    return {...config, auto: false};
  }, {global: true});
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) if (native(fiber)) managed.add(fiber);
  }
  const restart = async fibers => {
    for (const fiber of fibers) if (fiber.uid !== null) await fiber.restart();
  };
  try { await restart([...managed]); }
  catch (error) { remove(); await restart([...managed]); throw error; }
  return {
    status() {
      const live = [...managed].filter(fiber => fiber.uid !== null);
      return {managedPresetCompactors: live.length,
        conflictingAutomaticCompactors: live.filter(fiber => fiber.config?.auto !== false).length};
    },
    async dispose() {
      remove();
      await restart([...managed]);
      managed.clear();
    },
  };
}
