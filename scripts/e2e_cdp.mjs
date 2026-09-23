#!/usr/bin/env node
// Dev-only E2E driver (not part of the extension). Launches a separate headless Chrome with a throwaway
// profile, loads extension/dist via CDP (Extensions.loadUnpacked), opens the demo site and the real
// side-panel page (as a tab in the same window, with the demo tab active), then drives the side-panel
// UI exactly as a user would: type task → Start → answer prompts per flags. Everything VEIL does is
// the real code path (real DOM, real backend, real LLM). Prompt answers are chosen by these flags.
//
// Usage:
//   node scripts/e2e_cdp.mjs --snapshot                      # debug IR of the demo page only
//   node scripts/e2e_cdp.mjs --task "..." [--confirm allow|deny] [--answer "..."] [--stop-after-ms N]
//   node scripts/e2e_cdp.mjs --task "..." --close-panel-after-ms N
// Needs: servers running (make dev) and a built extension (make ext). No npm dependencies.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO = args.url || 'http://localhost:8080/';
const DIST = resolve(new URL('.', import.meta.url).pathname, '../extension/dist');
const TIMEOUT = Number(args.timeout || 240) * 1000;

const profile = mkdtempSync(join(tmpdir(), 'veil-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
chrome.stderr.on('data', () => {});

// ---- minimal CDP over pipe (NUL-delimited JSON) ----
let nextId = 1;
const pending = new Map();
let buf = '';
chrome.stdio[4].on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : res(msg.result);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: DIST });
  console.log(`extension loaded: ${extId}`);
  let dash;
  if (args.dashboard) {
    const { targetId } = await send('Target.createTarget', { url: 'http://localhost:8090/' });
    dash = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  }
  const { targetId: demoT } = await send('Target.createTarget', { url: DEMO });
  await sleep(1500);
  const { targetId: panelT } = await send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  await sleep(800);
  await send('Target.activateTarget', { targetId: demoT });
  const { sessionId: panel } = await send('Target.attachToTarget', { targetId: panelT, flatten: true });
  const { sessionId: demo } = await send('Target.attachToTarget', { targetId: demoT, flatten: true });
  await sleep(1500);

  console.log('backend:', await evaluate(panel, `document.getElementById('health').textContent`));

  if (args['exec-check']) {
    // Harness-level check of the content-script executor (not the agent path): message the content
    // script from the extension page, like the orchestrator does, and report its local verification.
    const out = await evaluate(
      panel,
      `(async () => {
        const [tab] = await chrome.tabs.query({ active: true, windowId: (await chrome.windows.getCurrent()).id });
        const snap = (await chrome.tabs.sendMessage(tab.id, { type: 'snapshot' })).snapshot;
        const by = (n) => snap.elements.find((e) => e.name === n);
        const run = (command, fp) => chrome.tabs.sendMessage(tab.id, { type: 'execute', command, expectedFingerprint: fp });
        const alt = by('Alternate email'), save = by('Save changes'), email = by('Email');
        return {
          typeControlled: await run({ kind: 'type', id: alt.id, text: 'alt.check@example.org' }, alt.fingerprint),
          typeStaleFp: await run({ kind: 'type', id: email.id, text: 'x' }, 'fdeadbeef'),
          clickSave: await run({ kind: 'click', id: save.id }, save.fingerprint),
          scroll: await run({ kind: 'scroll_by', dy: 300 }),
        };
      })()`,
    );
    console.log(JSON.stringify(out, null, 1));
    // Fixture sanity: a bare .value assignment (no events) must revert on the controlled input.
    const reverted = await evaluate(demo, `(async () => { const a = document.getElementById('altEmail'); a.value = 'no-events@example.org'; await new Promise(r => setTimeout(r, 400)); return a.value; })()`);
    console.log('controlled input after bare .value= :', JSON.stringify(reverted));
    return;
  }

  if (args.snapshot) {
    await evaluate(panel, `document.getElementById('snapNow').click()`);
    await sleep(1500);
    console.log(await evaluate(panel, `document.getElementById('debug').textContent`));
    return;
  }

  const task = String(args.task);
  await evaluate(panel, `(() => { const t = document.getElementById('task'); t.value = ${JSON.stringify(task)}; document.getElementById('start').click(); })()`);
  const t0 = Date.now();
  let seenLog = 0;
  let prompts = 0;
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(400);
    if (args['close-panel-after-ms'] && Date.now() - t0 > Number(args['close-panel-after-ms'])) {
      console.log('>>> closing side panel (kill switch)');
      await send('Target.closeTarget', { targetId: panelT });
      await sleep(4000);
      break;
    }
    if (args['stop-after-ms'] && Date.now() - t0 > Number(args['stop-after-ms'])) {
      console.log('>>> pressing Stop');
      await evaluate(panel, `document.getElementById('stop').click()`);
      args['stop-after-ms'] = undefined;
    }
    const s = await evaluate(
      panel,
      `(() => ({
        stage: document.getElementById('stage').textContent,
        detail: document.getElementById('stageDetail').textContent,
        stageClass: document.getElementById('stage').className,
        sent: document.getElementById('sanitizedTask').textContent,
        vault: [...document.querySelectorAll('#vaultList li')].map(l => l.textContent),
        log: [...document.querySelectorAll('#log li')].map(l => l.className + ' | ' + l.textContent),
        prompt: !document.getElementById('prompt').classList.contains('hidden') && {
          title: document.getElementById('promptTitle').textContent,
          reasons: [...document.querySelectorAll('#promptReasons li')].map(l => l.textContent),
          yes: document.getElementById('promptYes').textContent,
        },
        running: document.getElementById('start').disabled,
      }))()`,
    );
    if (seenLog === 0 && s.sent) console.log(`[panel] ${s.sent}`);
    for (const l of s.log.slice(seenLog)) console.log(`[log] ${l}`);
    seenLog = s.log.length;
    if (s.prompt) {
      prompts++;
      console.log(`[prompt] ${s.prompt.title} ${JSON.stringify(s.prompt.reasons)}`);
      let click = 'promptNo';
      if (s.prompt.yes === 'Allow') click = args.confirm === 'allow' ? 'promptYes' : 'promptNo';
      else if (s.prompt.yes === 'Send answer' && args.answer) {
        await evaluate(panel, `document.getElementById('promptInput').value = ${JSON.stringify(String(args.answer))}`);
        click = 'promptYes';
      }
      console.log(`[prompt] → ${click === 'promptYes' ? 'yes' : 'no'}`);
      await evaluate(panel, `document.getElementById('${click}').click()`);
      if (prompts > 6) break;
    }
    if (!s.running && seenLog > 0) {
      console.log(`[panel] final stage: ${s.stage} — ${s.detail}; vault entries shown: ${s.vault.length}`);
      break;
    }
  }

  // Fixture-side assertions (the harness may know the demo site; VEIL may not).
  const fields = await evaluate(
    demo,
    `(() => Object.assign(
        Object.fromEntries(['fullName','email','phone','altEmail','address','pan'].map(id => [id, document.getElementById(id).value])),
        { saved: !document.getElementById('status').hidden && document.getElementById('status').textContent }))()`,
  );
  console.log('[demo page state]', JSON.stringify(fields));

  if (dash) {
    await sleep(1500);
    const d = await evaluate(
      dash,
      `(() => ({
        conn: document.getElementById('conn').textContent,
        privacy: document.getElementById('privacy').textContent,
        task: document.getElementById('task').textContent,
        stagesDone: [...document.querySelectorAll('#stages li.done, #stages li.active')].map(l => l.textContent),
        categories: document.getElementById('categories').textContent,
        vault: document.getElementById('vaultStatus').textContent,
        llm: document.getElementById('llm').textContent,
        validation: document.getElementById('validation').textContent,
        execution: document.getElementById('execution').innerText,
        payloadBytes: document.getElementById('payload').textContent.length,
        timeline: [...document.querySelectorAll('#timeline li')].map(l => l.innerText.replace(/\\s+/g, ' ')).reverse(),
      }))()`,
    );
    console.log('[dashboard]', JSON.stringify({ ...d, timeline: undefined }, null, 1));
    console.log('[dashboard timeline]\n  ' + d.timeline.join('\n  '));
    const text = await evaluate(dash, 'document.body.innerText');
    const canaries = ['Rahul Sharma', 'rahul.sharma@example.test', 'ABCPS1234K', '98765 43210', '9876543210', 'mehul.test@example.com', 'MG Road', 'Shivajinagar', '411005'];
    const found = canaries.filter((c) => text.toLowerCase().includes(c.toLowerCase()));
    console.log(`[dashboard] raw canary values visible: ${found.length}/${canaries.length}${found.length ? ' ' + JSON.stringify(found) : ''}`);
  }
}

main()
  .catch((e) => {
    console.error('E2E error:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await send('Browser.close');
    } catch {}
    await sleep(300);
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  });
