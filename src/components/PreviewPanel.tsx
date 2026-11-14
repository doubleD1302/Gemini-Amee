import { useEffect, useState } from 'react';
import { Camera, ChevronDown, ChevronRight, Globe } from 'lucide-react';
import type { PreviewStatus } from '../types';
import './AgentPanel.css';

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * Xem trước web (Giai đoạn 3, mục 2). Tuỳ chọn và luôn hỏi quyền: bạn tự mở trang (chỉ localhost) và tự bấm chụp;
 * ảnh chỉ rời máy khi bạn gửi tin nhắn kèm ảnh. Agent muốn mở/chụp phải qua thẻ duyệt ở timeline.
 */
export function PreviewPanel({ sessionId, onToast }: { sessionId: string; onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<PreviewStatus>({ open: false, url: '' });
  const [url, setUrl] = useState('http://localhost:5173');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    window.studio.preview.status().then(s => { if (alive) setSt(s); }).catch(() => undefined);
    const off = window.studio.preview.onChange(s => { if (alive) setSt(s); });
    return () => { alive = false; off(); };
  }, [open]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };

  return (
    <div className="agent-checkpoints agent-preview">
      <button className="agent-cp-toggle" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Globe size={13} /> Xem trước web
        {st.open && <span className="agent-rules-badge trusted">đang mở</span>}
      </button>
      {open && (
        <div className="agent-rules-body">
          <p className="agent-rules-note">
            Mở dev server của project (chỉ <code>localhost</code>/<code>127.0.0.1</code>) trong cửa sổ riêng, tách biệt khỏi Studio (không dùng chung cookie, mọi quyền camera/vị trí bị từ chối).
            Ảnh chụp được đính kèm vào tin nhắn kế tiếp; gửi ảnh qua extension chưa được kiểm chứng trên Gemini thật.
          </p>
          <div className="agent-row">
            <input className="agent-term-input" value={url} onChange={e => setUrl(e.target.value)} maxLength={2000} placeholder="http://localhost:5173"
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && url.trim()) { e.preventDefault(); void act(() => window.studio.preview.open(url)); } }} />
            <button className="agent-btn primary" disabled={busy || !url.trim()} onClick={() => act(() => window.studio.preview.open(url))}>Mở</button>
          </div>
          {st.open && (
            <>
              <div className="agent-rules-status trusted">Đang mở: <code>{st.url}</code></div>
              <div className="agent-row">
                <button className="agent-btn" disabled={busy} onClick={() => act(async () => { const a = await window.studio.preview.captureAttach(sessionId); onToast(`Đã chụp ${a.width}×${a.height} và đính kèm vào tin nhắn kế tiếp.`); })}>
                  <Camera size={14} /> Chụp & đính kèm
                </button>
                <button className="agent-btn ghost" disabled={busy} onClick={() => act(() => window.studio.preview.close())}>Đóng xem trước</button>
              </div>
            </>
          )}
        </div>
      )}
      {err && <div className="agent-step error">{err}</div>}
    </div>
  );
}
