import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import type { GitFile, GitStatus } from '../types';
import './AgentPanel.css';

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * Git (Giai đoạn 3, mục 4): xem trạng thái + diff, tạo commit CÓ CHỦ ĐÍCH.
 * Không có push/pull/reset. Mỗi commit chỉ gồm các file bạn tick, và còn một hộp thoại xác nhận của hệ thống trước khi chạy.
 * Mọi văn bản (tên file, diff, thông điệp) hiển thị dạng text thuần.
 */
export function GitPanel({ onToast }: { onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<GitStatus | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [hooks, setHooks] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    window.studio.git.status()
      .then(s => { setSt(s); setErr(''); setPicked(prev => new Set([...prev].filter(p => s.files.some(f => f.path === p && !f.blocked && !f.conflict)))); })
      .catch(e => setErr(errText(e)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const selectable = useMemo(() => (st ? st.files.filter(f => !f.blocked && !f.conflict) : []), [st]);
  const toggle = (f: GitFile) => setPicked(prev => { const n = new Set(prev); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; });
  const showDiff = (f: GitFile) => {
    window.studio.git.diff(f.path, f.staged && !f.unstaged)
      .then(d => setDiff({ path: f.path, text: d.diff || '(không có nội dung diff)' }))
      .catch(e => setErr(errText(e)));
  };
  const commit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await window.studio.git.commit({ message, paths: [...picked], hooks });
      onToast(`Đã commit ${r.hash}: ${r.summary}`);
      setMessage('');
      setPicked(new Set());
      setDiff(null);
      load();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="agent-checkpoints agent-git">
      <button className="agent-cp-toggle" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <GitBranch size={13} /> Git
        {st && st.repo && <span className="agent-rules-badge">{st.branch}{st.files.length ? ` · ${st.files.length} thay đổi` : ' · sạch'}</span>}
      </button>
      {open && (
        <div className="agent-rules-body">
          <div className="agent-row">
            <button className="agent-btn small" disabled={busy} onClick={load}><RefreshCw size={12} /> Làm mới</button>
          </div>
          {st && !st.repo && <div className="agent-cp-empty">{st.reason || 'Không phải kho git.'}</div>}
          {st && st.repo && (
            <>
              <div className="agent-rules-note">
                Nhánh <code>{st.branch}</code>{st.ahead ? ` · trước ${st.ahead}` : ''}{st.behind ? ` · sau ${st.behind}` : ''}{st.noCommits ? ' · chưa có commit nào' : ''}. Studio không bao giờ push/pull/reset.
              </div>
              {st.files.length === 0 && <div className="agent-cp-empty">Không có thay đổi.</div>}
              {st.files.map(f => (
                <div key={f.path} className="agent-git-file">
                  <input type="checkbox" checked={picked.has(f.path)} disabled={f.blocked || f.conflict || busy} onChange={() => toggle(f)} aria-label={`Chọn ${f.path} để commit`} />
                  <button className="agent-link agent-git-name" onClick={() => showDiff(f)} title="Xem diff"><code>{f.path}</code></button>
                  <span className="agent-git-label">{f.label}{f.staged ? ' · staged' : ''}{f.blocked ? ' · bị chặn (nhạy cảm)' : ''}</span>
                </div>
              ))}
              {st.outside ? <div className="agent-cp-empty">{st.outside} thay đổi nằm ngoài thư mục dự án (không hiển thị).</div> : null}
              {diff && (
                <div>
                  <div className="agent-rules-label"><code>{diff.path}</code><button className="agent-link" onClick={() => setDiff(null)}>Đóng</button></div>
                  <pre className="agent-output">{diff.text}</pre>
                </div>
              )}
              {selectable.length > 0 && (
                <div className="agent-rules-edit">
                  <label className="agent-rules-label">Thông điệp commit <span>{picked.size} file được chọn</span></label>
                  <input value={message} onChange={e => setMessage(e.target.value)} maxLength={500} placeholder="Mô tả ngắn gọn thay đổi" />
                  <label className="agent-toggle" title="Hook là mã chạy tuỳ ý từ cấu hình repo; chỉ bật nếu bạn tin repo này.">
                    <input type="checkbox" checked={hooks} onChange={e => setHooks(e.target.checked)} />
                    <span>Chạy git hook của repo (pre-commit…) — mặc định tắt</span>
                  </label>
                  <div className="agent-row">
                    <button className="agent-btn primary" disabled={busy || !message.trim() || picked.size === 0} onClick={commit}>
                      <GitCommitHorizontal size={14} /> Commit {picked.size ? `${picked.size} file` : ''}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {err && <div className="agent-step error">{err}</div>}
    </div>
  );
}
