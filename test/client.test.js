import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('continuation notice replays only admitted automatic follow-ups', () => {
  let plugin, definition, View;
  const react = {createElement: (_tag, _props, text) => text};
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load({factory}) {plugin = factory(() => react);}}},
  });
  const ctx = {effect: fn => fn(), locale: {register() {}},
    uiConversation: {events: {register(value) {definition = value;}}},
    slots: {inject: (_name, fn) => fn(), register(options, view) {if (options.key === 'turn-max-tokens') View = view;}},
  };
  plugin.apply(ctx);
  assert.equal(definition.match({type: 'turn/end', data: {turn: 1}}), null);
  assert.equal(definition.match({type: 'user/message', data: {source: {kind: 'user'}}}), null);
  const event = {type: 'user/message', data: {source: {kind: 'context-budget', continuedFromTurn: 5}}};
  const match = definition.match(event); assert.equal(match.id, '5');
  const state = definition.start({}, {event});
  const published = definition.buildLocationData({state}, 'turn');
  assert.equal(published.turn, 5); assert.equal(published.value, true);
  assert.match(View({useTurnData: () => true}), /continued automatically/);
  assert.match(View({useTurnData: () => undefined}), /Type Continue/);
});
