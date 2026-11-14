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
