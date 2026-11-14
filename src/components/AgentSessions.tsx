import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { AgentStatus, SessionInfo } from '../types';
import { AgentPanel } from './AgentPanel';
import './AgentPanel.css';

const LABEL: Record<AgentStatus, string> = {
  idle: 'sẵn sàng', running: 'đang chạy', waiting_approval: 'chờ duyệt', waiting_user: 'chờ trả lời', done: 'xong', error: 'lỗi', cancelled: 'đã dừng'
};
const title = (s: SessionInfo, n: number) => `Phiên ${n}${s.goal ? ` · ${s.goal.slice(0, 28)}${s.goal.length > 28 ? '…' : ''}` : ''}`;

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * Nhiều phiên Agent song song (Giai đoạn 3, mục 1): mỗi phiên một cuộc trò chuyện Gemini riêng, chung một cầu nối.
 * Tab hiển thị trạng thái của từng phiên (kể cả phiên nền đang chờ bạn duyệt). Extension chỉ điều khiển MỘT tab Gemini,
 * nên các lượt gửi của các phiên được xếp hàng và chạy lần lượt (chuyển qua lại giữa các cuộc trò chuyện).
 */
export function AgentSessions({ connected, workspaceOpen, onToast, onFilesChanged }: {
  connected: boolean;
  workspaceOpen: boolean;
  onToast: (message: string) => void;
  onFilesChanged?: () => void;
}) {
  const [list, setList] = useState<SessionInfo[]>([{ id: 'main', goal: '', status: 'idle', turn: 0, pending: 0 }]);
  const [active, setActive] = useState('main');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    window.studio.sessions.list().then(l => { if (alive && l.length) setList(l); }).catch(() => undefined);
    const off = window.studio.sessions.onChange(l => { if (alive && l.length) { setList(l); setActive(a => (l.some(s => s.id === a) ? a : 'main')); } });
    return () => { alive = false; off(); };
  }, [workspaceOpen]);

  const add = useCallback(() => {
    setErr('');
    window.studio.sessions.create().then(id => { setActive(id); return window.studio.sessions.list(); }).then(setList).catch(e => setErr(errText(e)));
  }, []);
  const close = useCallback((id: string) => {
    const s = list.find(x => x.id === id);
    if (s && s.status !== 'idle' && s.status !== 'done' && !window.confirm('Phiên này đang làm việc. Đóng phiên sẽ dừng agent. Tiếp tục?')) return;
    window.studio.sessions.close(id).then(l => { setList(l); setActive(a => (a === id ? 'main' : a)); }).catch(e => setErr(errText(e)));
  }, [list]);

  const multi = list.length > 1;
  return (
    <div className="agent-sessions">
      {workspaceOpen && (
        <div className="agent-session-tabs" role="tablist" aria-label="Phiên agent">
          {list.map((s, i) => (
            <div key={s.id} className={`agent-session-tab ${s.id === active ? 'on' : ''} ${s.status}`}>
              <button role="tab" aria-selected={s.id === active} onClick={() => setActive(s.id)} title={s.goal || 'Phiên chưa có mục tiêu'}>
                {title(s, i + 1)}
                {multi && <span className="agent-session-status">{LABEL[s.status]}{s.pending > 0 ? ` · ${s.pending} chờ duyệt` : ''}</span>}
              </button>
              {s.id !== 'main' && <button className="agent-session-close" aria-label={`Đóng phiên ${i + 1}`} onClick={() => close(s.id)}><X size={11} /></button>}
            </div>
          ))}
          {list.length < 3 && <button className="agent-session-add" onClick={add} title="Mở thêm một phiên agent song song (cuộc trò chuyện Gemini riêng)"><Plus size={13} /> Phiên mới</button>}
        </div>
      )}
      {err && <div className="agent-step error">{err}</div>}
      <AgentPanel key={active} sessionId={active} connected={connected} workspaceOpen={workspaceOpen} onToast={onToast} onFilesChanged={onFilesChanged} />
    </div>
  );
}
