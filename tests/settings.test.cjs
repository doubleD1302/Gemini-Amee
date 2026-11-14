'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SettingsStore, DEFAULTS, RANGES, sanitize, validateCheckpointDir, clampInt } = require('../desktop/settings.cjs');
const { checkForUpdate, compareVersions, parseVersion, safeReleaseUrl, REPO, RELEASES_URL } = require('../desktop/update-check.cjs');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge, loadOrCreateState, saveState } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/* ---------- settings ---------- */
test('sanitize clamps every value into its safe range and ignores junk', () => {
  assert.deepEqual(sanitize(null), { ...DEFAULTS });
  assert.deepEqual(sanitize('x'), { ...DEFAULTS });
  const s = sanitize({ maxTurns: 100000, contextBudgetChars: -5, contextFiles: '7', contextChars: 'abc', bridgePort: 80, checkpointDir: 42, extra: 'x' });
  assert.equal(s.maxTurns, RANGES.maxTurns[1]);
  assert.equal(s.contextBudgetChars, RANGES.contextBudgetChars[0]);
  assert.equal(s.contextFiles, 7);
  assert.equal(s.contextChars, DEFAULTS.contextChars);
  assert.equal(s.bridgePort, RANGES.bridgePort[0], 'privileged ports are never used');
  assert.equal(s.checkpointDir, '');
  assert.equal('extra' in s, false);
  assert.equal(clampInt('12abc', [1, 20], 5), 5);
  assert.equal(clampInt(3.6, [1, 20], 5), 4);
  assert.equal(sanitize({ checkpointDir: 'a\0b' }).checkpointDir, '');
});

test('SettingsStore: strict validation on set, atomic persistence, restart flags, corrupt/oversized files fall back to defaults', () => {
  const dir = tmp('gps-set-');
  const file = path.join(dir, 'settings.json');
  const st = new SettingsStore(file);
  assert.deepEqual(st.get(), { ...DEFAULTS });
  const r = st.set({ maxTurns: 40, contextFiles: '20' });
  assert.deepEqual(r.restartRequired, []);
  assert.equal(r.settings.maxTurns, 40);
  assert.equal(r.settings.contextFiles, 20);
  assert.equal(new SettingsStore(file).get().maxTurns, 40, 'persisted');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'atomic write leaves no temp file');
  assert.deepEqual(st.set({ bridgePort: 50000 }).restartRequired, ['bridgePort']);
  assert.deepEqual(st.set({ bridgePort: 50000 }).restartRequired, [], 'unchanged value needs no restart');
  for (const bad of [{ maxTurns: 1 }, { maxTurns: 1000 }, { maxTurns: 'abc' }, { maxTurns: 12.5 }, { maxTurns: null }, { bridgePort: 80 }, { bridgePort: 70000 }, { contextBudgetChars: 10 }, { nope: 1 }]) {
    assert.throws(() => st.set(bad), /phải là số nguyên từ|Cài đặt không tồn tại/, JSON.stringify(bad));
  }
  assert.equal(st.get().maxTurns, 40, 'a rejected patch changes nothing');
  assert.equal(new SettingsStore(file).get().bridgePort, 50000);
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new SettingsStore(file).get(), { ...DEFAULTS });
  fs.writeFileSync(file, JSON.stringify({ maxTurns: 9999, junk: 'x'.repeat(70000) }));
  assert.deepEqual(new SettingsStore(file).get(), { ...DEFAULTS }, 'oversized file ignored');
  fs.writeFileSync(file, JSON.stringify({ maxTurns: 9999, bridgePort: 22 }));
  const clamped = new SettingsStore(file).get();
  assert.equal(clamped.maxTurns, 100);
  assert.equal(clamped.bridgePort, 1025);
  assert.deepEqual(st.reset(), { ...DEFAULTS });
  assert.ok(!fs.existsSync(file));
});

test('checkpoint directory must be absolute, writable, not a drive root, and OUTSIDE (and not containing) the project', () => {
  const base = tmp('gps-cp-');
  const project = path.join(base, 'proj');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  assert.equal(validateCheckpointDir('', project), '');
  assert.equal(validateCheckpointDir('   ', project), '');
  assert.throws(() => validateCheckpointDir('relative/dir', project), /tuyệt đối/);
  assert.throws(() => validateCheckpointDir(path.parse(base).root, project), /thư mục gốc của ổ đĩa/);
  assert.throws(() => validateCheckpointDir(path.join(project, 'checkpoints'), project), /NGOÀI thư mục dự án/);
  assert.throws(() => validateCheckpointDir(project, project), /NGOÀI thư mục dự án/);
  assert.throws(() => validateCheckpointDir(base, project), /không được chứa dự án/, 'a folder that contains the project is also refused');
  assert.throws(() => validateCheckpointDir('x\0y', project), /không hợp lệ/);
  assert.throws(() => validateCheckpointDir('/' + 'a'.repeat(600), project), /không hợp lệ/);
  const ok = path.join(tmp('gps-cp-out-'), 'my', 'checkpoints');
  assert.equal(validateCheckpointDir(ok, project), path.resolve(ok));
  assert.ok(fs.existsSync(ok));
  assert.deepEqual(fs.readdirSync(ok), [], 'the write probe is removed');
  const file = path.join(base, 'f.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => validateCheckpointDir(path.join(file, 'sub'), project), /Không ghi được/);
  // qua SettingsStore
  const st = new SettingsStore(path.join(base, 's.json'));
  assert.throws(() => st.set({ checkpointDir: path.join(project, 'cp') }, { projectRoot: project }), /NGOÀI/);
  assert.equal(st.get().checkpointDir, '');
  assert.deepEqual(st.set({ checkpointDir: ok }, { projectRoot: project }).restartRequired, ['checkpointDir']);
});

test('bridge port: saveState persists a new port without changing the token (so only the extension needs re-pairing)', () => {
  const file = path.join(tmp('gps-port-'), 'bridge-state.json');
  const a = loadOrCreateState(file);
  saveState(file, { ...a, port: 51234 });
  const b = loadOrCreateState(file);
  assert.equal(b.token, a.token);
  assert.equal(b.port, 51234);
});

/* ---------- áp dụng ngay ---------- */
test('live limits: runner.setLimits and workspace.configureContext take effect without a restart, and refuse out-of-range values', () => {
  const runner = new AgentRunner({ bridge: new Bridge(), workspace, tools, checkpoints: new CheckpointStore(tmp('gps-cp-')), getRoot: () => null, maxTurns: 25, contextBudgetChars: 240000 });
  runner.setLimits({ maxTurns: 40, contextBudgetChars: 100000 });
  assert.equal(runner.snapshot().maxTurns, 40);
  assert.equal(runner.snapshot().context.budgetChars, 100000);
  runner.setLimits({ maxTurns: 3, contextBudgetChars: 5 });
  assert.equal(runner.snapshot().maxTurns, 40, 'out of range ignored');
  assert.equal(runner.snapshot().context.budgetChars, 100000);
  runner.dispose();

  const dir = tmp('gps-ctx-');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(30));
  try {
    assert.deepEqual(workspace.configureContext({ files: 2, chars: 20000 }), { files: 2, chars: 20000 });
    assert.equal(workspace.buildContext(dir, 'v1 v2 v3 v4').included.length, 2);
    workspace.configureContext({ files: 5 });
    assert.equal(workspace.buildContext(dir, 'v1 v2 v3 v4').included.length, 5);
    assert.equal(workspace.buildContext(dir, 'v1 v2 v3 v4', { maxFiles: 1 }).included.length, 1, 'explicit options still win');
    assert.deepEqual(workspace.configureContext({ files: 999, chars: 1 }), { files: 5, chars: 20000 }, 'invalid values are ignored');
  } finally { workspace.configureContext({ files: workspace.limits.CONTEXT_DEFAULT_FILES, chars: workspace.limits.CONTEXT_DEFAULT_CHARS }); }
  assert.equal(workspace.limits.CONTEXT_DEFAULT_FILES, 12, 'the documented default constant is unchanged');
});

/* ---------- kiểm tra cập nhật ---------- */
test('version comparison: semver with optional v prefix; pre-releases are older than the release; junk is null', () => {
  assert.equal(compareVersions('0.3.0', '0.2.0'), 1);
  assert.equal(compareVersions('v1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1, 'numeric, not lexical');
  assert.equal(compareVersions('0.3.0-beta.1', '0.3.0'), -1);
  assert.equal(compareVersions('0.3.0', '0.3.0-beta.1'), 1);
  assert.equal(compareVersions('latest', '0.2.0'), null);
  assert.equal(compareVersions('1.2', '1.2.0'), null);
  assert.equal(compareVersions('1.2.3; rm -rf /', '1.2.3'), null);
  assert.equal(parseVersion('1.2.3-rc.1+build5').pre, 'rc.1');
  assert.equal(parseVersion(undefined), null);
});

test('safeReleaseUrl only accepts this repo\'s release pages on github.com', () => {
  for (const ok of [`https://github.com/${REPO}/releases`, `https://github.com/${REPO}/releases/tag/v0.3.0`, `https://github.com/${REPO}/releases/download/v1/x.exe`]) assert.equal(safeReleaseUrl(ok), ok);
  for (const bad of ['', 'http://github.com/' + REPO + '/releases', 'https://evil.com/' + REPO + '/releases', 'https://github.com.evil.com/' + REPO + '/releases', 'https://github.com/other/repo/releases',
    `https://github.com/${REPO}/releases@evil.com`, `https://user:pw@github.com/${REPO}/releases`, `https://github.com/${REPO}/issues`, `https://github.com/${REPO}/releases/../../evil`, 'javascript:alert(1)', 'file:///c:/x', 'not a url']) {
    assert.equal(safeReleaseUrl(bad), '', bad);
  }
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
test('checkForUpdate: update / latest / no releases / errors / hostile payloads — never throws, never trusts the response', async () => {
  const seen = [];
  const mk = (status, body) => async (url, opts) => { seen.push({ url, opts }); return res(status, body); };
  let r = await checkForUpdate('0.2.0', { fetchFn: mk(200, { tag_name: 'v0.3.0', html_url: `https://github.com/${REPO}/releases/tag/v0.3.0` }) });
  assert.equal(r.status, 'update');
  assert.equal(r.latest, '0.3.0');
  assert.equal(r.url, `https://github.com/${REPO}/releases/tag/v0.3.0`);
  assert.match(r.message, /không tự tải hay cài đặt/);
  assert.equal(seen[0].url, `https://api.github.com/repos/${REPO}/releases/latest`);
  assert.equal(seen[0].opts.redirect, 'error');
  assert.equal(seen[0].opts.headers['User-Agent'], 'GeminiProjectStudio-UpdateCheck');
  assert.ok(!JSON.stringify(seen[0].opts).match(/token|@|chann|doubleD/i), 'nothing about the user is sent');
  r = await checkForUpdate('0.3.0', { fetchFn: mk(200, { tag_name: 'v0.3.0', html_url: 'x' }) });
  assert.equal(r.status, 'latest');
  r = await checkForUpdate('0.4.0', { fetchFn: mk(200, { tag_name: 'v0.3.0' }) });
  assert.equal(r.status, 'latest', 'running a newer dev build is not an "update"');
  r = await checkForUpdate('0.2.0', { fetchFn: mk(404, {}) });
  assert.equal(r.status, 'unknown'); assert.match(r.message, /chưa có bản phát hành/);
  r = await checkForUpdate('0.2.0', { fetchFn: mk(500, {}) });
  assert.equal(r.status, 'unknown'); assert.match(r.message, /lỗi 500/);
  r = await checkForUpdate('0.2.0', { fetchFn: mk(200, { tag_name: 'totally-not-semver', html_url: 'https://evil.com' }) });
  assert.equal(r.status, 'unknown'); assert.equal(r.url, RELEASES_URL);
  r = await checkForUpdate('0.2.0', { fetchFn: mk(200, { tag_name: 'v9.9.9', html_url: 'https://evil.com/download.exe' }) });
  assert.equal(r.status, 'update');
  assert.equal(r.url, RELEASES_URL, 'a foreign html_url is replaced by the repo release page');
  r = await checkForUpdate('0.2.0', { fetchFn: mk(200, null) });
  assert.equal(r.status, 'unknown');
  r = await checkForUpdate('0.2.0', { fetchFn: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(r.status, 'unknown'); assert.match(r.message, /ENOTFOUND/);
  r = await checkForUpdate('0.2.0', { timeoutMs: 30, fetchFn: (url, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); })) });
  assert.equal(r.status, 'unknown'); assert.match(r.message, /quá thời gian/);
});

/* ---------- đóng gói ---------- */
test('packaging config: only app code is bundled, nothing is auto-published, names match what the scripts expect, signing is documented without secrets', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.build.files, ['dist/**/*', 'desktop/**/*', 'public/**/*', 'package.json'], 'no node_modules/tests/docs in app.asar');
  assert.equal(pkg.build.publish, null, 'electron-builder never publishes by itself');
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.nsis.artifactName, '${productName} Setup ${version}.${ext}');
  assert.match(read('scripts/update-installed.ps1'), /Setup \$version\.exe/, 'update script computes the same installer name');
  assert.equal(pkg.repository.url, `https://github.com/${REPO}.git`);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies at all: the UI is bundled by vite, so electron-builder packs no node_modules');
  for (const lib of ['react', 'react-dom', 'lucide-react']) assert.ok(pkg.devDependencies[lib], lib + ' is a build-time dependency');
  const doc = read('docs/PACKAGING.md');
  for (const needle of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'Get-AuthenticodeSignature', 'không tự cập nhật', 'PROTOCOL']) assert.ok(doc.includes(needle), needle);
  assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY|\.pfx['"]?\s*:\s*['"][A-Za-z0-9+/=]{40,}/.test(doc), 'no secrets in the docs');
  const main = read('desktop/main.cjs');
  assert.match(main, /require\('\.\.\/package\.json'\)\.version/);
});
