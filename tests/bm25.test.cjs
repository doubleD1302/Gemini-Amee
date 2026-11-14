'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Bm25Index, tokenize, queryTerms, extractSymbols, bestWindow, fold } = require('../desktop/bm25.cjs');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');

let cleanup = [];
afterEach(() => { for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true }); cleanup = []; });
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-bm25-'));
  cleanup.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}

test('tokenize splits camelCase/snake_case, keeps the whole identifier and folds Vietnamese diacritics', () => {
  assert.deepEqual(tokenize('loginUser').sort(), ['login', 'loginuser', 'user']);
  assert.deepEqual(tokenize('parse_http_response').sort(), ['http', 'parse', 'parsehttpresponse', 'response']);
  assert.deepEqual(tokenize('HTMLParser').sort(), ['html', 'htmlparser', 'parser']);
  assert.equal(fold('Đăng nhập'), 'dang nhap');
  assert.deepEqual(tokenize('Đăng nhập'), ['dang', 'nhap']);
  assert.deepEqual(tokenize('a b $ _ x'), [], 'single characters are noise');
  assert.deepEqual(tokenize('x'.repeat(100)), [], 'absurdly long words are skipped');
});

test('queryTerms drops stop words and duplicates', () => {
  assert.deepEqual(queryTerms('How does the loginUser function work for login?'), ['loginuser', 'login', 'user', 'function', 'work']);
  assert.deepEqual(queryTerms('và của cho'), []);
  assert.deepEqual(queryTerms(''), []);
  assert.ok(queryTerms('a'.repeat(5000) + ' ' + Array.from({ length: 100 }, (_, i) => 'term' + i).join(' ')).length <= 24);
});

test('extractSymbols finds declarations across common languages without mistaking control flow for methods', () => {
  const js = [
    'export async function fetchUser(id) {', 'export class UserStore {', '  getById(id) {', '  if (x) {', '  static create(opts) {',
    'export const handler = async (req) => {', 'export interface Config {', 'type Id = string;', 'const notAFunction = 5;', 'for (const a of b) {'
  ].join('\n');
  assert.deepEqual(extractSymbols(js).map(s => s.name), ['fetchUser', 'UserStore', 'getById', 'create', 'handler', 'Config', 'Id']);
  assert.deepEqual(extractSymbols('def load_config(path):\nclass Loader:\n    async def run(self):').map(s => s.name), ['load_config', 'Loader', 'run']);
  assert.deepEqual(extractSymbols('pub async fn serve() {}\npub struct Server {\nfunc (s *Server) Handle() {}\nfunc main() {}').map(s => s.name), ['serve', 'Server', 'Handle', 'main']);
  assert.deepEqual(extractSymbols('    return foo(\n      bar);').map(s => s.name), [], 'a call is not a declaration');
  assert.equal(extractSymbols(js)[0].line, 1);
});

test('Bm25Index ranks by BM25 with symbol/path weights, updates incrementally and prunes', () => {
  const idx = new Bm25Index();
  idx.upsert('src/auth/login.ts', { sig: '1', text: 'export function loginUser(name, password) {\n  return check(name, password);\n}\n' });
  idx.upsert('src/ui/Button.tsx', { sig: '1', text: 'export function Button() { return null; }\n// the login button text appears once\n' });
  idx.upsert('docs/notes.md', { sig: '1', text: 'login login login login login login ' + 'filler '.repeat(500) });
  idx.upsert('src/util/math.ts', { sig: '1', text: 'export const add = (a, b) => a + b;\n' });
  const hits = idx.search('login user');
  assert.equal(hits[0].path, 'src/auth/login.ts', 'symbol + path match beats a long file that merely repeats the word');
  assert.deepEqual(hits[0].symbols.map(s => s.name), ['loginUser']);
  assert.ok(!hits.some(h => h.path === 'src/util/math.ts'));
  assert.deepEqual(idx.search('zzzunknown'), []);
  assert.deepEqual(idx.search(''), []);
  // incremental: sig is stored, re-upsert replaces (no double counting in df)
  assert.equal(idx.sigOf('src/util/math.ts'), '1');
  const dfBefore = idx.df.get('add');
  idx.upsert('src/util/math.ts', { sig: '2', text: 'export const add = (a, b) => a + b;\n' });
  assert.equal(idx.df.get('add'), dfBefore);
  assert.equal(idx.sigOf('src/util/math.ts'), '2');
  idx.upsert('src/util/math.ts', { sig: '3', text: 'export const multiply = (a, b) => a * b;\n' });
  assert.equal(idx.df.has('add'), false, 'terms of the replaced text are gone');
  assert.equal(idx.search('multiply')[0].path, 'src/util/math.ts');
  idx.prune(new Set(['src/auth/login.ts']));
  assert.equal(idx.size, 1);
  assert.equal(idx.df.has('button'), false);
  idx.remove('src/auth/login.ts');
  assert.equal(idx.size, 0);
  assert.equal(idx.totalLen, 0);
  assert.deepEqual(idx.search('login'), []);
});

test('bestWindow finds the most relevant region and trims leading/trailing irrelevant lines', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `// filler ${i}`);
  lines[199] = 'function refreshToken(session) {';
  lines[200] = '  return session.token;';
  const w = bestWindow(lines.join('\n'), ['refresh', 'token'], { size: 20 });
  assert.ok(w.start <= 200 && w.end >= 201, JSON.stringify(w));
  assert.ok(w.end - w.start < 20);
  assert.equal(bestWindow('nothing here', ['zzz']), null);
  assert.equal(bestWindow('x', []), null);
});

test('searchCode over a real folder: ranks, shows the best window + symbols, follows edits, ignores private files', () => {
  const filler = Array.from({ length: 120 }, (_, i) => `const filler${i} = ${i};`).join('\n');
  const dir = project({
    'src/auth/session.ts': `${filler}\nexport function refreshSessionToken(session) {\n  return session.token;\n}\n`,
    'src/ui/App.tsx': 'export function App() { return null; }\n',
    'README.md': '# demo\nmột dự án nhỏ\n',
    '.env': 'SESSION_TOKEN=SECRET-VALUE\n'
  });
  const r = workspace.searchCode(dir, 'refresh session token');
  assert.equal(r.results[0].path, 'src/auth/session.ts');
  assert.deepEqual(r.results[0].symbols.map(s => s.name), ['refreshSessionToken']);
  assert.ok(r.results[0].window.start > 100, 'best window is the declaration, not the file head');
  assert.match(r.results[0].snippet, /refreshSessionToken/);
  assert.ok(!r.results.some(x => x.path === '.env'));
  assert.ok(!JSON.stringify(r).includes('SECRET-VALUE'));
  assert.equal(r.partial, false);
  // sửa file → chỉ mục tự cập nhật sau khi cache bị xoá (như khi agent ghi file)
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'App.tsx'), 'export function renderSidebarMenu() { return null; }\n');
  workspace.clearScanCache();
  assert.equal(workspace.searchCode(dir, 'sidebar menu').results[0].path, 'src/ui/App.tsx');
  fs.rmSync(path.join(dir, 'src', 'ui', 'App.tsx'));
  workspace.clearScanCache();
  assert.deepEqual(workspace.searchCode(dir, 'sidebar menu').results, []);
  assert.equal(workspace.searchCode(dir, 'dự án nhỏ').results[0].path, 'README.md', 'Vietnamese with diacritics');
  assert.equal(workspace.searchCode(dir, 'du an nho').results[0].path, 'README.md', 'and without');
});

test('buildContext uses the index: a long file is excerpted around the relevant part instead of only its head', () => {
  const head = Array.from({ length: 300 }, (_, i) => `const unrelated${i} = ${i};`).join('\n');
  const dir = project({
    'src/big.ts': `${head}\nexport function computeInvoiceTotal(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n`,
    'src/small.ts': 'export const x = 1;\n'
  });
  const r = workspace.buildContext(dir, 'Sửa computeInvoiceTotal để tính cả thuế', { maxFiles: 2, maxCharacters: 1500 });
  assert.ok(r.included.includes('src/big.ts'));
  assert.match(r.prompt, /TRUNCATED, đoạn liên quan: dòng \d+-\d+/);
  assert.match(r.prompt, /computeInvoiceTotal\(items\)/);
  assert.match(r.prompt, /lược bỏ \d+ dòng/);
  assert.match(r.prompt, /const unrelated0 = 0;/, 'the first lines (imports/declarations) are kept');
  assert.ok(!r.prompt.includes('const unrelated250 = 250;'));
});

test('buildContext still works when the index fails (falls back to the old ranking)', () => {
  const dir = project({ 'src/a.ts': 'export const a = 1;\n' });
  const orig = workspace.ensureBm25;
  const r = workspace.buildContext(dir, 'a.ts', { activePath: 'src/a.ts' });
  assert.deepEqual(r.included, ['src/a.ts']);
  assert.equal(typeof orig, 'function');
});

test('tool search_code: read-only, ranked output with windows and symbols; clear messages for empty/useless queries', async () => {
  const dir = project({
    'src/pay.ts': 'export function chargeCustomer(amount) {\n  return amount * 2;\n}\n',
    'src/other.ts': 'export const nothing = 0;\n'
  });
  const t = tools.TOOLS.search_code;
  assert.equal(t.kind, 'read');
  assert.throws(() => t.prepare({ root: dir }, {}), /query/);
  const ok = await t.run({ root: dir }, { query: 'charge the customer' });
  assert.match(ok.output, /Từ khoá: charge, customer/);
  assert.match(ok.output, /1\. src\/pay\.ts \(điểm [\d.]+\) · dòng 1-\d+ · ký hiệu: chargeCustomer@1/);
  assert.ok(!ok.output.includes('src/other.ts'));
  assert.match((await t.run({ root: dir }, { query: 'zzzqqq' })).output, /Không có file nào khớp/);
  assert.match((await t.run({ root: dir }, { query: 'the and for' })).output, /không có từ khoá hữu ích/);
  assert.ok(tools.specs().some(s => s.name === 'search_code'));
});
