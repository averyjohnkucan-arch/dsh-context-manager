import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import Projection from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import {apply} from '../index.js';

test('owner settings endpoint authenticates, validates and persists changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-api-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  async function boot() {
    const ctx = new Context();
    new Projection(ctx); new SessionStore(ctx); new LlmRuntime(ctx); new TokenMeter(ctx, {}); new SystemPrompt(ctx, {});
    let handler;
    ctx.provide('webServer', {getOrigin: () => 'http://localhost:3080', register(route) {handler = route.handler; return () => {};}});
    await apply(ctx, {dataDir: root});
    const injected = []; ctx.emit('webserver/index-inject', injected);
    const token = injected[0].value.token;
    return {ctx, async call(action, payload, headers = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify({action, payload}))]);
      req.method = 'POST'; req.headers = {'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers};
      let status = 200, body;
      await handler(req, {setHeader() {}, writeHead(code) {status = code;}, end(value) {body = JSON.parse(value);}});
      return {status, body};
    }};
  }
  const a = await boot(); t.after(() => a.ctx.fiber.dispose());
  assert.equal((await a.call('list', {}, {authorization: 'Bearer invalid'})).status, 401);
  assert.equal((await a.call('list', {}, {origin: 'http://untrusted.invalid'})).status, 403);
  assert.equal((await a.call('configure', {outputCap: -2})).status, 400);
  assert.equal((await a.call('configure', {outputCap: 4096})).status, 200);
  assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).outputCap, 4096);
  const b = await boot(); t.after(() => b.ctx.fiber.dispose());
  assert.equal((await b.call('list')).body.result.settings.outputCap, 4096);
});
