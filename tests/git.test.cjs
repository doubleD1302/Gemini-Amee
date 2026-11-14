'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../desktop/git.cjs');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const { Bridge } = require('../desktop/bridge.cjs');
const { CheckpointStore } = require('../desktop/checkpoints.cjs');
const { AgentRunner } = require('../desktop/agent.cjs');
const F = '`'.repeat(3);
const call = body => `${F}gps-tool\n${body}\n${F}`;

let HAS_GIT = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { HAS_GIT = false; }
const gitTest = (name, fn) => test(name, { skip: HAS_GIT ? false : 'git is not installed' }, fn);

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
function repo({ sub = '' } = {}) {
  const top = fs.realpathSync(tmp('gps-git-'));
  G(top, 'init', '-q');
  G(top, 'config', 'user.name', 'Test');
  G(top, 'config', 'user.email', 'test@example.com');
  G(top, 'config', 'commit.gpgsign', 'false');
  const root = sub ? path.join(top, sub) : top;
  put(root, 'src/a.ts', 'export const a = 1;\n');
  put(root, 'src/b.ts', 'export const b = 1;\n');
  put(root, 'README.md', '# x\n');
  G(top, 'add', '-A');
  G(top, 'commit', '-q', '-m', 'init');
  return { top, root };
}
const headFiles = top => G(top, 'show', '--name-only', '--no-renames', '--format=', 'HEAD').split(/\r?\n/).filter(Boolean).sort();
const count = top => Number(G(top, 'rev-list', '--count', 'HEAD'));

/* ---------- parseStatus (thuần hàm) ---------- */
test('parseStatus: branch line variants, XY codes, renames, untracked, conflicts, prefix stripping, truncation', () => {
  const z = (...r) => r.join('\0') + '\0';
  let s = git.parseStatus(z('## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'M  src/b.ts', 'MM c.ts', 'A  new.ts', ' D gone.ts', '?? tmp/x.txt', 'R  renamed.ts', 'old name.ts', 'UU conflict.ts'));
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  const by = Object.fromEntries(s.files.map(f => [f.path, f]));
  assert.equal(by['src/a.ts'].label, 'sửa'); assert.equal(by['src/a.ts'].staged, false); assert.equal(by['src/a.ts'].unstaged, true);
  assert.equal(by['src/b.ts'].staged, true); assert.equal(by['src/b.ts'].unstaged, false);
  assert.equal(by['c.ts'].staged && by['c.ts'].unstaged, true);
  assert.equal(by['new.ts'].label, 'thêm');
  assert.equal(by['gone.ts'].label, 'xoá');
  assert.equal(by['tmp/x.txt'].untracked, true);
  assert.equal(by['renamed.ts'].origPath, 'old name.ts');
  assert.equal(by['renamed.ts'].label, 'đổi tên');
  assert.equal(by['conflict.ts'].conflict, true);
  assert.equal(s.files.length, 8, 'the rename consumed its second record (8 entries, not 9 records)');
  s = git.parseStatus(z('## No commits yet on trunk', '?? a'));
  assert.equal(s.noCommits, true); assert.equal(s.branch, 'trunk');
  s = git.parseStatus(z('## HEAD (no branch)'));
  assert.equal(s.detached, true);
  s = git.parseStatus(z('## main', ' M sub/in.ts', ' M other/out.ts', 'R  sub/new.ts', 'other/old.ts'), 'sub/');
  assert.deepEqual(s.files.map(f => f.path), ['in.ts', 'new.ts']);
  assert.equal(s.files[1].origPath, null, 'origin outside the project is not exposed');
  assert.equal(s.outside, 1);
  const many = z('## main', ...Array.from({ length: 600 }, (_, i) => ` M f${i}.ts`));
  s = git.parseStatus(many);
  assert.equal(s.files.length, 500); assert.equal(s.truncated, true);
  assert.deepEqual(git.parseStatus('').files, []);
});

/* ---------- repo thật ---------- */
gitTest('status and diff on a real repository (modified, deleted, untracked, renamed, staged)', async () => {
  const { root } = repo();
  assert.deepEqual((await git.status(root)).files, []);
  put(root, 'src/a.ts', 'export const a = 2;\n');
  fs.rmSync(path.join(root, 'src', 'b.ts'));
  put(root, 'notes/todo.txt', 'một\nhai\n');
  G(root, 'mv', 'README.md', 'DOC.md');
  const st = await git.status(root);
  assert.equal(st.repo, true);
  assert.equal(st.branch.length > 0, true);
  const by = Object.fromEntries(st.files.map(f => [f.path, f]));
  assert.equal(by['src/a.ts'].label, 'sửa');
  assert.equal(by['src/b.ts'].label, 'xoá');
  assert.equal(by['notes/todo.txt'].untracked, true);
  assert.equal(by['DOC.md'].origPath, 'README.md');
  const d = await git.diff(root, { path: 'src/a.ts' });
  assert.match(d.diff, /-export const a = 1;/);
  assert.match(d.diff, /\+export const a = 2;/);
  const u = await git.diff(root, { path: 'notes/todo.txt' });
  assert.equal(u.untracked, true);
  assert.match(u.diff, /\+một/);
  G(root, 'add', 'src/a.ts');
  assert.match((await git.diff(root, { path: 'src/a.ts', staged: true })).diff, /\+export const a = 2;/);
  assert.equal((await git.diff(root, { path: 'src/a.ts' })).diff.trim(), '', 'nothing unstaged left for that file');
  assert.ok((await git.diff(root, {})).diff.includes('src/b.ts'), 'whole-repo diff');
  await assert.rejects(() => git.diff(root, { path: '.env' }), /bị chặn/);
  await assert.rejects(() => git.diff(root, { path: '../outside.txt' }), /bị chặn/);
});

gitTest('a folder that is not inside a git repository reports repo:false instead of failing', async () => {
  const dir = fs.realpathSync(tmp('gps-nogit-'));
  const st = await git.status(dir);
  assert.equal(st.repo, false);
  assert.match(st.reason, /không nằm trong một kho git/);
  await assert.rejects(() => git.diff(dir, {}), /không nằm trong một kho git/);
  await assert.rejects(() => git.commit(dir, { message: 'x', paths: ['a'] }), /không nằm trong một kho git/);
});

gitTest('commit includes EXACTLY the chosen paths (other staged files stay staged), renames keep both sides, nothing is pushed', async () => {
  const { top, root } = repo();
  put(root, 'src/a.ts', 'export const a = 2;\n');
  put(root, 'src/b.ts', 'export const b = 2;\n');
  put(root, 'new.ts', 'export const n = 1;\n');
  G(root, 'add', 'src/b.ts');                       // đã staged nhưng KHÔNG được chọn
  const before = count(top);
  const r = await git.commit(root, { message: 'Chỉ sửa a và thêm new', paths: ['src/a.ts', 'new.ts'] });
  assert.equal(r.ok, true);
  assert.match(r.hash, /^[0-9a-f]{4,}$/);
  assert.equal(count(top), before + 1);
  assert.deepEqual(headFiles(top), ['new.ts', 'src/a.ts']);
  assert.equal(G(top, 'log', '-1', '--format=%s'), 'Chỉ sửa a và thêm new');
  const st = await git.status(root);
  assert.deepEqual(st.files.map(f => [f.path, f.staged]), [['src/b.ts', true]], 'the unselected staged file is still pending');
  // đổi tên: chọn đường dẫn mới là đủ (cả hai phía được commit)
  G(root, 'mv', 'README.md', 'DOC.md');
  await git.commit(root, { message: 'Đổi tên README', paths: ['DOC.md'] });
  assert.deepEqual(headFiles(top), ['DOC.md', 'README.md']);
  assert.ok(!fs.existsSync(path.join(top, '.git', 'refs', 'remotes')) || fs.readdirSync(path.join(top, '.git', 'refs', 'remotes')).length === 0, 'no remote refs were touched');
});

gitTest('planCommit rejects empty/oversized messages, unknown/blocked/conflicting paths and too many paths — before anything is staged', async () => {
  const { top, root } = repo();
  put(root, 'src/a.ts', 'export const a = 2;\n');
  put(root, '.env', 'SECRET=1\n');
  put(root, 'server.pem', 'KEY\n');
  const idx0 = G(top, 'diff', '--cached', '--name-only');
  await assert.rejects(() => git.planCommit(root, { message: '   ', paths: ['src/a.ts'] }), /Thiếu thông điệp/);
  await assert.rejects(() => git.planCommit(root, { message: 'x'.repeat(git.MAX_MESSAGE + 1), paths: ['src/a.ts'] }), /quá dài/);
  await assert.rejects(() => git.planCommit(root, { message: 'm\0x', paths: ['src/a.ts'] }), /không hợp lệ/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: [] }), /ít nhất một file/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: 'src/a.ts' }), /ít nhất một file/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: ['src/zzz.ts'] }), /không có thay đổi nào/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: ['src/a.ts', '../x'] }), /không có thay đổi nào/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: ['.env'] }), /bị chặn/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: ['server.pem'] }), /bị chặn/);
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: Array.from({ length: git.MAX_COMMIT_PATHS + 1 }, (_, i) => `f${i}`) }), /Tối đa 200/);
  await assert.rejects(() => git.commit(root, { message: 'm', paths: ['src/a.ts', '.env'] }), /bị chặn/);
  assert.equal(G(top, 'diff', '--cached', '--name-only'), idx0, 'a rejected commit staged nothing (not even the allowed path)');
  assert.equal(count(top), 1);
  const ok = await git.planCommit(root, { message: ' Có khoảng trắng \r\n', paths: ['src/a.ts', 'src/a.ts'] });
  assert.equal(ok.message, 'Có khoảng trắng');
  assert.deepEqual(ok.paths, ['src/a.ts'], 'duplicates collapse');
});

gitTest('hardening: a hostile repo config cannot run commands through status/diff, and repo hooks are OFF unless explicitly enabled', async () => {
  const { top, root } = repo();
  const marker = path.join(top, 'PWNED-fsmonitor');
  const script = path.join(top, 'evil-fsmonitor.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('\\0');`);
  G(top, 'config', 'core.fsmonitor', `node ${script.replace(/\\/g, '/')}`);
  put(root, 'src/a.ts', 'export const a = 2;\n');
  await git.status(root);
  await git.diff(root, { path: 'src/a.ts' });
  assert.ok(!fs.existsSync(marker), 'core.fsmonitor from the repo config was NOT executed by Studio');
  // so sánh: git thường (không làm cứng) có chạy nó không? Nếu không chạy trên máy này thì khẳng định trên chỉ mang tính phòng thủ.
  try { execFileSync('git', ['status'], { cwd: top, stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  const plainGitRuns = fs.existsSync(marker);
  fs.rmSync(marker, { force: true });
  G(top, 'config', '--unset', 'core.fsmonitor');
  // hook
  const hookMarker = path.join(top, 'PWNED-hook');
  const hook = path.join(top, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho x > "${hookMarker.replace(/\\/g, '/')}"\nexit 0\n`, { mode: 0o755 });
  await git.commit(root, { message: 'không hook', paths: ['src/a.ts'] });
  assert.ok(!fs.existsSync(hookMarker), 'pre-commit did not run (hooks default OFF)');
  put(root, 'src/a.ts', 'export const a = 3;\n');
  await git.commit(root, { message: 'có hook', paths: ['src/a.ts'], hooks: true });
  const hookRan = fs.existsSync(hookMarker);
  assert.ok(hookRan || process.platform === 'win32', 'with hooks=true the repo hook runs (skipped assertion only where sh hooks are unavailable)');
  assert.equal(count(top), 3);
  assert.equal(typeof plainGitRuns, 'boolean');
});

gitTest('project in a SUBFOLDER of the repo: only its files are listed (paths relative to the project) and commits work', async () => {
  const { top, root } = repo({ sub: 'packages/app' });
  put(top, 'outside.txt', 'x');
  put(root, 'src/a.ts', 'export const a = 2;\n');
  const st = await git.status(root);
  assert.deepEqual(st.files.map(f => f.path), ['src/a.ts']);
  assert.equal(st.outside, 1);
  assert.equal(st.prefix, 'packages/app/');
  await assert.rejects(() => git.planCommit(root, { message: 'm', paths: ['outside.txt'] }), /không có thay đổi nào/);
  await git.commit(root, { message: 'sub', paths: ['src/a.ts'] });
  assert.deepEqual(headFiles(top), ['packages/app/src/a.ts']);
  assert.equal(G(top, 'status', '--porcelain'), '?? outside.txt');
});

/* ---------- Agent ---------- */
function makeEnv(root, script) {
  const bridge = new Bridge();
  const runner = new AgentRunner({ bridge, workspace, tools, checkpoints: new CheckpointStore(path.join(path.dirname(root), 'cp-' + Math.random().toString(36).slice(2))), getRoot: () => root, detectChecks: () => [] });
  const turns = [];
  bridge.on('job', pub => {
    if (pub.status !== 'queued' || pub.kind !== 'agent') return;
    const job = bridge.getJob(pub.id);
    const info = { prompt: job.prompt };
    const idx = turns.push(info) - 1;
    setImmediate(async () => {
      if (job.status === 'cancelled') return;
      const answer = await script(info, idx);
      if (answer == null || job.status === 'cancelled') return;
      bridge.setJob(job, { status: 'final', answer, conversationUrl: 'https://gemini.google.com/app/convX' });
    });
  });
  return { runner, turns };
}
function until(runner, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const check = () => { const s = runner.snapshot(); if (pred(s)) { runner.removeListener('state', check); clearTimeout(t); resolve(s); } };
    const t = setTimeout(() => { runner.removeListener('state', check); reject(new Error('timeout; status=' + runner.snapshot().status)); }, ms);
    runner.on('state', check); check();
  });
}

gitTest('agent: git_status/git_diff run on their own; git_commit ALWAYS needs approval (even with auto-approve edits) and a rejection commits nothing', async () => {
  const { top, root } = repo();
  put(root, 'src/a.ts', 'export const a = 2;\n');
  const env = makeEnv(root, async (t, i) => {
    if (i === 0) return [call('tool: git_status'), call('tool: git_diff\npath: src/a.ts')].join('\n');
    if (i === 1) return call('tool: git_commit\nmessage: Đổi a thành 2\n---\nsrc/a.ts');
    return call('tool: finish\n---\nxong');
  });
  env.runner.setPolicy({ autoEdits: true });
  env.runner.start('commit giúp');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(w.pending.length, 1);
  assert.equal(w.pending[0].kind, 'exec');
  assert.equal(w.pending[0].tool, 'git_commit');
  assert.match(w.pending[0].label, /^git commit: Đổi a thành 2/);
  assert.match(w.pending[0].summary, /1 file[\s\S]*src\/a\.ts \(sửa\)[\s\S]*hook[\s\S]*không push/);
  assert.match(env.turns[1].prompt, /tool=git_status status=ok[\s\S]*\[sửa, chưa staged\] src\/a\.ts/);
  assert.match(env.turns[1].prompt, /tool=git_diff status=ok[\s\S]*\+export const a = 2;/);
  await assert.rejects(() => env.runner.approve(w.pending[0].id, 'approve_all_edits'), /chỉ.*sửa file/i);
  await env.runner.approve(w.pending[0].id, 'reject', 'chưa muốn');
  await until(env.runner, s => s.status === 'done');
  assert.equal(count(top), 1, 'rejected → no commit');
  assert.match(env.turns[2].prompt, /status=rejected/);
  env.runner.dispose();
});

gitTest('agent: approved git_commit creates the commit and the ledger records it; a bad plan is an error, not a commit', async () => {
  const { top, root } = repo();
  put(root, 'src/a.ts', 'export const a = 2;\n');
  put(root, '.env', 'S=1\n');
  const env = makeEnv(root, async (t, i) => {
    if (i === 0) return call('tool: git_commit\nmessage: leak\n---\n.env');
    if (i === 1) return call('tool: git_commit\nmessage: Đổi a\n---\nsrc/a.ts');
    return call('tool: finish\n---\nxong');
  });
  env.runner.start('x');
  const w = await until(env.runner, s => s.status === 'waiting_approval');
  assert.equal(count(top), 1);
  assert.match(env.turns[1].prompt, /tool=git_commit status=error[\s\S]*bị chặn/);
  await env.runner.approve(w.pending[0].id, 'approve');
  await until(env.runner, s => s.status === 'done');
  assert.equal(count(top), 2);
  assert.deepEqual(headFiles(top), ['src/a.ts']);
  assert.match(env.turns[2].prompt, /OK: đã commit [0-9a-f]+ — Đổi a/);
  assert.match(env.runner.ledger.render(), /git commit: Đổi a/);
  assert.equal(G(top, 'status', '--porcelain').includes('.env'), true, '.env is still untracked');
  env.runner.dispose();
});
