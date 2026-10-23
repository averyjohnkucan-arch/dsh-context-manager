import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionStore from '@deepseek-ai/dsh-session';
import Projection from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import {ContextEngine} from '../lib/engine.js';
import {settings} from '../lib/policy.js';

function* response(text, reason = 'stop') {
  yield {type: 'block-start', index: 0, blockType: 'text'};
  yield {type: 'text-delta', index: 0, text};
  yield {type: 'block-end', index: 0, block: {type: 'text', text}};
  yield {type: 'finish', reason: {kind: reason}};
}
async function fixture(t, options = {}) {
  const ctx = new Context();
  new Projection(ctx); new SessionStore(ctx); new LlmRuntime(ctx); new Agents(ctx);
  new SystemPrompt(ctx, {}); new Tools(ctx); new TokenMeter(ctx, {});
  ctx.systemPrompt.section({name: 'fixture', order: 0, text: 'Finish the user task.'});
  const calls = [], errors = [];
  ctx.on('agent/error', payload => errors.push(String(payload.error)));
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {return {provider, id: model, name: model, context: {contextWindow: (options.windows?.[model] ?? options.window) || 32768}, defaultMaxTokens: 1000, reasoning: {efforts: [{id: 'off', name: 'Off'}, {id: 'high', name: 'High'}], defaultEffort: 'high'}};}
    async *stream(request) {
      calls.push(request);
      if (options.generate) yield* options.generate(request, calls);
      else yield* response('Finished.');
    }
  }
  ctx.llm.registerAdapter(['ninfer', 'strata', 'cloud'], new Adapter());
  const engine = new ContextEngine(ctx, settings(options.settings));
  new AgentLoop(ctx, {agents: [], maxParallelToolCalls: {get: () => 4}});
  const handle = await ctx.agents.create({sessionId: 'test-context', agentOptions: {provider: options.provider || 'ninfer', model: 'fixture'}});
  t.after(async () => {await handle.dispose(); await ctx.fiber.dispose();});
  const agent = handle.agent;
  if (options.setup) options.setup({ctx, engine, agent});
  const send = async text => {agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text}]})); await agent.whenIdle();};
  const events = () => Array.from({length: agent.session.seq}, (_, i) => agent.session.eventAt(i));
  return {ctx, engine, agent, calls, send, errors, events};
}

test('real agent loop records dynamic allowance and final request leaves summary room', async t => {
  const f = await fixture(t, {window: 262144}); await f.send('Hello');
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].maxTokens > 200000);
  const header = f.events().filter(e => e.type === 'request/header').at(-1).data.header;
  assert.equal(header.config.maxTokens, f.calls[0].maxTokens);
  assert.ok(f.calls[0].maxTokens + f.ctx.tokenMeter.measure(f.agent.session).totalTokens <= 262144 - 16384 - 8192 + 20);
});

test('a huge completed answer compacts and continues without user input', async t => {
  let primary = 0;
  const f = await fixture(t, {generate(request) {
    if (request.purpose === 'compaction') return response('User asked for a long answer. The first part is complete. Continue with the conclusion.');
    return ++primary === 1 ? response('a'.repeat(request.maxTokens * 4 - 160), 'max-tokens') : response('Conclusion.');
  }});
  await f.send('Write the long answer.');
  assert.deepEqual(f.errors, []);
  assert.equal(primary, 2); assert.equal(f.calls.filter(c => c.purpose === 'compaction').length, 1);
  const summary = f.calls.find(c => c.purpose === 'compaction');
  assert.equal(summary.maxTokens, 4096); assert.equal(summary.reasoningEffort, 'off');
  assert.ok(f.events().some(e => e.type === 'compaction/end' && !e.data.error));
  assert.ok(f.events().some(e => e.type === 'user/message' && e.data.source.kind === 'context-budget'));
  assert.match(JSON.stringify(f.calls.at(-1).messages), /checkpoint|first part/);
});

test('a truncated summary keeps original content and stops instead of looping', async t => {
  const f = await fixture(t, {generate: request => request.purpose === 'compaction' ? response('Incomplete summary', 'max-tokens') : response('b'.repeat(request.maxTokens * 4 - 160), 'max-tokens')});
  await f.send('Long task');
  assert.equal(f.calls.length, 2);
  assert.ok(f.errors.some(e => /Summary exceeded/.test(e)), f.errors.join('\n'));
  assert.ok(f.agent.session.surface.nodes.some(seq => f.agent.session.eventAt(seq).type === 'assistant/message'));
  assert.ok(f.events().some(e => e.type === 'compaction/end' && e.data.error));
});

test('fixed caps can continue, but repeated identical output stops', async t => {
  const f = await fixture(t, {settings: {outputCap: 1024}, generate: () => response('Repeated unfinished response.', 'max-tokens')});
  await f.send('Answer'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 2);
});

test('automatic continuation can be disabled in settings', async t => {
  const f = await fixture(t, {settings: {autoContinue: false}, generate: () => response('Partial answer', 'max-tokens')});
  await f.send('Answer'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
});

test('new input and prompt growth are budgeted without calling the model with an oversized request', async t => {
  const f = await fixture(t);
  await f.send('x'.repeat(18000));
  assert.deepEqual(f.errors, []);
  assert.ok(f.calls[0].maxTokens < 22500);
  await f.send('y'.repeat(4000));
  assert.deepEqual(f.errors, []);
  assert.ok(f.calls[1].maxTokens < f.calls[0].maxTokens - 900);
});

test('cloud provider output caps are retained', async t => {
  const f = await fixture(t, {provider: 'cloud'}); await f.send('Hello');
  assert.deepEqual(f.errors, []); assert.equal(f.calls[0].maxTokens, 1000);
});

function* toolResponse(reason = 'tool-calls') {
  yield {type: 'block-start', index: 0, blockType: 'tool-call', id: 'call-test', name: 'lookup'};
  yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'call-test', name: 'lookup', arguments: '{}'}};
  yield {type: 'finish', reason: {kind: reason}};
}

test('automatic continuation starts a clean turn and completes a tool cycle', async t => {
  let primary = 0, executed = 0;
  const f = await fixture(t, {settings: {outputCap: 1024}, setup({ctx}) {
    ctx.tools.register({name: 'lookup', description: 'Read a fact', parameters: {type: 'object', properties: {}},
      output: {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]},
      async execute() {executed++; return 'fact';}});
  }, generate() {
    if (++primary === 1) return response('First part.', 'max-tokens');
    if (primary === 2) return toolResponse();
    return response('Finished using the fact.');
  }});
  await f.send('Use lookup to finish.');
  assert.deepEqual(f.errors, []); assert.equal(primary, 3); assert.equal(executed, 1);
  const ends = f.events().filter(e => e.type === 'turn/end');
  assert.equal(ends.length, 2); assert.equal(ends.at(-1).data.reason.kind, 'completed');
  const notice = f.events().find(e => e.type === 'user/message' && e.data.source.kind === 'context-budget');
  assert.equal(notice.data.source.continuedFromTurn, ends[0].data.turn);
});

test('a truncated tool call is not executed or automatically continued', async t => {
  const f = await fixture(t, {generate: () => toolResponse('max-tokens')});
  await f.send('Use a tool'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
  assert.equal(f.events().filter(e => e.type === 'tool/result').length, 0);
});

test('cancellation stops the active stream without an automatic follow-up', async t => {
  let cancel;
  const f = await fixture(t, {setup({agent}) {cancel = () => agent.cancel({kind: 'user'});}, generate: async function* () {
    yield {type: 'block-start', index: 0, blockType: 'text'};
    yield {type: 'text-delta', index: 0, text: 'Partial'};
    cancel();
    yield {type: 'finish', reason: {kind: 'max-tokens'}};
  }});
  await f.send('Start'); assert.equal(f.calls.length, 1);
  assert.equal(f.events().filter(e => e.type === 'user/message' && e.data.source.kind === 'context-budget').length, 0);
  assert.equal(f.events().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
});

test('a settings change takes effect on the next request, not in the middle of a stream', async t => {
  let engine;
  const f = await fixture(t, {setup(o) {engine = o.engine;}, generate() {engine.configure({outputCap: 1024}); return response('Done.');}});
  await f.send('First'); await f.send('Second');
  assert.deepEqual(f.errors, []); assert.ok(f.calls[0].maxTokens > 1024); assert.equal(f.calls[1].maxTokens, 1024);
});

test('switching to a smaller model compacts with the previous model before sending', async t => {
  let model = 'large';
  const f = await fixture(t, {windows: {large: 131072, small: 32768}, setup({ctx}) {
    ctx.on('agent/request', async (_event, next) => ({...await next(), model}));
  }, generate(request) {return response(request.purpose ? 'Concise task checkpoint.' : 'Answer.');}});
  await f.send('x'.repeat(130000)); model = 'small'; await f.send('Continue');
  assert.deepEqual(f.errors, []);
  assert.ok(f.calls.some(c => c.purpose === 'compaction' && c.model === 'large'));
  assert.equal(f.calls.at(-1).model, 'small'); assert.ok(f.calls.at(-1).maxTokens > 1000);
});

test('late injected context is re-budgeted before a provider call', async t => {
  let refreshes = 0;
  const f = await fixture(t, {setup({ctx}) {
    ctx.systemPrompt.context({name: 'late-context', order: 0, text: () => ++refreshes === 1 ? '' : 'z'.repeat(12000)});
  }});
  await f.send('Hello'); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].maxTokens < 24000);
  assert.ok(f.events().some(e => e.type === 'assistant/attempt'));
});
