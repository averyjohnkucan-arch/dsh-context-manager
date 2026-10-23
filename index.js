import z from '@deepseek-ai/schemastery';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ContextEngine} from './lib/engine.js';
import {settings} from './lib/policy.js';
import {coordinateCompactors} from './lib/integration.js';

export const inject = ['llm', 'tokenMeter', 'sessions', 'webServer', 'systemPrompt'];
export const Config = z.object({dataDir: z.string()});
export async function apply(ctx, config = {}) {
  const root = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-context-manager');
  await mkdir(root, {recursive: true, mode: 0o700});
  const path = join(root, 'settings.json');
  let saved = {};
  try {saved = JSON.parse(await readFile(path, 'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
  // Settle every existing preset's native compactor before publishing adaptive
  // allowances. The config hook also covers future presets and child agents.
  const integration = await coordinateCompactors(ctx);
  const engine = new ContextEngine(ctx, settings(saved)), token = randomBytes(32).toString('hex');
  ctx.effect(() => async () => {
    try { await engine.restoreOutputDefaults(); }
    finally { await integration.dispose(); }
  });
  let writes = Promise.resolve();
  ctx.on('webserver/index-inject', table => table.push({kind: 'global', name: '__DSH_CONTEXT_MANAGER__', value: {path: '/plugins/dsh-context-manager/action', token}}));
  const status = () => ({settings: engine.preferences, integration: integration.status(), recent: [...engine.recent.entries()].map(([sessionId, value]) => ({sessionId, ...value}))});
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/plugins/dsh-context-manager/action', handler: async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, '')), expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {res.writeHead(401); res.end('{}'); return;}
    if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {res.writeHead(405); res.end('{}'); return;}
    if (req.headers.origin && req.headers.origin !== ctx.webServer.getOrigin()) {res.writeHead(403); res.end('{}'); return;}
    try {
      let body = '', size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 16384) throw new Error('Request too large'); body += chunk;}
      const {action, payload = {}} = JSON.parse(body);
      if (action === 'configure') {
        const next = settings(payload);
        writes = writes.catch(() => {}).then(async () => {
          await writeFile(path + '.tmp', JSON.stringify(next, null, 2) + '\n', {mode: 0o600});
          await rename(path + '.tmp', path); engine.configure(next);
        });
        await writes;
      } else if (action !== 'list') throw new Error('Unknown context operation');
      res.end(JSON.stringify({result: status()}));
    } catch (error) {res.writeHead(400); res.end(JSON.stringify({error: error.message}));}
  }}));
  ctx.effect(() => () => writes.catch(() => {}));
}
