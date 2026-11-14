window.__ModuleLoader__.load({id: 'dsh-context-manager', factory(require) {
  const React = require('react'), h = React.createElement;
  return {inject: ['slots'], apply(ctx) {
    function Card() {
      const [draft, setDraft] = React.useState(null), [recent, setRecent] = React.useState([]), [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
      async function api(action, payload) {
        const config = window.__DSH_CONTEXT_MANAGER__;
        if (!config) throw new Error('Reload the page after enabling Context & output.');
        const response = await fetch(config.path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token}, body: JSON.stringify({action, payload})});
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save settings'); return data.result;
      }
      React.useEffect(() => {let alive = true; api('list').then(data => {if (alive) {setDraft(data.settings); setRecent(data.recent);}}).catch(error => {if (alive) setMessage(error.message);}); return () => {alive = false;};}, []);
      async function save() {setBusy(true); try {const data = await api('configure', draft); setDraft(data.settings); setRecent(data.recent); setMessage('Saved. Applies to the next generation.');} catch (error) {setMessage(error.message);} finally {setBusy(false);}}
      const field = (key, label, min, max, help) => h('label', {style: {display: 'grid', gap: 6}}, h('span', null, label), h('input', {type: 'number', min, max, step: key === 'retainPercent' ? 0.1 : 1, value: draft[key], onChange: event => setDraft({...draft, [key]: Number(event.target.value)})}), h('small', null, help));
      return h('section', {style: {marginTop: 16, padding: 16, border: '1px solid var(--dsw-alias-settings-card-stroke)', borderRadius: 12}},
        h('h3', null, 'Context & output'),
        h('p', null, 'Compact older history when free context falls below the output buffer at a generation boundary. Recent history stays verbatim. Summarization runs separately.'),
        draft && h(React.Fragment, null,
          field('outputBuffer', 'Output buffer (tokens)', 1, 16777216, 'Triggers compaction between generations. It is not a response-length cap.'),
          field('retainPercent', 'Keep verbatim (% of total model context)', 0.1, 99.9, '30% of a 1,000,000-token model keeps at least the latest 300,000 tokens, respecting tool boundaries.'),
          h('button', {disabled: busy, onClick: save}, busy ? 'Saving…' : 'Save context settings')),
        h('p', null, 'Message-free continuation requires assistant-prefix support. NInfer requires --assistant-prefill and thinking Off; its current engine cannot resume an interrupted reasoning prefix. Unsupported routes preserve the partial response and pause.'),
        ...recent.filter(x => x.status === 'paused').map(x => h('p', {key: x.sessionId, role: 'status'}, x.reason)),
        message && h('p', {role: 'status'}, message));
    }
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({name: 'settings.models.footer', id: 'dsh-context-manager', order: 4}, Card));
  }};
}});
