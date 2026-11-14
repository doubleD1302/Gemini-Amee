import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, Circle, CircleCheck, ExternalLink, ChevronDown, ChevronRight, ClipboardCopy, FilePen, FileSearch, History, ListChecks, LoaderCircle, Paperclip,
  Play, RotateCcw, ShieldAlert, ShieldCheck, Square, TerminalSquare, Undo2, X
} from 'lucide-react';
import type { AgentAttachment, AgentPending, AgentPlan, AgentPlanStatus, AgentState, AgentStep, CheckpointInfo, DiffHunkView, PreviousSession } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { RulesPanel } from './RulesPanel';
import { GitPanel } from './GitPanel';
import { TerminalPanel } from './TerminalPanel';
import { PreviewPanel } from './PreviewPanel';
import './AgentPanel.css';

const EMPTY: AgentState = {
  id: null, goal: '', status: 'idle', turn: 0, maxTurns: 25, conversationUrl: null, jobId: null,
  liveText: '', error: '', question: '', plan: null, attachments: [], policy: { autoEdits: false },
  context: { chars: 0, tokens: 0, budgetChars: 240000, budgetTokens: 68572, ratio: 0, chatIndex: 0, rotations: 0, turnsInChat: 0, rotateRequested: false },
  steps: [], pending: []
};

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Ước lượng ngữ cảnh đã dùng trong cuộc trò chuyện Gemini hiện tại (không phải số token thật). */
function ContextMeterBar({ context: c, canRotate, onRotate }: { context: AgentState['context']; canRotate: boolean; onRotate: () => void }) {
  const pct = Math.round(c.ratio * 100);
  const level = c.ratio >= 0.85 ? 'high' : c.ratio >= 0.6 ? 'mid' : 'low';
  return (
    <div className="agent-context" title={`Ước lượng thô (~3,5 ký tự/token). Khi gần tới ngân sách ${fmt(c.budgetChars)} ký tự, Agent tự mở chat Gemini mới kèm bản tóm tắt tiến độ.`}>
      <div className="agent-context-line">
        <span>Ngữ cảnh chat #{c.chatIndex}: ~{fmt(c.tokens)} token ({fmt(c.chars)} ký tự) · {pct}% ngân sách ước lượng</span>
        {c.rotations > 0 && <span className="agent-context-rot">đã chuyển chat {c.rotations} lần</span>}
        <button className="agent-link" disabled={!canRotate || c.rotateRequested} onClick={onRotate} title="Lần gửi kế tiếp sẽ mở chat Gemini mới kèm bản tóm tắt">
          {c.rotateRequested ? 'Sẽ mở chat mới ở lượt sau ✓' : 'Chat mới ở lượt sau'}
        </button>
      </div>
      <div className="agent-context-bar"><div className={`agent-context-fill ${level}`} style={{ width: `${Math.max(2, pct)}%` }} /></div>
    </div>
  );
}

const PLAN_STATUS_LABEL: Record<AgentPlanStatus, string> = { pending: 'chưa làm', in_progress: 'đang làm', done: 'xong' };

/**
 * Checklist kế hoạch do model lập (tool `plan`) — chỉ để xem, không có nút nào thực thi gì.
 * Văn bản mục do model viết (không tin cậy) nên chỉ render bằng text thuần của React (không markdown/HTML).
 */
function PlanChecklist({ plan }: { plan: AgentPlan }) {
  const [open, setOpen] = useState(true);
  const total = plan.items.length;
  const done = plan.items.filter(i => i.status === 'done').length;
  return (
    <div className="agent-plan" role="region" aria-label="Kế hoạch của agent">
      <button className="agent-plan-head" onClick={() => setOpen(o => !o)} aria-expanded={open} title="Kế hoạch do Gemini lập; chỉ để hiển thị, không tự thực thi gì">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ListChecks size={14} />
        <strong>Kế hoạch</strong>
        <span className="agent-plan-count">{done}/{total} xong</span>
        <span className="agent-plan-bar" aria-hidden="true"><span className="agent-plan-fill" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
      </button>
      {open && (
        <ul className="agent-plan-list">
          {plan.items.map((item, i) => (
            <li key={i} className={`agent-plan-item ${item.status}`}>
              <span className="agent-plan-icon" role="img" aria-label={PLAN_STATUS_LABEL[item.status]} title={PLAN_STATUS_LABEL[item.status]}>
                {item.status === 'done' ? <CircleCheck size={14} /> : item.status === 'in_progress' ? <LoaderCircle size={14} className="agent-spin" /> : <Circle size={14} />}
              </span>
              <span className="agent-plan-text">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ATTACH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.txt,.md,.log,.json,.csv,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.css,.html,.yml,.yaml,.toml,.xml,.sh,.sql';
const ATTACH_MAX_BYTES = 4 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được tệp.'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Nút đính kèm + danh sách tệp chờ gửi. Ảnh đi qua extension (chưa kiểm chứng trên Gemini thật); tệp văn bản được nhúng thẳng vào prompt. */
function AttachBar({ items, disabled, onPick, onRemove }: { items: AgentAttachment[]; disabled: boolean; onPick: (files: File[]) => void; onRemove: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="agent-attach">
      <button type="button" className="agent-link agent-attach-btn" disabled={disabled} onClick={() => input.current?.click()} title="Đính kèm ảnh chụp lỗi hoặc tệp văn bản (log...). Có thể dán ảnh bằng Ctrl+V vào ô nhập.">
        <Paperclip size={12} /> Đính kèm
      </button>
      <input ref={input} type="file" hidden multiple accept={ATTACH_ACCEPT} onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) onPick(f); }} />
      {items.map(a => (
        <span key={a.id} className={`agent-chip ${a.kind}`} title={`${a.name} · ${a.kind === 'image' ? 'ảnh gửi qua extension (cơ chế tải ảnh chưa được kiểm chứng trên Gemini thật)' : 'văn bản nhúng vào prompt'}`}>
          <span className="agent-chip-name">{a.name}</span>
          <span className="agent-chip-meta">{a.kind === 'image' ? 'ảnh' : 'văn bản'} · {kb(a.size)}</span>
          <button type="button" aria-label={`Bỏ đính kèm ${a.name}`} onClick={() => onRemove(a.id)}><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<AgentState['status'], string> = {
  idle: 'Sẵn sàng',
  running: 'Đang làm việc',
  waiting_approval: 'Chờ bạn duyệt',
  waiting_user: 'Chờ bạn trả lời',
  done: 'Hoàn thành',
  error: 'Gặp lỗi',
  cancelled: 'Đã dừng'
};

function toolIcon(tool?: string) {
  if (tool === 'run_command') return <TerminalSquare size={14} />;
  if (tool === 'write_file' || tool === 'edit_file') return <FilePen size={14} />;
  return <FileSearch size={14} />;
}
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron bọc lỗi IPC: "Error invoking remote method 'x': Error: <thông điệp>"
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

type DiffMode = 'unified' | 'split';
const EDITOR_CHOICES: { id: string; label: string }[] = [
  { id: 'vscode', label: 'VS Code' }, { id: 'cursor', label: 'Cursor' }, { id: 'windsurf', label: 'Windsurf' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' }, { id: 'vscodium', label: 'VSCodium' }, { id: 'default', label: 'Ứng dụng mặc định' }
];
interface DiffPrefs { mode: DiffMode; editor: string; open: (rel: string, line?: number) => void; }
const DiffPrefsContext = createContext<DiffPrefs>({ mode: 'unified', editor: 'vscode', open: () => undefined });

function readPref(key: string, fallback: string): string {
  try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* bỏ qua: chỉ là tiện ích */ }
}

/** Diff cạnh nhau: cột trái = bản hiện tại, cột phải = bản sau khi sửa; có số dòng. */
function SideBySide({ view }: { view: DiffHunkView[] }) {
  return (
    <div className="agent-sbs">
      {view.map((h, hi) => (
        <div key={hi} className="agent-sbs-hunk">
          <div className="agent-sbs-header">{h.header}</div>
          <table>
            <tbody>
              {h.rows.map((r, ri) => (
                <tr key={ri} className={r.k}>
                  <td className="ln">{r.l ? r.l.n : ''}</td>
                  <td className={`cell left ${r.l ? (r.k === 'ctx' ? '' : 'del') : 'empty'}`}><pre>{r.l ? r.l.s || ' ' : ''}</pre></td>
                  <td className="ln">{r.r ? r.r.n : ''}</td>
                  <td className={`cell right ${r.r ? (r.k === 'ctx' ? '' : 'add') : 'empty'}`}><pre>{r.r ? r.r.s || ' ' : ''}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function OpenInEditorButton({ rel, line }: { rel: string; line?: number }) {
  const prefs = useContext(DiffPrefsContext);
  if (!rel) return null;
  return (
    <button className="agent-link" title={`Mở ${rel} trong editor tại dòng ${line || 1} (bản hiện tại trên đĩa)`} onClick={() => prefs.open(rel, line)}>
      <ExternalLink size={11} /> Mở tại dòng {line || 1}
    </button>
  );
}

function DiffView({ diff, view }: { diff: string; view?: DiffHunkView[] }) {
  const prefs = useContext(DiffPrefsContext);
  if (!diff) return null;
  if (prefs.mode === 'split' && view && view.length) return <SideBySide view={view} />;
  return (
    <pre className="agent-diff">
      {diff.split('\n').map((line, i) => {
        let cls = '';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta';
        else if (line.startsWith('@@')) cls = 'hunk';
        else if (line.startsWith('+')) cls = 'add';
        else if (line.startsWith('-')) cls = 'del';
        return <span key={i} className={`agent-diff-line ${cls}`}>{line || ' '}{'\n'}</span>;
      })}
    </pre>
  );
}

function ApprovalCard({ item, busy, onDecide }: {
  item: AgentPending;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject' | 'approve_all_edits' | 'approve_group') => void;
}) {
  const isExec = item.kind === 'exec';
  const [tab, setTab] = useState<'one' | 'group'>(item.group ? 'group' : 'one');
  const group = item.group || null;
  const showGroup = !!group && tab === 'group';
  return (
    <div className={`agent-approval ${isExec ? 'exec' : 'edit'}`}>
      <div className="agent-approval-head">
        {isExec ? <ShieldAlert size={15} /> : <FilePen size={15} />}
        <strong>{isExec ? 'Chạy lệnh' : item.tool === 'write_file' ? 'Ghi file' : 'Sửa file'}</strong>
        {item.source === 'vibe' && <span className="agent-badge">từ trang Gemini</span>}
      </div>
      <code className="agent-approval-target" title={item.label}>{isExec ? '$ ' : ''}{item.label}</code>
      {item.summary && <div className="agent-approval-summary">{showGroup && group ? group.summary : item.summary}</div>}
      {group && (
        <div className="agent-tabs" role="tablist">
          <button className={tab === 'group' ? 'on' : ''} role="tab" aria-selected={tab === 'group'} onClick={() => setTab('group')}>Tổng hợp {group.count} thao tác</button>
          <button className={tab === 'one' ? 'on' : ''} role="tab" aria-selected={tab === 'one'} onClick={() => setTab('one')}>Chỉ thao tác này</button>
        </div>
      )}
      {!isExec && <DiffView diff={showGroup && group ? group.diff : item.diff} view={showGroup && group ? group.view : item.view} />}
      {!isExec && <div className="agent-approval-tools"><OpenInEditorButton rel={item.label} line={showGroup && group ? group.line : item.line} /></div>}
      {isExec && <div className="agent-warn">Lệnh chạy với quyền của bạn trong thư mục dự án. Chỉ duyệt nếu bạn hiểu rõ lệnh này.</div>}
      <div className="agent-approval-actions">
        <button className="agent-btn primary" disabled={busy} onClick={() => onDecide(item.id, 'approve')}><Check size={14} /> Duyệt{group ? ' thao tác này' : ''}</button>
        {group && item.source === 'agent' && (
          <button className="agent-btn primary" disabled={busy} title="Áp dụng tuần tự cả nhóm thao tác sửa cùng file đã xem ở tab Tổng hợp. Mỗi thao tác vẫn có checkpoint riêng để hoàn tác; lệnh terminal vẫn luôn hỏi." onClick={() => onDecide(item.id, 'approve_group')}><Check size={14} /> Duyệt cả {group.count}</button>
        )}
        <button className="agent-btn" disabled={busy} onClick={() => onDecide(item.id, 'reject')}><X size={14} /> Từ chối</button>
        {!isExec && item.source === 'agent' && (
          <button className="agent-btn ghost" disabled={busy} title="Các lần sửa file sau sẽ tự áp dụng. Lệnh terminal vẫn luôn hỏi." onClick={() => onDecide(item.id, 'approve_all_edits')}>
            Duyệt & tự duyệt sửa file
          </button>
        )}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  if (step.type === 'assistant') {
    return <div className="agent-step assistant"><MarkdownRenderer content={step.text || ''} /></div>;
  }
  if (step.type === 'user') return <div className="agent-step user">{step.text}</div>;
  if (step.type === 'info') return <div className="agent-step info">{step.text}</div>;
  if (step.type === 'error') return <div className="agent-step error">{step.text}</div>;
  const hasDetail = !!(step.diff || step.output || step.text);
  const status = step.status || 'running';
  return (
    <div className={`agent-step tool ${status}`}>
      <button className="agent-step-head" onClick={() => hasDetail && setOpen(o => !o)} aria-expanded={open}>
        {hasDetail ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="agent-chevron-pad" />}
        {toolIcon(step.tool)}
        <span className="agent-step-tool">{step.tool}</span>
        <span className="agent-step-label" title={step.label}>{step.label}</span>
        <span className={`agent-step-status ${status}`}>
          {status === 'running' && <LoaderCircle size={12} className="agent-spin" />}
          {status === 'done' && 'xong'}
          {status === 'failed' && 'thất bại'}
          {status === 'error' && 'lỗi'}
          {status === 'rejected' && 'từ chối'}
          {status === 'waiting_approval' && 'chờ duyệt'}
          {status === 'expired' && 'hết hạn'}
          {status === 'interrupted' && 'bị gián đoạn'}
        </span>
      </button>
      {step.summary && <div className="agent-step-summary">{step.summary}</div>}
      {open && (
        <div className="agent-step-detail">
          {step.diff && <DiffView diff={step.diff} view={step.view} />}
          {step.diff && (step.tool === 'edit_file' || step.tool === 'write_file') && <div className="agent-approval-tools"><OpenInEditorButton rel={step.label || ''} line={step.line} /></div>}
          {step.output && <pre className="agent-output">{step.output}</pre>}
          {step.text && !step.output && <pre className="agent-output">{step.text}</pre>}
        </div>
      )}
    </div>
  );
}

export function AgentPanel({ sessionId = 'main', connected, workspaceOpen, onToast, onFilesChanged }: {
  sessionId?: string;
  connected: boolean;
  workspaceOpen: boolean;
  onToast: (message: string) => void;
  onFilesChanged?: () => void;
}) {
  // Mỗi phiên song song có API riêng gắn với sessionId; panel được mount lại (key) khi đổi phiên.
  const api = useMemo(() => window.studio.agentFor(sessionId), [sessionId]);
  const [state, setState] = useState<AgentState>(EMPTY);
  const [goal, setGoal] = useState('');
  const [reply, setReply] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previous, setPrevious] = useState<PreviousSession | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(() => (readPref('gps.diffMode', 'unified') === 'split' ? 'split' : 'unified'));
  const [editor, setEditor] = useState<string>(() => { const v = readPref('gps.editor', 'vscode'); return EDITOR_CHOICES.some(e => e.id === v) ? v : 'vscode'; });
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastStepCount = useRef(0);

  useEffect(() => {
    let alive = true;
    api.state().then(s => { if (alive) setState(s); }).catch(() => {});
    const off = api.onState(s => { if (alive) setState(s); });
    return () => { alive = false; off(); };
  }, []);

  // Phiên đã lưu của project hiện tại (nếu có) — hiện thẻ "Tiếp tục phiên trước" khi chưa có phiên nào đang chạy.
  useEffect(() => {
    let alive = true;
    if (!workspaceOpen || state.id) { setPrevious(null); return () => { alive = false; }; }
    api.previous().then(p => { if (alive) setPrevious(p); }).catch(() => { if (alive) setPrevious(null); });
    return () => { alive = false; };
  }, [workspaceOpen, state.id]);

  const openInEditor = useCallback((rel: string, line?: number) => {
    api.openInEditor(rel, line || 1, editor).then(r => {
      if (r.opened === 'none') onToast(`Không mở được file${r.error ? ': ' + r.error : ''}.`);
      else if (r.fallback) onToast('Không mở được bằng editor đã chọn (chưa cài hoặc chưa đăng ký) → đã mở bằng ứng dụng mặc định, không tới đúng dòng.');
    }).catch(err => onToast(errText(err)));
  }, [api, editor, onToast]);
  const prefs = useMemo<DiffPrefs>(() => ({ mode: diffMode, editor, open: openInEditor }), [diffMode, editor, openInEditor]);

  const refreshCheckpoints = useCallback(() => {
    api.checkpoints().then(setCheckpoints).catch(() => {});
  }, []);
  // Tải lại danh sách checkpoint khi có bước mới (một file vừa được ghi).
  useEffect(() => {
    if (state.steps.length !== lastStepCount.current) {
      lastStepCount.current = state.steps.length;
      if (showCheckpoints) refreshCheckpoints();
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [state.steps.length, showCheckpoints, refreshCheckpoints]);
  useEffect(() => { if (showCheckpoints) refreshCheckpoints(); }, [showCheckpoints, refreshCheckpoints]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }, []);

  const start = () => run(async () => { await api.start(goal); setGoal(''); });
  const send = () => run(async () => { await api.reply(reply); setReply(''); });
  const addFiles = (files: File[]) => run(async () => {
    for (const f of files) {
      if (f.size > ATTACH_MAX_BYTES) throw new Error(`${f.name}: tệp quá lớn (tối đa ${ATTACH_MAX_BYTES / 1024 / 1024} MB).`);
      await api.attach(f.name || 'anh-dan.png', await fileToBase64(f));
    }
  });
  const removeAttachment = (id: string) => run(async () => { await api.detach(id); });
  const onPasteFiles = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const decide = (id: string, decision: 'approve' | 'reject' | 'approve_all_edits' | 'approve_group') =>
    run(async () => { await api.approve(id, decision); if (decision !== 'reject') onFilesChanged?.(); });
  const copyPrompt = () => run(async () => {
    if (!state.jobId) return;
    const prompt = await api.jobPrompt(state.jobId);
    if (!prompt) throw new Error('Không còn prompt cho lượt này.');
    await window.studio.copy(prompt);
    onToast('Đã sao chép prompt. Dán vào gemini.google.com, rồi dán câu trả lời vào ô bên dưới.');
  });
  const importManual = () => run(async () => {
    if (!state.jobId) return;
    await window.studio.importReply(state.jobId, manual);
    setManual('');
  });
  const undo = (cp: CheckpointInfo) => run(async () => {
    try {
      await api.undo(cp.id);
    } catch (err) {
      if (/đã thay đổi sau checkpoint/.test(errText(err))) {
        if (window.confirm(`${cp.path} đã được sửa tiếp sau thay đổi này. Hoàn tác sẽ ghi đè các chỉnh sửa mới hơn. Tiếp tục?`)) {
          await api.undo(cp.id, true);
        } else return;
      } else throw err;
    }
    refreshCheckpoints();
    onFilesChanged?.();
    onToast(`Đã hoàn tác ${cp.path}`);
  });

  const { status } = state;
  const working = status === 'running' || status === 'waiting_approval';
  const canStart = (status === 'idle' || status === 'cancelled' || status === 'done') && !working;
  const awaitingReply = status === 'waiting_user' || status === 'done' || status === 'cancelled';
  const hasRun = !!state.id;
  const stepList = useMemo(() => state.steps, [state.steps]);
  const waitingForGemini = status === 'running' && !!state.jobId;

  if (!workspaceOpen) {
    return <div className="agent-pane agent-empty"><Bot size={28} /><p>Hãy mở một thư mục dự án để dùng Agent.</p></div>;
  }

  return (
    <DiffPrefsContext.Provider value={prefs}>
    <div className="agent-pane">
      <div className="agent-top">
        <div className={`agent-status ${status}`}>
          {working && <LoaderCircle size={13} className="agent-spin" />}
          <span>{STATUS_LABEL[status]}</span>
          {hasRun && status !== 'idle' && <span className="agent-turn">lượt {state.turn}/{state.maxTurns}</span>}
        </div>
        <div className="agent-prefs">
          <div className="agent-seg" role="group" aria-label="Kiểu hiển thị diff">
            <button className={diffMode === 'unified' ? 'on' : ''} onClick={() => { setDiffMode('unified'); writePref('gps.diffMode', 'unified'); }} title="Diff gộp (unified)">Gộp</button>
            <button className={diffMode === 'split' ? 'on' : ''} onClick={() => { setDiffMode('split'); writePref('gps.diffMode', 'split'); }} title="Diff cạnh nhau: trái = hiện tại, phải = sau khi sửa">Cạnh nhau</button>
          </div>
          <select className="agent-select" value={editor} onChange={e => { setEditor(e.target.value); writePref('gps.editor', e.target.value); }} title="Editor dùng cho nút 'Mở tại dòng N'" aria-label="Editor">
            {EDITOR_CHOICES.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </div>
        <label className="agent-toggle" title="Khi bật, các lần sửa/tạo file tự áp dụng (vẫn hoàn tác được). Chạy lệnh terminal LUÔN cần bạn duyệt.">
          <input
            type="checkbox" checked={state.policy.autoEdits}
            onChange={e => { void api.setPolicy({ autoEdits: e.target.checked }); }}
          />
          <span>Tự duyệt sửa file</span>
        </label>
      </div>
      {hasRun && state.context.chatIndex > 0 && (
        <ContextMeterBar
          context={state.context}
          canRotate={status !== 'running' && status !== 'waiting_approval'}
          onRotate={() => { void api.rotateNext().then(setState).catch(() => undefined); }}
        />
      )}
      {hasRun && state.plan && state.plan.items.length > 0 && <PlanChecklist plan={state.plan} />}
      {state.policy.autoEdits && (
        <div className="agent-note"><ShieldCheck size={13} /> Sửa file tự áp dụng. Lệnh terminal vẫn luôn hỏi bạn.</div>
      )}

      <div className="agent-scroll">
        {!hasRun && previous && (
          <div className="agent-resume">
            <div className="agent-resume-head"><History size={14} /> <strong>Phiên trước chưa kết thúc trong Studio</strong></div>
            <div className="agent-resume-goal" title={previous.goal}>{previous.goal}</div>
            <div className="agent-resume-meta">
              Lưu lúc {previous.savedAt ? new Date(previous.savedAt).toLocaleString('vi-VN') : 'không rõ'} · {previous.stepCount} bước
              {previous.filesChanged.length > 0 && <> · đã sửa {previous.filesChanged.length} file ({previous.filesChanged.slice(0, 3).join(', ')}{previous.filesChanged.length > 3 ? '…' : ''})</>}
            </div>
            {previous.interrupted && <div className="agent-warn">Phiên bị gián đoạn khi ứng dụng đóng.{previous.expiredApprovals > 0 ? ` ${previous.expiredApprovals} yêu cầu duyệt đang chờ đã HẾT HẠN và sẽ không tự chạy.` : ''}</div>}
            <div className="agent-resume-note">Gemini cũ không còn dùng được: tiếp tục sẽ mở chat Gemini mới kèm bản tóm tắt tiến độ. Chính sách tự duyệt luôn tắt sau khi mở lại.</div>
            <div className="agent-row">
              <button className="agent-btn primary" disabled={busy || !connected} title={connected ? '' : 'Cần extension kết nối để gửi tiếp tới Gemini'} onClick={() => run(async () => { await api.resume({ continueRun: true }); setPrevious(null); })}><Play size={14} /> Tiếp tục phiên trước</button>
              <button className="agent-btn" disabled={busy} onClick={() => run(async () => { await api.resume({ continueRun: false }); setPrevious(null); })}>Chỉ xem lại</button>
              <button className="agent-btn ghost" disabled={busy} onClick={() => run(async () => { await api.discardPrevious(); setPrevious(null); })}>Bỏ</button>
            </div>
          </div>
        )}
        {!hasRun && (
          <div className="agent-intro">
            <Bot size={22} />
            <p>Giao một mục tiêu, Gemini sẽ tự đọc code, đề xuất sửa file và chạy lệnh qua Studio. <b>Mọi thay đổi và lệnh đều hiện để bạn duyệt</b> (kèm diff), và có thể hoàn tác.</p>
            {!connected && <p className="agent-warn">Extension chưa kết nối. Vẫn dùng được ở chế độ thủ công: Studio đưa prompt, bạn dán sang Gemini rồi dán câu trả lời về.</p>}
          </div>
        )}

        {stepList.map(step => <StepRow key={step.id} step={step} />)}

        {state.pending.map(item => <ApprovalCard key={item.id} item={item} busy={busy} onDecide={decide} />)}

        {waitingForGemini && (
          <div className="agent-live">
            <LoaderCircle size={13} className="agent-spin" />
            {state.liveText ? `Gemini đang viết… (${state.liveText.length} ký tự)` : connected ? 'Đang chờ Gemini…' : 'Đang chờ bạn đưa prompt sang Gemini'}
          </div>
        )}

        {waitingForGemini && !connected && (
          <div className="agent-manual">
            <button className="agent-btn" disabled={busy} onClick={copyPrompt}><ClipboardCopy size={14} /> Sao chép prompt cho Gemini</button>
            <textarea placeholder="Dán nguyên câu trả lời của Gemini vào đây…" value={manual} onChange={e => setManual(e.target.value)} rows={4} />
            <button className="agent-btn primary" disabled={busy || !manual.trim()} onClick={importManual}>Dùng câu trả lời này</button>
          </div>
        )}

        {status === 'waiting_user' && state.question && <div className="agent-question">{state.question}</div>}
        {status === 'error' && <div className="agent-step error">{state.error}</div>}
        {error && <div className="agent-step error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="agent-composer">
        {canStart && !awaitingReply && (
          <>
            <textarea placeholder="Mục tiêu cho agent. Ví dụ: tìm và sửa lỗi đăng nhập, rồi chạy test" value={goal} onChange={e => setGoal(e.target.value)} onPaste={onPasteFiles} rows={3} />
            <AttachBar items={state.attachments} disabled={busy} onPick={addFiles} onRemove={removeAttachment} />
            <button className="agent-btn primary" disabled={busy || !goal.trim()} onClick={start}><Play size={14} /> Bắt đầu</button>
          </>
        )}
        {awaitingReply && hasRun && (
          <>
            <textarea
              placeholder={status === 'waiting_user' ? 'Trả lời agent…' : 'Giao thêm việc cho agent (cùng cuộc trò chuyện)…'}
              value={reply} onChange={e => setReply(e.target.value)} onPaste={onPasteFiles} rows={2}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (reply.trim() && !busy) void send(); } }}
            />
            <AttachBar items={state.attachments} disabled={busy} onPick={addFiles} onRemove={removeAttachment} />
            <div className="agent-row">
              <button className="agent-btn primary" disabled={busy || !reply.trim()} onClick={send}>Gửi</button>
              <button className="agent-btn" disabled={busy} onClick={() => { void api.cancel().then(() => setState(s => ({ ...s, id: null, steps: [], plan: null, attachments: [], status: 'idle' }))); }} title="Bắt đầu lại với mục tiêu mới">Phiên mới</button>
            </div>
          </>
        )}
        {status === 'error' && (
          <div className="agent-row">
            <button className="agent-btn primary" disabled={busy} onClick={() => run(() => api.retry())}><RotateCcw size={14} /> Thử lại</button>
            <button className="agent-btn" disabled={busy} onClick={() => run(() => api.cancel())}>Dừng</button>
          </div>
        )}
        {working && (
          <button className="agent-btn danger" onClick={() => run(() => api.cancel())}><Square size={13} /> Dừng agent</button>
        )}
      </div>

      <div className="agent-checkpoints">
        <button className="agent-cp-toggle" onClick={() => setShowCheckpoints(v => !v)}>
          {showCheckpoints ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <History size={13} /> Lịch sử thay đổi & hoàn tác
        </button>
        {showCheckpoints && (
          <div className="agent-cp-list">
            {checkpoints.length === 0 && <div className="agent-cp-empty">Chưa có thay đổi nào.</div>}
            {checkpoints.map(cp => (
              <div key={cp.id} className={`agent-cp ${cp.undone ? 'undone' : ''}`}>
                <div className="agent-cp-info">
                  <code title={cp.path}>{cp.path}</code>
                  <span>{cp.created ? 'tạo mới' : 'sửa'} · {cp.source} · {new Date(cp.at).toLocaleTimeString('vi-VN')}{cp.undone ? ' · đã hoàn tác' : ''}</span>
                </div>
                {!cp.undone && <button className="agent-btn small" disabled={busy} onClick={() => undo(cp)}><Undo2 size={12} /> Hoàn tác</button>}
              </div>
            ))}
          </div>
        )}
      </div>
      <PreviewPanel sessionId={sessionId} onToast={onToast} />
      <TerminalPanel />
      <GitPanel onToast={onToast} />
      <RulesPanel onToast={onToast} />
    </div>
    </DiffPrefsContext.Provider>
  );
}
