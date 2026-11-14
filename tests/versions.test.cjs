'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Bridge, VERSION, PROTOCOL } = require('../desktop/bridge.cjs');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('app version in the bridge equals package.json; extension manifest is a valid semver and the protocol numbers agree', () => {
  assert.equal(VERSION, JSON.parse(read('package.json')).version);
  assert.match(JSON.parse(read('extension/manifest.json')).version, /^\d+\.\d+\.\d+$/);
  const bg = read('extension/background.js');
  assert.equal(Number(/const GPS_PROTOCOL = (\d+);/.exec(bg)[1]), PROTOCOL, 'extension/background.js GPS_PROTOCOL must match bridge PROTOCOL');
  assert.match(bg, /'X-GPS-Extension-Version'/);
  assert.match(bg, /'X-GPS-Protocol'/);
});

test('update scripts no longer hard-code a machine path or an old installer version', () => {
  const ps = read('scripts/update-installed.ps1');
  assert.ok(!/Users\chann|0\.1\.1/.test(ps), 'no per-machine path / stale installer name');
  assert.match(ps, /package\.json/);
  assert.match(ps, /Setup \$version\.exe/);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/update-installed.ps1')).slice(0, 3).toString('hex'), 'efbbbf', 'keeps the UTF-8 BOM so Windows PowerShell reads Vietnamese correctly');
});

async function harness() {
  const bridge = new Bridge();
  await bridge.start();
  const { url, token } = bridge.info();
  const call = async (route, headers = {}) => (await fetch(url + route, { headers: { Authorization: 'Bearer ' + token, ...headers } })).json();
  return { bridge, call };
}

test('bridge reports unknown → ok / outdated / newer for the extension and never trusts odd header values', async () => {
  const { bridge, call } = await harness();
  try {
    assert.deepEqual(bridge.info().extension, { status: 'unknown', version: '', protocol: 0 });
    assert.equal(bridge.info().appVersion, VERSION);
    assert.equal(bridge.info().protocol, PROTOCOL);
    const health = await call('/v1/health', { 'X-GPS-Extension-Version': '0.4.0', 'X-GPS-Protocol': String(PROTOCOL) });
    assert.equal(health.protocol, PROTOCOL);
    assert.deepEqual(bridge.info().extension, { status: 'ok', version: '0.4.0', protocol: PROTOCOL });
    await call('/v1/next', { 'X-GPS-Extension-Version': '0.3.0', 'X-GPS-Protocol': '1' });
    assert.deepEqual(bridge.info().extension, { status: 'outdated', version: '0.3.0', protocol: 1 });
    await call('/v1/health');   // extension cũ không gửi header
    assert.deepEqual(bridge.info().extension, { status: 'outdated', version: '', protocol: 0 });
    await call('/v1/health', { 'X-GPS-Extension-Version': '9.9.9', 'X-GPS-Protocol': String(PROTOCOL + 1) });
    assert.equal(bridge.info().extension.status, 'newer');
    await call('/v1/health', { 'X-GPS-Extension-Version': '<script>alert(1)</script>', 'X-GPS-Protocol': '99999999' });
    assert.deepEqual(bridge.info().extension, { status: 'outdated', version: '', protocol: 0 }, 'invalid values are dropped, not echoed to the UI');
  } finally { await bridge.stop(); }
});

test('main.cjs exposes appVersion/protocol/extension to the UI but not the token', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /return \{ url, connected, appVersion, protocol, extension \}/);
  const start = main.indexOf('function publicBridgeInfo()');
  const body = main.slice(start, main.indexOf('\n}', start));
  assert.ok(start > 0 && !/token/i.test(body), 'publicBridgeInfo never includes the token');
});
