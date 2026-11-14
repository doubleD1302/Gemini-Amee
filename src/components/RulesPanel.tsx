import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import type { ProjectRules } from '../types';
import './AgentPanel.css';

const RULES_STATUS: Record<ProjectRules['status'], string> = {
  none: 'Chưa có thư mục .gps trong project.',
  trusted: 'Đã duyệt · đang được nạp cho agent ở mỗi phiên mới.',
  review: 'CHƯA duyệt hoặc đã đổi bên ngoài Studio → KHÔNG được nạp cho agent cho tới khi bạn xem và duyệt.'
};

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

const NEW_SKILL_TEMPLATE = '---\ndescription: \n---\n';

/**
 * Quy tắc & kỹ năng theo project (.gps/rules.md, .gps/skills/*.md). Nội dung có thể đến từ repo lạ nên chỉ được nạp
 * sau khi người dùng duyệt đúng nội dung đó; mọi văn bản hiển thị/sửa dưới dạng text thuần (textarea/React text).
 */
export function RulesPanel({ onToast }: { onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectRules | null>(null);
  const [rules, setRules] = useState('');
  const [skill, setSkill] = useState<{ name: string; text: string; isNew: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    window.studio.rules.get().then(d => { setData(d); setRules(d.rules); setErr(''); }).catch(e => setErr(errText(e)));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setErr('');
    try { await fn(); if (done) onToast(done); load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const lim = data?.limits;

  return (
    <div className="agent-checkpoints agent-rules">
      <button className="agent-cp-toggle" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ScrollText size={13} /> Quy tắc & kỹ năng của project
        {data && <span className={`agent-rules-badge ${data.status}`}>{data.status === 'trusted' ? 'đã duyệt' : data.status === 'review' ? 'chờ duyệt' : 'chưa có'}</span>}
      </button>
      {open && data && (
        <div className="agent-rules-body">
          <div className={`agent-rules-status ${data.status}`}>{RULES_STATUS[data.status]}</div>
          <p className="agent-rules-note">
            Viết quy ước riêng cho project (phong cách code, quy trình…) trong <code>.gps/rules.md</code>; kỹ năng là các tệp <code>.gps/skills/ten.md</code> (agent chỉ thấy tên + mô tả, tự đọc thân khi cần).
            Quy tắc KHÔNG nới được các quy tắc an toàn: mọi lệnh vẫn cần bạn duyệt.
          </p>
          {data.warnings.map((w, i) => <div key={i} className="agent-warn">{w}</div>)}
          {data.status === 'review' && (
            <div className="agent-warn">
              Nội dung bên dưới là những gì SẼ được đưa cho agent nếu bạn duyệt. Chỉ duyệt khi bạn tin tưởng nguồn của project này.
              <div className="agent-row">
                <button className="agent-btn primary" disabled={busy} onClick={() => act(() => window.studio.rules.trust(data.hash), 'Đã duyệt quy tắc & kỹ năng hiện tại.')}>
                  <Check size={14} /> Duyệt nội dung hiện tại
                </button>
              </div>
            </div>
          )}
          <label className="agent-rules-label">Quy tắc (.gps/rules.md) <span>{rules.length}/{lim?.rulesChars}</span></label>
          <textarea value={rules} onChange={e => setRules(e.target.value)} rows={6} maxLength={lim?.rulesChars} placeholder="Ví dụ: Dùng TypeScript strict. Viết test cho mỗi tính năng mới. Giao tiếp bằng tiếng Việt." />
          <div className="agent-row">
            <button className="agent-btn primary" disabled={busy || rules === data.rules} onClick={() => act(() => window.studio.rules.save(rules), 'Đã lưu quy tắc.')}>Lưu quy tắc</button>
            {data.status === 'trusted' && (
              <button className="agent-btn ghost" disabled={busy} onClick={() => act(() => window.studio.rules.revoke(), 'Đã thu hồi duyệt: agent sẽ không nạp quy tắc cho tới khi duyệt lại.')}>Thu hồi duyệt</button>
            )}
          </div>
          <label className="agent-rules-label">Kỹ năng <span>{data.skills.length}/{lim?.skills}</span></label>
          {data.skills.length === 0 && <div className="agent-cp-empty">Chưa có kỹ năng nào.</div>}
          {data.skills.map(s => (
            <div key={s.name} className="agent-rules-skill">
              <div><code>{s.name}</code><span>{s.description || '(không có mô tả)'}</span></div>
              <button className="agent-btn small" disabled={busy} onClick={() => setSkill({ name: s.name, text: s.text, isNew: false })}>Sửa</button>
              <button className="agent-btn small" disabled={busy} onClick={() => { if (window.confirm(`Xoá kỹ năng "${s.name}"?`)) void act(() => window.studio.rules.deleteSkill(s.name), 'Đã xoá kỹ năng.'); }}>Xoá</button>
            </div>
          ))}
          {!skill && <button className="agent-btn small" disabled={busy} onClick={() => setSkill({ name: '', text: NEW_SKILL_TEMPLATE, isNew: true })}>+ Thêm kỹ năng</button>}
          {skill && (
            <div className="agent-rules-edit">
              {skill.isNew
                ? <input value={skill.name} onChange={e => setSkill({ ...skill, name: e.target.value })} placeholder="ten-ky-nang (chữ, số, . - _)" maxLength={56} />
                : <code>{skill.name}.md</code>}
              <textarea value={skill.text} onChange={e => setSkill({ ...skill, text: e.target.value })} rows={8} maxLength={lim?.skillChars} />
              <div className="agent-row">
                <button className="agent-btn primary" disabled={busy || !skill.name.trim()} onClick={() => act(async () => { await window.studio.rules.saveSkill(skill.name.trim(), skill.text); setSkill(null); }, 'Đã lưu kỹ năng.')}>Lưu kỹ năng</button>
                <button className="agent-btn" disabled={busy} onClick={() => setSkill(null)}>Huỷ</button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <div className="agent-step error">{err}</div>}
    </div>
  );
}
