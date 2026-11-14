import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, RotateCcw } from 'lucide-react';
import type { AppSettings, SettingsPayload, UpdateResult } from '../types';
import './AgentPanel.css';

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

type NumKey = 'maxTurns' | 'contextBudgetChars' | 'contextFiles' | 'contextChars' | 'bridgePort';
const NUM_KEYS: { key: NumKey; hint: string; restart?: boolean }[] = [
  { key: 'maxTurns', hint: 'Agent dừng và hỏi lại sau số lượt này.' },
  { key: 'contextBudgetChars', hint: 'Khi cuộc trò chuyện Gemini gần ngân sách này, agent tự mở chat mới kèm bản tóm tắt. Ước lượng, chưa kiểm chứng với giới hạn thật của Gemini.' },
  { key: 'contextFiles', hint: 'Số file tối đa gửi kèm ở chế độ Chat.' },
  { key: 'contextChars', hint: 'Số ký tự tối đa gửi kèm ở chế độ Chat.' },
  { key: 'bridgePort', hint: 'Cổng cầu nối 127.0.0.1. Đổi cổng cần mở lại ứng dụng và ghép nối lại extension.', restart: true }
];

/**
 * Cài đặt ứng dụng + kiểm tra cập nhật. Không có tuỳ chọn nào làm yếu cơ chế duyệt (lệnh luôn cần duyệt).
 * Kiểm tra cập nhật chỉ chạy khi bạn bấm; ứng dụng không tự tải hay cài bản mới, chỉ mở trang phát hành trên GitHub.
 */
export function SettingsPanel() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cpDir, setCpDir] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [update, setUpdate] = useState<UpdateResult | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((p: SettingsPayload, note = '') => {
    setData(p);
    setDraft(Object.fromEntries(NUM_KEYS.map(k => [k.key, String(p.settings[k.key])])));
    setCpDir(p.settings.checkpointDir);
    setMsg(note);
  }, []);
  useEffect(() => { window.studio.settings.get().then(p => apply(p)).catch(e => setErr(errText(e))); }, [apply]);

  const act = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  const save = () => act(async () => {
    if (!data) return;
    const patch: Partial<AppSettings> = {};
    for (const { key } of NUM_KEYS) {
      const n = Number(draft[key]);
      if (draft[key] !== String(data.settings[key])) patch[key] = n;
    }
    if (cpDir.trim() !== data.settings.checkpointDir) patch.checkpointDir = cpDir.trim();
    if (!Object.keys(patch).length) { setMsg('Không có thay đổi.'); return; }
    const p = await window.studio.settings.set(patch);
    apply(p, p.restartRequired && p.restartRequired.length ? `Đã lưu. Cần mở lại ứng dụng để áp dụng: ${p.restartRequired.map(k => p.labels[k] || k).join(', ')}.` : 'Đã lưu và áp dụng ngay.');
  });
  const reset = () => act(async () => { apply(await window.studio.settings.reset(), 'Đã khôi phục mặc định. Cổng/thư mục checkpoint áp dụng khi mở lại ứng dụng.'); });
  const pick = () => act(async () => { const d = await window.studio.settings.pickDir(); if (d) setCpDir(d); });
  const check = () => act(async () => { setUpdate(await window.studio.settings.checkUpdate()); });

  if (!data) return err ? <div className="agent-step error">{err}</div> : null;
  return (
    <div className="settings-panel">
      <h4>Cài đặt</h4>
      <p className="agent-rules-note">Phiên bản Studio {data.version}. Cài đặt lưu ngoài dự án; không có tuỳ chọn nào tắt việc duyệt lệnh.</p>
      {NUM_KEYS.map(({ key, hint, restart }) => (
        <label key={key} className="settings-row" title={hint}>
          <span>{data.labels[key]}{restart ? ' *' : ''}</span>
          <input type="number" inputMode="numeric" min={data.ranges[key][0]} max={data.ranges[key][1]} value={draft[key] ?? ''} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
          <small>{data.ranges[key][0].toLocaleString('vi-VN')}–{data.ranges[key][1].toLocaleString('vi-VN')} · mặc định {data.defaults[key].toLocaleString('vi-VN')}</small>
        </label>
      ))}
      <label className="settings-row" title="Checkpoint (hoàn tác) luôn nằm NGOÀI dự án. Để trống = thư mục mặc định của ứng dụng.">
        <span>Thư mục checkpoint *</span>
        <div className="agent-row">
          <input className="agent-term-input" value={cpDir} onChange={e => setCpDir(e.target.value)} placeholder="(mặc định)" maxLength={500} />
          <button type="button" className="agent-btn small" onClick={pick} disabled={busy}><FolderOpen size={12} /> Chọn…</button>
        </div>
        <small>Đang dùng: <code>{data.checkpointDirInUse}</code></small>
      </label>
      <small className="agent-rules-note">* áp dụng khi mở lại ứng dụng.</small>
      <div className="agent-row">
        <button className="agent-btn primary" disabled={busy} onClick={save}>Lưu cài đặt</button>
        <button className="agent-btn ghost" disabled={busy} onClick={reset}><RotateCcw size={12} /> Mặc định</button>
      </div>
      {msg && <div className="agent-rules-status trusted">{msg}</div>}
      {err && <div className="agent-step error">{err}</div>}
      <div className="settings-update">
        <button className="agent-btn" disabled={busy} onClick={check}><RefreshCw size={13} /> Kiểm tra bản cập nhật</button>
        {update && (
          <div className={`agent-rules-status ${update.status === 'update' ? 'review' : 'trusted'}`}>
            {update.message}
            {update.status === 'update' && <> <button className="agent-link" onClick={() => void window.studio.settings.openRelease(update.url)}>Mở trang tải về</button></>}
          </div>
        )}
        <small className="agent-rules-note">Chỉ chạy khi bạn bấm; hỏi GitHub Releases, không gửi dữ liệu của bạn, không tự tải hay cài.</small>
      </div>
    </div>
  );
}
