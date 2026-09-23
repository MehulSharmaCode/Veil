// VEIL dashboard: a read-only consumer of telemetry. It only issues GET /telemetry/state and
// subscribes to GET /telemetry/stream. It never sends anything to the extension or backend.
// All text is rendered via textContent (event strings originate from web pages).

(function () {
  const cfg = window.VEIL_DASHBOARD_CONFIG;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  let session = null;
  let state;
  const reset = (sid) => {
    session = sid;
    state = { reached: new Set(), current: null, egress: { passed: 0, remediated: 0, blocked: 0 }, categories: {}, vault: [], seen: new Set() };
    $('timeline').replaceChildren();
    $('session').textContent = sid ? `session ${sid}` : '';
    ['ir', 'regions', 'categories', 'vaultStatus', 'placeholders', 'egress', 'llm', 'validation', 'execution'].forEach((id) => $(id).replaceChildren());
    $('payload').textContent = '–';
    $('task').textContent = 'No task yet. Start one from the VEIL side panel.';
    renderStages();
    renderPrivacy();
  };

  // ---- stage tracker (registry-driven) --------------------------------------------------------
  function stageFor(envStage) {
    return cfg.stages.find((s) => s.stages.includes(envStage));
  }
  function renderStages() {
    const ol = $('stages');
    ol.replaceChildren(
      ...cfg.stages
        .filter((s) => !s.optional || state.reached.has(s.id))
        .map((s) => {
          const li = el('li', state.current === s.id ? 'active' : state.reached.has(s.id) ? 'done' : '', s.label);
          return li;
        }),
    );
  }

  function renderPrivacy() {
    const e = state.egress;
    const b = $('privacy');
    b.textContent = `egress: ${e.passed} passed · ${e.remediated} remediated · ${e.blocked} blocked`;
    b.className = `badge ${e.blocked ? 'err' : e.remediated ? 'warn' : e.passed ? 'ok' : 'muted'}`;
  }

  function kv(target, pairs) {
    target.replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', String(v))]));
  }

  function line(target, text, tone) {
    target.replaceChildren(el('div', tone || '', text));
  }

  // ---- event handling -------------------------------------------------------------------------
  function summarize(ev) {
    const f = cfg.summaries[ev.type];
    if (f) {
      try {
        return f(ev.data || {});
      } catch {
        /* fall through to generic */
      }
    }
    // Generic rendering for unknown/future event types.
    return Object.entries(ev.data || {})
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('  ')
      .slice(0, 300);
  }

  function tone(ev) {
    const t = cfg.tones[ev.type];
    return typeof t === 'function' ? t(ev) : t || 'info';
  }

  function onEvent(ev) {
    if (!ev || !ev.session_id) return;
    if (ev.session_id !== session) reset(ev.session_id);
    if (state.seen.has(ev.event_id)) return;
    state.seen.add(ev.event_id);
    const d = ev.data || {};

    const st = stageFor(ev.stage);
    if (st) {
      state.reached.add(st.id);
      state.current = st.id;
    }

    switch (ev.type) {
      case 'TASK_STARTED':
        $('task').textContent = d.task;
        break;
      case 'IR_CREATED':
        kv($('ir'), [
          ['page', `${d.page?.origin ?? ''}${d.page?.path ?? ''}`],
          ['title', d.page?.title ?? ''],
          ...Object.entries(d.by_kind || {}).map(([k, v]) => [`${k} elements`, v]),
          ['regions', (d.regions || []).length],
        ]);
        $('regions').textContent = (d.regions || []).map((r) => `${r.id} ${r.kind} "${r.label}" → ${r.status}`).join(' · ');
        break;
      case 'DOM_SNAPSHOT_CREATED':
        break;
      case 'PII_DETECTED':
        for (const [k, v] of Object.entries(d.counts || {})) state.categories[k] = (state.categories[k] || 0) + v;
        $('categories').replaceChildren(...Object.entries(state.categories).map(([k, v]) => el('span', `chip ${k === 'REDACTED' ? 'muted' : ''}`, `${k} ×${v}`)));
        break;
      case 'VAULT_UPDATED': {
        const entries = d.entries || [];
        $('vaultStatus').textContent = d.cleared ? 'Cleared (task ended). 0 entries.' : `${d.count} entries, values held only in the extension's memory.`;
        $('placeholders').replaceChildren(
          ...entries.map((e) => {
            const tr = el('tr');
            tr.append(el('td', 'mono', e.id), el('td', '', e.category), el('td', '', e.source), el('td', 'muted', `stored ${e.stored}`));
            return tr;
          }),
        );
        break;
      }
      case 'EGRESS_CHECK_PASSED':
        if (d.attempt === 2) state.egress.remediated++;
        else state.egress.passed++;
        line($('egress'), `✓ passed (attempt ${d.attempt}, ${d.bytes} bytes)`, 'ok');
        renderPrivacy();
        break;
      case 'EGRESS_CHECK_FAILED':
        line($('egress'), `✗ failed: ${(d.failures || []).map((f) => `${f.rule} at ${f.path}`).join(', ')} → masking and re-checking once`, 'warn');
        break;
      case 'EGRESS_BLOCKED':
        state.egress.blocked++;
        line($('egress'), `⛔ BLOCKED, nothing sent: ${(d.failures || []).map((f) => `${f.rule} at ${f.path}`).join(', ')}`, 'err');
        renderPrivacy();
        break;
      case 'REQUEST_SENT':
        $('payload').textContent = JSON.stringify(d.payload, null, 2);
        break;
      case 'LLM_ACTION_RECEIVED':
        line($('llm'), `${d.status}: ${(d.actions || []).map(window.actionText).join('; ')}\n“${d.message}”  (${d.latency_ms} ms)`);
        break;
      case 'ACTION_VALIDATED':
        line($('validation'), `✓ ${window.actionText(d.action)}${d.confirm?.length ? ` · requires confirmation: ${d.confirm.join(', ')}` : ''}`, 'ok');
        break;
      case 'ACTION_REJECTED':
        line($('validation'), `✗ ${window.actionText(d.action)} · ${d.rule ?? d.result}: ${d.reason ?? ''}`, 'warn');
        break;
      case 'CONFIRMATION_REQUESTED':
        line($('validation'), `? waiting for user confirmation: ${window.actionText(d.action)} (${(d.rules || []).join(', ')})`, 'warn');
        break;
      case 'CONFIRMATION_RESOLVED':
        line($('validation'), `${d.approved ? '✓ approved' : '✗ denied'} by user: ${window.actionText(d.action)}`, d.approved ? 'ok' : 'warn');
        break;
      case 'ACTION_EXECUTED':
        line($('execution'), `${d.ok ? '✓' : '✗'} executed ${window.actionText(d.action)} (${d.mutations ?? 0} mutations, settled in ${d.settle_ms ?? 0} ms)`, d.ok ? 'ok' : 'warn');
        break;
      case 'VERIFICATION_COMPLETE':
        $('execution').append(el('div', d.passed ? 'ok' : 'warn', `${d.passed ? '✓ verified' : '✗ not verified'}: ${d.check}`));
        break;
      case 'TASK_COMPLETED':
        $('execution').append(el('div', d.outcome === 'done' ? 'ok' : 'warn', `Task ${d.outcome}: ${d.message ?? ''}`));
        break;
      default:
        break; // unknown types still appear in the timeline below
    }

    const li = el('li', tone(ev));
    li.append(el('span', 'ts', new Date(ev.ts).toLocaleTimeString()), el('span', 'type', ev.type), el('span', 'sum', summarize(ev)));
    $('timeline').prepend(li);
    renderStages();
  }

  // ---- transport (read-only) ------------------------------------------------------------------
  async function loadState() {
    try {
      const r = await fetch(`${cfg.relayUrl}/telemetry/state`);
      const st = await r.json();
      if (st.session_id) {
        reset(st.session_id);
        st.events.forEach(onEvent);
      }
    } catch {
      /* relay offline; the stream will retry */
    }
  }

  function connect() {
    const es = new EventSource(`${cfg.relayUrl}/telemetry/stream`);
    es.onopen = () => {
      $('conn').textContent = 'live';
      $('conn').className = 'badge ok';
    };
    es.onerror = () => {
      $('conn').textContent = 'relay offline, retrying…';
      $('conn').className = 'badge err';
    };
    es.addEventListener('veil', (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    });
  }

  reset(null);
  loadState().then(connect);
})();
