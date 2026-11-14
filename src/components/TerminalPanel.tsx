import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Send, Square, TerminalSquare } from 'lucide-react';
import type { TermProc } from '../types';
import './AgentPanel.css';

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}
const STATUS: Record<TermProc['status'], string> = { running: 'đang chạy', exited: 'đã thoát', stopped: 'đã dừng' };

/**
 * Terminal tiến trình nền (Giai đoạn 3, mục 6). Bạn tự bấm "Chạy" = bạn chính là bên duyệt; tiến trình do agent đề xuất
 * chỉ chạy sau khi bạn duyệt thẻ "Chạy lệnh" ở timeline. Log và tên lệnh hiển thị dạng text thuần.
 */
export function TerminalPanel() {
  const [open, setOpen] = useState(false);
  const [procs, setProcs] = useState<TermProc[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [cmd, setCmd] = useState('');
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  const refreshLog = useCallback((id: string | null) => {
    if (!id) { setLog(''); return; }
    window.studio.terminal.read(id, undefined, 12000).then(r => {
      if (selRef.current === id) setLog((r.from > 0 ? '… (phần đầu log đã được lược bớt)\n' : '') + r.text);
    }).catch(e => setErr(errText(e)));
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    window.studio.terminal.list().then(l => { if (alive) setProcs(l); }).catch(() => undefined);
    const off = window.studio.terminal.onUpdate(l => { if (alive) { setProcs(l); refreshLog(selRef.current); } });
    return () => { alive = false; off(); };
  }, [open, refreshLog]);
  useEffect(() => { refreshLog(sel); }, [sel, refreshLog]);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);

  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); } catch (e) { setErr(errText(e)); } };
  const start = () => act(async () => {
    const p = await window.studio.terminal.start(cmd);
    setCmd('');
    setSel(p.id);
  });
  const send = () => act(async () => { if (sel) { await window.studio.terminal.send(sel, input); setInput(''); } });
  const current = procs.find(p => p.id === sel) || null;
  const running = procs.filter(p => p.status === 'running').length;

  return (
    <div className="agent-checkpoints agent-term">
      <button className="agent-cp-toggle" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <TerminalSquare size={13} /> Terminal (tiến trình nền)
        {running > 0 && <span className="agent-rules-badge trusted">{running} đang chạy</span>}
      </button>
      {open && (
        <div className="agent-rules-body">
          <p className="agent-rules-note">Chạy lệnh dài (dev server, watcher…) trong thư mục dự án, xem log trực tiếp và dừng được. Tiến trình do agent đề xuất chỉ chạy sau khi bạn duyệt. Tất cả bị dừng khi đổi project hoặc đóng ứng dụng.</p>
          <div className="agent-row">
            <input className="agent-term-input" value={cmd} onChange={e => setCmd(e.target.value)} maxLength={1000} placeholder="Lệnh, ví dụ: npm run dev"
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && cmd.trim()) { e.preventDefault(); void start(); } }} />
            <button className="agent-btn primary" disabled={!cmd.trim()} onClick={start}>Chạy</button>
          </div>
          {procs.length === 0 && <div className="agent-cp-empty">Chưa có tiến trình nào.</div>}
          {procs.map(p => (
            <div key={p.id} className={`agent-term-proc ${p.id === sel ? 'sel' : ''}`}>
              <button className="agent-link agent-term-name" onClick={() => setSel(p.id)} title={p.command}>
                <code>{p.id}</code> {p.name}
              </button>
              <span className="agent-git-label">{STATUS[p.status]}{p.exitCode != null ? ` (exit ${p.exitCode})` : ''}{p.source === 'agent' ? ' · agent' : ''}</span>
              {p.status === 'running' && <button className="agent-btn small" onClick={() => act(() => window.studio.terminal.stop(p.id))}><Square size={11} /> Dừng</button>}
            </div>
          ))}
          {current && (
            <div>
              <div className="agent-rules-label"><code title={current.command}>$ {current.command}</code></div>
              <pre className="agent-output agent-term-log" ref={logRef}>{log || '(chưa có output)'}</pre>
              {current.status === 'running' && (
                <div className="agent-row">
                  <input className="agent-term-input" value={input} onChange={e => setInput(e.target.value)} maxLength={4000} placeholder="Gõ input gửi vào tiến trình rồi Enter"
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && input) { e.preventDefault(); void send(); } }} />
                  <button className="agent-btn small" disabled={!input} onClick={send}><Send size={11} /> Gửi</button>
                </div>
              )}
            </div>
          )}
          {running > 1 && <button className="agent-btn small" onClick={() => act(() => window.studio.terminal.stopAll())}>Dừng tất cả</button>}
        </div>
      )}
      {err && <div className="agent-step error">{err}</div>}
    </div>
  );
}
