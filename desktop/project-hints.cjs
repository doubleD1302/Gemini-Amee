'use strict';
/**
 * Suy ra lệnh kiểm tra (test/lint/typecheck/build) của dự án để gợi ý cho agent.
 * - Chỉ ĐỌC: package.json qua workspace.readProjectFile (realpath an toàn) + kiểm tra sự tồn tại của vài file.
 * - Chỉ trả về lệnh gọi script (ví dụ `npm run lint`), KHÔNG chép nội dung script vào prompt:
 *   package.json là dữ liệu không tin cậy.
 * - Đây chỉ là GỢI Ý; run_command vẫn luôn cần người dùng duyệt.
 */
const fs = require('node:fs');
const path = require('node:path');
const workspace = require('./workspace.cjs');

const SCRIPT_NAME_RE = /^[A-Za-z0-9][\w:.-]{0,40}$/;
// Thứ tự ưu tiên; mỗi nhóm lấy tên script đầu tiên có trong package.json.
const GROUPS = [
  { kind: 'test', names: ['test', 'tests', 'test:unit'] },
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'tsc', 'check-types'] },
  { kind: 'lint', names: ['lint', 'eslint'] },
  { kind: 'check', names: ['check', 'verify'] },
  { kind: 'build', names: ['build'] }
];
const MAX_HINTS = 5;
const PLACEHOLDER_TEST = /no test specified/i;

function packageManager(root) {
  const has = f => fs.existsSync(path.join(root, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

function scriptCommand(pm, name) {
  if (pm === 'yarn') return `yarn ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  if (name === 'test') return `${pm} test`;
  return `${pm} run ${name}`;
}

function readScripts(root) {
  try {
    const { content } = workspace.readProjectFile(root, 'package.json');
    const pkg = JSON.parse(content);
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return scripts;
  } catch {
    return null;
  }
}

/** @returns {{command:string, kind:string, source:string}[]} */
function detectCheckCommands(root) {
  const out = [];
  if (!root) return out;
  const scripts = readScripts(root);
  if (scripts) {
    const pm = packageManager(root);
    for (const g of GROUPS) {
      const name = g.names.find(n => typeof scripts[n] === 'string' && SCRIPT_NAME_RE.test(n)
        && !(g.kind === 'test' && PLACEHOLDER_TEST.test(scripts[n])));
      if (name) out.push({ command: scriptCommand(pm, name), kind: g.kind, source: 'package.json' });
    }
  }
  const has = f => fs.existsSync(path.join(root, f));
  if (has('Cargo.toml')) out.push({ command: 'cargo test', kind: 'test', source: 'Cargo.toml' });
  if (has('go.mod')) out.push({ command: 'go test ./...', kind: 'test', source: 'go.mod' });
  if (has('pytest.ini') || has('conftest.py')) out.push({ command: 'pytest', kind: 'test', source: has('pytest.ini') ? 'pytest.ini' : 'conftest.py' });
  return out.slice(0, MAX_HINTS);
}

module.exports = { detectCheckCommands, packageManager, scriptCommand };
