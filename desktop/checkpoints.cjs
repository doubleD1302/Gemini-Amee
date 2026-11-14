'use strict';
/**
 * Checkpoint lưu NGOÀI project (thư mục userData của app) để có thể hoàn tác mọi
 * thay đổi do agent/nút Vibe tạo ra, không làm bẩn thư mục dự án.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PER_WORKSPACE = 300;
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

class CheckpointStore {
  constructor(dir) {
    this.dir = dir;
  }
  wsDir(root) {
    const key = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 16);
    const d = path.join(this.dir, key);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  readIndex(root) {
    try { return JSON.parse(fs.readFileSync(path.join(this.wsDir(root), 'index.json'), 'utf8')); } catch { return []; }
  }
  writeIndex(root, items) {
    fs.writeFileSync(path.join(this.wsDir(root), 'index.json'), JSON.stringify(items), 'utf8');
  }
  /**
   * @param previous nội dung trước khi ghi (null nếu file mới)
   * @param next     nội dung sau khi ghi
   */
  record(root, relPath, previous, next, meta = {}) {
    const d = this.wsDir(root);
    const id = `cp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    if (previous !== null) fs.writeFileSync(path.join(d, `${id}.prev`), previous, 'utf8');
    const entry = {
      id, path: relPath, created: previous === null, at: Date.now(),
      nextHash: sha(next), source: meta.source || 'agent', note: meta.note || '', undone: false
    };
    const items = this.readIndex(root);
    items.push(entry);
    while (items.length > MAX_PER_WORKSPACE) {
      const old = items.shift();
      try { fs.rmSync(path.join(d, `${old.id}.prev`), { force: true }); } catch { /* ignore */ }
    }
    this.writeIndex(root, items);
    return entry;
  }
  list(root) {
    return this.readIndex(root).slice().reverse();
  }
  /**
   * Hoàn tác một checkpoint. `io` cung cấp đọc/ghi/xoá an toàn trong project:
   *   io.read(rel) -> string|null, io.write(rel, text), io.remove(rel)
   * Từ chối nếu file đã bị sửa tiếp sau checkpoint (trừ khi force).
   */
  undo(root, id, io, { force = false } = {}) {
    const items = this.readIndex(root);
    const entry = items.find(e => e.id === id);
    if (!entry) throw new Error('Checkpoint not found');
    if (entry.undone) throw new Error('Checkpoint already undone');
    const current = io.read(entry.path);
    if (!force && current !== null && sha(current) !== entry.nextHash) {
      const err = new Error('File đã thay đổi sau checkpoint này; hoàn tác sẽ ghi đè thay đổi mới hơn.');
      err.code = 'CONFLICT';
      throw err;
    }
    if (entry.created) {
      if (current !== null) io.remove(entry.path);
    } else {
      const prev = fs.readFileSync(path.join(this.wsDir(root), `${entry.id}.prev`), 'utf8');
      io.write(entry.path, prev);
    }
    entry.undone = true;
    this.writeIndex(root, items);
    return entry;
  }
}

module.exports = { CheckpointStore, sha };
