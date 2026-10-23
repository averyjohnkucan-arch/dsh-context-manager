window.__ModuleLoader__.load({id: 'dsh-context-manager', factory(require) {
  const React = require('react'), h = React.createElement;
  return {inject: ['slots', 'locale', 'uiConversation'], apply(ctx) {
    ctx.effect(() => ctx.locale.register('dsh-context-manager', {en: {}}));
    // This durable source is written only when the automatic follow-up is
    // admitted. Replay therefore never says "continued" for a cancelled queue.
    ctx.effect(() => ctx.uiConversation.events.register({
      kind: 'context-budget-continuation',
      match(event) {
        const source = event.type === 'user/message' ? event.data.source : undefined;
        return source?.kind === 'context-budget' && Number.isInteger(source.continuedFromTurn)
          ? {id: String(source.continuedFromTurn), role: 'start'} : null;
      },
      start(_context, match) { return match.event.data.source.continuedFromTurn; },
      update(context) { return context.state; },
      buildLocationData(context, scope) {
        return scope === 'turn' ? {kind: 'turn', turn: context.state, key: 'context-budget-continuation', value: true} : null;
      },
    }));
    function LimitNotice({useTurnData}) {
      const continued = useTurnData('context-budget-continuation');
      return h('p', {role: 'status', style: {color: 'var(--dsw-alias-label-secondary)', fontSize: 13}},
        continued ? 'Output allowance reached · continued automatically below' : 'Output allowance reached. Type Continue to keep going.');
    }
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({name: 'conversation.chat.node', key: 'turn-max-tokens', priority: -10}, LimitNotice));
    function Card() {
      const [draft, setDraft] = React.useState(null), [recent, setRecent] = React.useState([]), [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
      async function api(action, payload) {
        const config = window.__DSH_CONTEXT_MANAGER__;
        if (!config) throw new Error('Context manager is not connected. Reload the page after enabling the plugin.');
        const response = await fetch(config.path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token}, body: JSON.stringify({action, payload})});
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save context settings'); return data.result;
      }
      React.useEffect(() => {let alive = true; api('list').then(data => {if (alive) {setDraft(data.settings); setRecent(data.recent);}}).catch(error => {if (alive) setMessage(error.message);}); return () => {alive = false;};}, []);
      async function save() {setBusy(true); setMessage(''); try {const data = await api('configure', draft); setDraft(data.settings); setRecent(data.recent); setMessage('Saved. Applies to the next generation.');} catch (error) {setMessage(error.message);} finally {setBusy(false);}}
      const field = (key, label, help) => h('label', {key, style: {display: 'grid', gap: 6}}, h('span', null, label), h('input', {type: 'number', min: key === 'outputCap' || key === 'retainTokens' ? 0 : 256, max: 1048576, step: 1, value: draft[key], onChange: event => setDraft({...draft, [key]: Number(event.target.value)})}), h('small', null, help));
      const check = (key, label) => h('label', {key}, h('input', {type: 'checkbox', checked: draft[key], onChange: event => setDraft({...draft, [key]: event.target.checked})}), ' ', label);
      const last = recent.at(-1);
      return h('section', {className: 'dsh-context-settings', style: {marginTop: 16, padding: 16, border: '1px solid var(--dsw-alias-settings-card-stroke)', borderRadius: 12, background: 'var(--dsw-alias-settings-card-fill)'}},
        h('style', null, '.dsh-context-settings{color:var(--dsw-alias-label-primary);font-size:14px}.dsh-context-settings h3{font-size:16px}.dsh-context-settings p,.dsh-context-settings small{color:var(--dsw-alias-label-secondary);line-height:1.5}.dsh-context-settings input[type=number],.dsh-context-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px}.dsh-context-settings :focus-visible{outline:2px solid #579bff;outline-offset:2px}.dsh-context-settings button{margin-top:16px;cursor:pointer}.dsh-context-settings button:disabled{opacity:.5}'),
        h('h3', null, 'Context & output'),
        h('p', null, 'NInfer and Strata can use the remaining context for each response. A summary reserve and safety buffer stay free so the conversation can be compacted and continued.'),
        draft && h(React.Fragment, null,
          h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 16}}, check('auto', 'Compact automatically'), check('autoContinue', 'Continue automatically at the output limit')),
          h('div', {style: {display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16}},
            field('outputCap', 'Output cap (0 = remaining space)', 'Optional limit per generation. Other providers retain their model output ceiling.'),
            field('summaryTokens', 'Summary token budget', 'Reserved for the checkpoint. Scales down for smaller context windows.'),
            field('safetyTokens', 'Safety buffer', 'Space for prompt estimation, formatting and the summary instruction.'),
            field('minimumOutputTokens', 'Compact when output space falls below', 'Compacts older history before the next generation needs this room.'),
            field('retainTokens', 'Recent context to keep verbatim', 'Older context is summarized. A single oversized response may also need summarizing.')),
          h('button', {disabled: busy, onClick: save}, busy ? 'Saving…' : 'Save context settings')),
        last && h('p', null, `Last planned request: ${last.promptTokens.toLocaleString()} prompt + up to ${last.maxTokens.toLocaleString()} output; ${last.summaryTokens.toLocaleString()} summary + ${last.safetyTokens.toLocaleString()} safety reserved.`),
        message && h('p', {role: 'status'}, message));
    }
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({name: 'settings.models.footer', id: 'dsh-context-manager', order: 4}, Card));
  }};
}});
