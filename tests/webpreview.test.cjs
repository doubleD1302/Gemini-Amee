'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebPreview, validateUrl, isLocalHost, isAllowedNavigation, PARTITION, MAX_WIDTH } = require('../desktop/web-preview.cjs');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/** Cửa sổ Electron giả: ghi lại cấu hình bảo mật và các handler được đăng ký. */
function fakeWindowFactory(log = {}) {
  return options => {
    log.options = options;
    const win = new EventEmitter();
    let destroyed = false;
    const session = new EventEmitter();
    session.setPermissionRequestHandler = fn => { log.permissionRequest = fn; };
    session.setPermissionCheckHandler = fn => { log.permissionCheck = fn; };
    const wc = new EventEmitter();
    Object.assign(wc, {
      session,
      setWindowOpenHandler: fn => { log.openHandler = fn; },
      loadURL: async url => { if (log.failLoad) throw new Error('ERR_CONNECTION_REFUSED'); log.loaded = (log.loaded || []).concat(url); log.current = url; },
      getURL: () => log.current || '',
      getTitle: () => 'Trang thử',
      capturePage: async () => ({
        isEmpty: () => !!log.emptyShot,
        getSize: () => ({ width: log.width || 800, height: 600 }),
        resize: o => { log.resizedTo = o.width; return { isEmpty: () => false, getSize: () => ({ width: o.width, height: 450 }), toPNG: () => PNG }; },
        toPNG: () => PNG
      })
    });
    win.webContents = wc;
    win.isDestroyed = () => destroyed;
    win.close = () => { destroyed = true; win.emit('closed'); };
    log.win = win;
    return win;
  };
}

test('validateUrl accepts only http(s) to this machine and rejects everything else', () => {
  for (const [input, expected] of [
    ['http://localhost:5173', 'http://localhost:5173/'], ['localhost:3000/app', 'http://localhost:3000/app'], ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['http://[::1]:3000/', 'http://[::1]:3000/'], ['https://localhost:8443/x?y=1', 'https://localhost:8443/x?y=1'], ['http://app.localhost:4000', 'http://app.localhost:4000/'], ['  http://LOCALHOST:5173  ', 'http://localhost:5173/']
  ]) assert.equal(validateUrl(input), expected, input);
  for (const bad of [
    '', '   ', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://localhost/x', 'about:blank', 'chrome://settings', 'view-source:http://localhost',
    'http://example.com', 'https://google.com/search', 'http://localhost.evil.com', 'http://evil.com/localhost', 'http://127.0.0.1.evil.com', 'http://notlocalhost',
    'http://user:pass@localhost:3000', 'http://localhost@evil.com', 'http://evil.com#@localhost', 'http://0.0.0.0:3000', 'http://192.168.1.10:3000', 'http://10.0.0.1',
    'http://localhost:99999', 'x'.repeat(2500), 'http://[::2]/', 'http://localhost\u0000.evil.com'
  ]) assert.throws(() => validateUrl(bad), /Chỉ|Địa chỉ|Hãy nhập|không hợp lệ/, JSON.stringify(bad).slice(0, 60));
  assert.equal(isLocalHost('LOCALHOST'), true);
  assert.equal(isLocalHost('a.b.localhost'), true);
  assert.equal(isLocalHost('localhost.evil.com'), false);
  assert.equal(isAllowedNavigation('http://localhost:1/'), true);
  assert.equal(isAllowedNavigation('http://evil.com/'), false);
});

test('the preview window is created locked down: sandbox, no node, in-memory partition, no popups, no permissions, no downloads', async () => {
  const log = {};
  const p = new WebPreview({ createWindow: fakeWindowFactory(log) });
  assert.deepEqual(p.status(), { open: false, url: '' });
  const st = await p.open('localhost:5173');
  assert.deepEqual(st, { open: true, url: 'http://localhost:5173/' });
  const wp = log.options.webPreferences;
  assert.equal(wp.sandbox, true); assert.equal(wp.contextIsolation, true); assert.equal(wp.nodeIntegration, false); assert.equal(wp.webSecurity, true);
  assert.equal(wp.partition, PARTITION);
  assert.ok(!PARTITION.startsWith('persist:'), 'in-memory session: no cookies/localStorage survive or leak into Studio');
  assert.equal(wp.preload, undefined, 'no preload → the page cannot reach the Studio IPC');
  assert.deepEqual(log.openHandler({ url: 'https://evil.com' }), { action: 'deny' });
  // điều hướng: chặn host lạ (cả will-navigate và will-redirect), cho phép localhost
  for (const evt of ['will-navigate', 'will-redirect']) {
    const bad = { prevented: false, preventDefault() { this.prevented = true; } };
    log.win.webContents.emit(evt, bad, 'https://evil.com/phish');
    assert.equal(bad.prevented, true, evt + ' to a foreign host is blocked');
    const ok = { prevented: false, preventDefault() { this.prevented = true; } };
    log.win.webContents.emit(evt, ok, 'http://localhost:5173/other');
    assert.equal(ok.prevented, false);
  }
  const wv = { prevented: false, preventDefault() { this.prevented = true; } };
  log.win.webContents.emit('will-attach-webview', wv);
  assert.equal(wv.prevented, true);
  let granted = 'unset';
  log.permissionRequest({}, 'media', v => { granted = v; });
  assert.equal(granted, false);
  assert.equal(log.permissionCheck(), false);
  const dl = { prevented: false, preventDefault() { this.prevented = true; } };
  log.win.webContents.session.emit('will-download', dl);
  assert.equal(dl.prevented, true);
});

test('open() refuses non-local URLs BEFORE creating any window, reports load failures, and reuses one window', async () => {
  const log = {};
  let created = 0;
  const factory = fakeWindowFactory(log);
  const p = new WebPreview({ createWindow: o => { created++; return factory(o); } });
  await assert.rejects(() => p.open('https://evil.com'), /Chỉ xem trước được trang chạy trên máy này/);
  await assert.rejects(() => p.open('file:///C:/Windows/win.ini'), /Chỉ hỗ trợ http/);
  assert.equal(created, 0);
  log.failLoad = true;
  await assert.rejects(() => p.open('localhost:5173'), /Không tải được http:\/\/localhost:5173\/[\s\S]*dev server đã chạy chưa/);
  log.failLoad = false;
  await p.open('localhost:5173');
  await p.open('localhost:3000');
  assert.equal(created, 1, 'one window is reused');
  assert.deepEqual(log.loaded, ['http://localhost:5173/', 'http://localhost:3000/']);
  p.close();
  assert.equal(p.status().open, false);
  await p.open('localhost:3000');
  assert.equal(created, 2);
  log.win.close();   // người dùng tự đóng cửa sổ
  assert.deepEqual(p.status(), { open: false, url: '' });
});

test('capture needs an open page, downsizes wide screenshots and returns a PNG', async () => {
  const log = { width: 2400 };
  const changes = [];
  const p = new WebPreview({ createWindow: fakeWindowFactory(log), onChange: s => changes.push(s) });
  await assert.rejects(() => p.capture(), /Chưa mở trang xem trước/);
  await p.open('localhost:5173');
  const shot = await p.capture();
  assert.equal(log.resizedTo, MAX_WIDTH);
  assert.equal(shot.width, MAX_WIDTH);
  assert.equal(shot.title, 'Trang thử');
  assert.equal(shot.url, 'http://localhost:5173/');
  assert.deepEqual(shot.png, PNG);
  log.width = 600; log.resizedTo = undefined;
  assert.equal((await p.capture()).width, 600);
  assert.equal(log.resizedTo, undefined, 'small screenshots are not resized');
  log.emptyShot = true;
  await assert.rejects(() => p.capture(), /Không chụp được trang/);
  assert.ok(changes.some(c => c.open));
});

/* ---------- Agent ---------- */
function makeEnv(root, script, preview) {
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(path.dirname(root), 'cp')), getRoot: () => root, detectChecks: () => [], preview });
  const turns = [];
  const events = [];
  bridge.on('job', pub => {
    events.push(pub);
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const info = { prompt: job.prompt, images: job.attachments.map(a => ({ ...a })) };
    const idx = turns.push(info) - 1;
    setImmediate(async () => {
      if (job.status === 'cancelled') return;
      const answer = await script(info, idx);
      if (answer == null || job.status === 'cancelled') return;
      bridge.setJob(job, { status: 'final', answer, conversationUrl: 'https://gemini.google.com/app/convX' });
    });
  });
  return { runner, turns, events };
}
function until(runner, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => { const s = runner.snapshot(); if (pred(s)) { runner.removeListener('state', check); clearTimeout(t); resolve(s); } };
    const t = setTimeout(() => { runner.removeListener('state', check); reject(new Error('timeout; status=' + runner.snapshot().status)); }, ms);
    runner.on('state', check); check();
  });
}
function project() {
  const base = tmp('gps-wp-');
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return root;
}

test('agent: preview_open and preview_screenshot ALWAYS need approval; the screenshot rides on the NEXT message and never leaks into events or the project', async () => {
  const root = project();
  const log = {};
  const preview = new WebPreview({ createWindow: fakeWindowFactory(log) });
  const env = makeEnv(root, async (t, i) => {
    if (i === 0) return call('tool: preview_open\nurl: localhost:5173');
    if (i === 1) return call('tool: preview_screenshot');
    return call('tool: finish\n---\nxong');
  }, preview);
  const before = fs.readdirSync(root, { recursive: true }).sort();
  env.runner.setPolicy({ autoEdits: true });
  env.runner.start('xem giao diện');
  const w1 = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w1.pending[0].kind, 'exec');
  assert.equal(w1.pending[0].tool, 'preview_open');
  assert.equal(w1.pending[0].label, 'http://localhost:5173/');
  assert.equal(preview.status().open, false, 'nothing opens before approval');
  await assert.rejects(() => env.runner.approve(w1.pending[0].id, 'approve_all_edits'), /chỉ.*sửa file/i);
  await env.runner.approve(w1.pending[0].id, 'approve');
  const w2 = await until(env.runner, s => s.status === 'waiting_approval' && s.pending[0] && s.pending[0].tool === 'preview_screenshot');
  assert.match(w2.pending[0].label, /^chụp http:\/\/localhost:5173\//);
  assert.equal(env.turns[1].images.length, 0, 'no image before the screenshot is approved');
  await env.runner.approve(w2.pending[0].id, 'approve');
  const done = await until(env.runner, s => s.status === 'done');
  assert.equal(env.turns.length, 3);
  assert.equal(env.turns[2].images.length, 1, 'the screenshot is attached to the message that carries the tool result');
  assert.equal(env.turns[2].images[0].mime, 'image/png');
  assert.equal(env.turns[2].images[0].data, PNG.toString('base64'));
  assert.match(env.turns[2].prompt, /OK: đã chụp http:\/\/localhost:5173\/ \(800×600\)[\s\S]*đính kèm ảnh/);
  assert.ok(!JSON.stringify(done).includes(PNG.toString('base64')), 'snapshot carries no image bytes');
  for (const ev of env.events) assert.ok(!JSON.stringify(ev).includes(PNG.toString('base64')), 'no image bytes in broadcast job events');
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before, 'the project folder is untouched');
  env.runner.dispose();
});

test('agent: a rejected screenshot captures nothing; bad URLs and a closed preview are clear tool errors', async () => {
  const root = project();
  const log = {};
  const preview = new WebPreview({ createWindow: fakeWindowFactory(log) });
  const env = makeEnv(root, async (t, i) => {
    if (i === 0) return [call('tool: preview_open\nurl: https://evil.com'), call('tool: preview_screenshot')].join('\n');
    return call('tool: finish\n---\nok');
  }, preview);
  env.runner.start('x');
  await until(env.runner, s => s.status === 'done');
  assert.match(env.turns[1].prompt, /tool=preview_open status=error[\s\S]*Chỉ xem trước được trang chạy trên máy này/);
  assert.match(env.turns[1].prompt, /tool=preview_screenshot status=skipped|tool=preview_screenshot status=error/);
  assert.equal(log.options, undefined, 'no window was ever created');
  env.runner.dispose();
  const noPreview = makeEnv(root, async (t, i) => (i === 0 ? call('tool: preview_open\nurl: localhost:3000') : call('tool: finish\n---\nok')), null);
  noPreview.runner.start('x');
  await until(noPreview.runner, s => s.status === 'done');
  assert.match(noPreview.turns[1].prompt, /Xem trước web chưa được bật/);
  noPreview.runner.dispose();
  // người dùng từ chối chụp
  const log2 = {};
  const p2 = new WebPreview({ createWindow: fakeWindowFactory(log2) });
  await p2.open('localhost:5173');
  const rej = makeEnv(root, async (t, i) => (i === 0 ? call('tool: preview_screenshot') : call('tool: finish\n---\nok')), p2);
  rej.runner.start('x');
  const w = await until(rej.runner, s => s.status === 'waiting_approval');
  await rej.runner.approve(w.pending[0].id, 'reject', 'không chụp');
  await until(rej.runner, s => s.status === 'done');
  assert.equal(rej.turns[1].images.length, 0);
  assert.match(rej.turns[1].prompt, /status=rejected/);
  rej.runner.dispose();
});

test('agent: if the extension cannot attach the screenshot, the retry tells the model it did NOT receive an image', async () => {
  const root = project();
  const preview = new WebPreview({ createWindow: fakeWindowFactory({}) });
  await preview.open('localhost:5173');
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(path.dirname(root), 'cp')), getRoot: () => root, detectChecks: () => [], preview });
  const prompts = [];
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    prompts.push({ prompt: job.prompt, n: job.attachments.length });
    const idx = prompts.length - 1;
    setImmediate(() => {
      if (idx === 0) bridge.setJob(job, { status: 'final', answer: call('tool: preview_screenshot'), conversationUrl: 'https://gemini.google.com/app/c1' });
      else if (idx === 1) bridge.setJob(job, { status: 'error', code: 'attachment_failed', answer: 'Không đính kèm được ảnh.' });
      else bridge.setJob(job, { status: 'final', answer: call('tool: finish\n---\nxong'), conversationUrl: 'https://gemini.google.com/app/c1' });
    });
  });
  runner.start('x');
  const w = await until(runner, s => s.status === 'waiting_approval');
  await runner.approve(w.pending[0].id, 'approve');
  await until(runner, s => s.status === 'error');
  assert.equal(prompts[1].n, 1);
  runner.retry();
  await until(runner, s => s.status === 'done');
  assert.equal(prompts[2].n, 0);
  assert.match(prompts[2].prompt, /ảnh đính kèm KHÔNG gửi được tới bạn/);
  runner.dispose();
});
