import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import Agents from '@deepseek-ai/dsh-agent';
import SessionStore, {Session} from '@deepseek-ai/dsh-session';
import Projection from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '../token-meter.js';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {defineTool} from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import Loop from '../loop.js';
import {ContextEngine} from '../lib/engine.js';
import {coordinateCompactors} from '../lib/integration.js';
import Basic from '@deepseek-ai/dsh-compaction-basic';
import {compactCheckpointSource} from '@deepseek-ai/dsh-compaction';

function* response(text, kind = 'stop', type = 'text') {
  yield {type: 'block-start', index: 0, blockType: type};
  yield {type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: 0, text};
  yield {type: 'block-end', index: 0, block: {type, text}};
  yield {type: 'finish', reason: {kind}};
}
async function fixture(t, options = {}) {
  const ctx = new Context();
  for (const Plugin of [Projection, SessionStore, LlmRuntime, Agents, Tools]) await ctx.plugin(Plugin);
  await ctx.plugin(TokenMeter, {}); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(NativeExecutor, {});
  ctx.systemPrompt.section({name: 'fixture', order: 0, text: 'Finish the user task.'});
  const calls = [], errors = [];
  ctx.on('agent/error', e => errors.push(String(e.error)));
  class Adapter extends LlmAdapter {
    contextManagerCanContinue({content}) {return (options.provider ?? 'ninfer') === 'ninfer' && content.every(b => b.type === 'text');}
    async resolveModel(provider, model) {return {provider, id: model, name: model, context: {contextWindow: options.capacity ?? 131072}, defaultMaxTokens: 1000, reasoning: {efforts: [{id: 'off', name: 'Off'}]}};}
    async *stream(request) {calls.push(request); yield* (options.generate?.(request, calls) ?? response(request.purpose ? 'Faithful checkpoint of the older work.' : 'Done.'));}
  }
  ctx.llm.registerAdapter(['ninfer', 'cloud'], new Adapter());
  const engine = new ContextEngine(ctx, {outputBuffer: options.buffer ?? 8192, retainPercent: options.retain ?? 30});
  await ctx.plugin(Loop, {agents: [], maxParallelToolCalls: 4});
  const handle = await ctx.agents.create({sessionId: 'context-fixture', agentOptions: {provider: options.provider ?? 'ninfer', model: 'fixture'}});
  const agent = handle.agent;
  options.setup?.({ctx, agent, engine});
  const events = () => Array.from({length: agent.session.seq}, (_, i) => agent.session.eventAt(i));
  t.after(async () => {await handle.dispose(); await ctx.fiber.dispose();});
  return {ctx, agent, engine, calls, errors, events, async send(text) {agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text}]})); await agent.whenIdle();}};
}

test('real DSH 0.2.2 loop admits remaining-context-minus-one allowance', async t => {
  const f = await fixture(t); await f.send('Hello'); assert.deepEqual(f.errors, []);
  assert.ok(f.calls[0].maxTokens > 120000);
  assert.equal(f.events().filter(e => e.type === 'request/header').at(-1).data.header.config.maxTokens, f.calls[0].maxTokens);
});

test('low-free-space natural completion compacts immediately without forcing another answer', async t => {
  let main = 0;
  const f = await fixture(t, {generate(req) {
    if (req.purpose) return response('Preserved older work.');
    return response(++main === 1 ? 'a'.repeat(500000) : 'Done.');
  }});
  await f.send('Write'); assert.deepEqual(f.errors, []);
  assert.equal(main, 1); assert.equal(f.calls.filter(c => c.purpose).length, 1);
  assert.ok(f.events().some(e => e.type === 'compaction/end' && !e.data.error));
});

test('hard cutoff compacts separately, retains exact suffix, and resumes without any extra user message', async t => {
  let main = 0;
  const large = '0123456789'.repeat(51000);
  const f = await fixture(t, {generate(req) {
    if (req.purpose) return response('The user requested a long answer; earlier work is complete.');
    return ++main === 1 ? response(large, 'max-tokens') : response('Final conclusion.');
  }});
  await f.send('Write the long answer'); assert.deepEqual(f.errors, []);
  assert.equal(main, 2);
  assert.equal(f.events().filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1);
  assert.equal(f.events().filter(e => e.type === 'user/message' && e.data.source.kind === 'context-budget').length, 0);
  const summary = f.calls.find(c => c.purpose), resumed = f.calls.filter(c => !c.purpose)[1];
  const tail = resumed.messages.at(-1);
  assert.equal(tail.role, 'assistant');
  assert.ok(large.endsWith(tail.content[0].text));
  assert.ok(f.ctx.tokenMeter.estimateMessage(tail) >= Math.floor(131072 * .3));
  assert.ok(!JSON.stringify(summary.messages).includes(large));
  assert.equal(f.events().filter(e => e.type === 'turn/start').length, 1);
  assert.equal(f.events().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed');
  const restored = Session.create('restored', JSON.parse(JSON.stringify(f.events())), undefined, undefined, f.ctx.sessions.messageProjections);
  assert.deepEqual(restored.deriveMessages(), f.agent.session.deriveMessages());
  assert.ok(f.ctx.tokenMeter.measure(restored).totalTokens < 60000);
});

test('failed summaries retry three times without replacing the original response', async t => {
  const text = 'b'.repeat(510000);
  const f = await fixture(t, {generate: req => req.purpose ? response('Truncated', 'max-tokens') : response(text, 'max-tokens')});
  await f.send('Long');
  assert.equal(f.calls.filter(c => c.purpose).length, 3);
  assert.ok(f.errors.some(e => /3 attempts/.test(e)));
  assert.ok(f.agent.session.surface.nodes.some(seq => f.agent.session.eventAt(seq).data.message?.content.some(b => b.text === text)));
  assert.equal(f.events().filter(e => e.type === 'user/message' && e.data.source.kind === 'context-budget').length, 0);
});

test('repeated identical cutoff output stops message-free continuation', async t => {
  const f = await fixture(t, {generate: () => response('Repeated partial.', 'max-tokens')});
  await f.send('Start'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 2);
});

test('cloud output ceilings are respected and unsupported prefix continuation pauses visibly', async t => {
  const f = await fixture(t, {provider: 'cloud', generate: () => response('Partial.', 'max-tokens')});
  await f.send('Start'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].maxTokens, 1000);
  assert.match(f.engine.recent.get(f.agent.session.id).reason, /no verified/);
});

test('NInfer reasoning is preserved and unsupported reasoning-prefill does not synthesize input', async t => {
  const f = await fixture(t, {generate: () => response('Unfinished reasoning', 'max-tokens', 'reasoning')});
  await f.send('Think'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
  assert.match(f.engine.recent.get(f.agent.session.id).reason, /reasoning prefill/);
});

test('cancellation never compacts or resumes cancelled work', async t => {
  let agent;
  const f = await fixture(t, {setup(o) {agent = o.agent;}, generate: async function* () {yield {type: 'block-start', index: 0, blockType: 'text'}; yield {type: 'text-delta', index: 0, text: 'Partial'}; agent.cancel({kind: 'user'}); yield {type: 'finish', reason: {kind: 'max-tokens'}};}});
  await f.send('Start'); assert.equal(f.calls.length, 1);
  assert.equal(f.events().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
});

test('message-free continuation completes the subsequent native tool cycle exactly once', async t => {
  let main = 0, executed = 0;
  const f = await fixture(t, {setup({ctx}) {
    ctx.tools.register(defineTool({name: 'lookup', description: 'Read a fact', parameters: {},
      output: {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]},
      execute: async () => {executed++; return 'fact';}}));
  }, generate(req) {
    if (req.purpose) return response('Checkpoint.');
    if (++main === 1) return response('Partial answer.', 'max-tokens');
    if (main === 2) return (function* () {yield {type: 'block-start', index: 0, blockType: 'tool-call', id: 'call-1', name: 'lookup'}; yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{}'}}; yield {type: 'finish', reason: {kind: 'tool-calls'}};})();
    return response('Finished using the fact.');
  }});
  await f.send('Use lookup'); assert.deepEqual(f.errors, []); assert.equal(main, 3); assert.equal(executed, 1);
  assert.equal(f.events().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed');
});

test('pending user input takes precedence over automatic continuation', async t => {
  let agent, main = 0;
  const f = await fixture(t, {setup(o) {agent = o.agent;}, generate() {
    if (++main === 1) {agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Actually stop the long answer'}]})); return response('Partial.', 'max-tokens');}
    return response('Acknowledged.');
  }});
  await f.send('Start'); assert.deepEqual(f.errors, []); assert.equal(main, 2);
  assert.equal(f.events().filter(e => e.type === 'turn/start').length, 2);
  assert.match(JSON.stringify(f.calls[1].messages), /Actually stop/);
});

test('late context injection rebuilds the final recorded budget before dispatch', async t => {
  let refreshes = 0;
  const f = await fixture(t, {setup({ctx}) {ctx.systemPrompt.context({name: 'late', order: 0, text: () => ++refreshes === 1 ? '' : 'z'.repeat(12000)});}});
  await f.send('Hello'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].maxTokens < 129000);
  assert.equal(f.events().filter(e => e.type === 'request/header').at(-1).data.header.config.maxTokens, f.calls[0].maxTokens);
});

test('preset compactor coordination supports current Cordis and restores policies on dispose', async () => {
  const ctx = new Context(); for (const name of ['llm', 'sessions', 'tokenMeter']) ctx.provide(name, {});
  const integration = await coordinateCompactors(ctx);
  try {
    for (let i = 0; i < 2; ++i) {const child = ctx.isolate('compaction'); await child.plugin(Basic, {auto: true}); assert.equal(child.compaction.config.auto, false);}
    assert.equal(integration.status().conflictingAutomaticCompactors, 0);
    await integration.dispose();
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) if (runtime.callback === Basic) assert.equal(fiber.ctx.compaction.config.auto, true);
  } finally {await ctx.fiber.dispose();}
});

test('a large admitted user message can use the remaining space before a balanced prefix exists', async t => {
  const f = await fixture(t, {capacity: 8192, buffer: 4096, retain: 25});
  await f.send('x'.repeat(23000));
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].maxTokens > 0 && f.calls[0].maxTokens < 4096);
  assert.equal(f.events().filter(e => e.type === 'compaction/start').length, 0);
});

function* readPair(step) {
  for (let i = 0; i < 2; i++) {
    const id = 'read-' + step + '-' + i;
    yield {type: 'block-start', index: i, blockType: 'tool-call', id, name: 'read_pair'};
    yield {type: 'block-end', index: i, block: {type: 'tool-call', id, name: 'read_pair', arguments: '{}'}};
  }
  yield {type: 'finish', reason: {kind: 'tool-calls'}};
}

function registerReadPair(ctx, execute) {
  ctx.tools.register(defineTool({name: 'read_pair', description: 'Read project text', parameters: {},
    output: {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]}, execute}));
}

test('an indivisible tool batch can cross the soft reserve and compact once more history ages out', async t => {
  let step = 0, results = 0;
  const f = await fixture(t, {capacity: 12000, buffer: 6000, retain: 30, setup({ctx}) {
    registerReadPair(ctx, async () => 'r'.repeat(++results <= 2 ? 12600 : 8000));
  }, generate(req) {
    if (req.purpose) return response('The initial request and first pair of reads are complete.');
    return ++step <= 2 ? readPair(step) : response('Done.');
  }});
  await f.send('u'.repeat(4600));
  assert.deepEqual(f.errors, []);
  assert.equal(results, 4);
  assert.deepEqual(f.calls.map(req => req.purpose ?? 'main'), ['main','main','compaction','main']);
  const afterFirst = f.calls[1], afterSecond = f.calls[3];
  assert.ok(afterFirst.maxTokens > 0 && afterFirst.maxTokens < 6000);
  for (const [request, batch] of [[afterFirst, 1], [afterSecond, 2]]) {
    const calls = request.messages.flatMap(m => m.content.filter(b => b.type === 'tool-call'));
    for (let i = 0; i < 2; i++) {
      const id = 'read-' + batch + '-' + i;
      assert.ok(calls.some(b => b.id === id));
      assert.ok(request.messages.some(m => m.toolCallId === id));
    }
  }
  assert.equal(f.events().filter(e => e.type === 'compaction/end' && !e.data.error).length, 1);
});

test('summary retries keep the available generation allowance and accept a complete second attempt', async t => {
  let tries = 0;
  const f = await fixture(t, {generate(req) {
    if (!req.purpose) return response('a'.repeat(500000));
    return ++tries === 1 ? response('Incomplete', 'max-tokens') : response('Complete checkpoint.');
  }});
  await f.send('Continue the project');
  assert.deepEqual(f.errors, []);
  const summaries = f.calls.filter(r => r.purpose);
  assert.equal(summaries.length, 2);
  assert.ok(summaries[1].maxTokens >= summaries[0].maxTokens - 100);
  assert.equal(f.events().filter(e => e.type === 'compaction/end' && !e.data.error).length, 1);
});

test('provider failures during soft compaction propagate without retrying as a size error', async t => {
  const f = await fixture(t, {generate(req) {
    if (!req.purpose) return response('b'.repeat(500000));
    return [{type: 'finish', reason: {kind: 'error', failure: {code: 'AUTHENTICATION', message: 'Invalid account'}}}];
  }});
  await f.send('Write');
  assert.equal(f.calls.filter(r => r.purpose).length, 1);
  assert.ok(f.errors.some(message => message.includes('Invalid account')));
  assert.equal(f.events().filter(e => e.type === 'compaction/summary').length, 0);
});

test('a truly oversized pending input still fails before any provider request', async t => {
  const f = await fixture(t, {capacity: 8192, buffer: 4096, retain: 25});
  await f.send('x'.repeat(45000));
  assert.equal(f.calls.length, 0);
  assert.ok(f.errors.some(message => /No older balanced history|fills the context window/.test(message)));
});

test('soft pressure preserves a lone existing checkpoint until fresh older content is eligible', async t => {
  const f = await fixture(t, {capacity: 10000, buffer: 4096, retain: 32});
  const session = f.agent.session;
  const append = (source, text) => session.append('user/message', createUserMessage({source, content: [{type: 'text', text}]}), {surfaceOp: 'append'});
  append(compactCheckpointSource('previous-compaction'), 'checkpoint'.repeat(800));
  append({kind: 'user'}, 'recent'.repeat(3000));
  const before = [...session.surface.nodes];
  const size = f.engine.projectedTokens(f.agent);
  assert.ok(size > 10000 - 4096 && size < 9999);
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal), null);
  assert.deepEqual(session.surface.nodes, before);
  assert.equal(f.calls.length, 0);
});

test('three rejected summaries leave a fitting main request usable across both planning hooks', async t => {
  let step = 0;
  const f = await fixture(t, {capacity: 12000, buffer: 6000, retain: 30, setup({ctx}) {
    registerReadPair(ctx, async () => 'r'.repeat(7500));
  }, generate(req) {
    if (req.purpose) return response('Incomplete', 'max-tokens');
    return ++step === 1 ? readPair(step) : response('Finished with the original history.');
  }});
  const original = 'u'.repeat(13500);
  await f.send(original);
  assert.deepEqual(f.errors, []);
  assert.equal(step, 2);
  assert.equal(f.calls.filter(req => req.purpose).length, 3);
  assert.ok(f.calls.at(-1).messages.some(m => m.content.some(b => b.text === original)));
  assert.equal(f.events().filter(e => e.type === 'compaction/summary').length, 0);
});

test('on a reported overflow the plugin can release space with a reduced reserve and retry', async t => {
  let step = 0;
  const f = await fixture(t, {capacity: 12000, buffer: 6000, retain: 30, setup({ctx}) {
    registerReadPair(ctx, async () => 'r'.repeat(12600));
  }, generate(req) {
    if (req.purpose) return response('The initial request has been preserved.');
    step++;
    if (step === 1) return readPair(step);
    if (step === 2) return [{type: 'finish', reason: {kind: 'error', failure: {code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Server window exceeded'}}}];
    return response('Complete after recovery.');
  }});
  await f.send('u'.repeat(4600));
  assert.deepEqual(f.errors, []);
  assert.equal(step, 3);
  assert.equal(f.calls.filter(req => req.purpose).length, 1);
  assert.equal(f.events().filter(e => e.type === 'compaction/end' && !e.data.error).length, 1);
  assert.ok(f.calls.at(-1).messages.some(m => m.toolCallId === 'read-1-0'));
  assert.ok(f.calls.at(-1).messages.some(m => m.toolCallId === 'read-1-1'));
});
