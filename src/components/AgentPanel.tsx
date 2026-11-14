import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, ChevronDown, ChevronRight, ClipboardCopy, FilePen, FileSearch, History, LoaderCircle,
  Play, RotateCcw, ShieldAlert, ShieldCheck, Square, TerminalSquare, Undo2, X
} from 'lucide-react';
import type { AgentPending, AgentState, AgentStep, CheckpointInfo } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import './AgentPanel.css';

const EMPTY: AgentState = {
  id: null, goal: '', status: 'idle', turn: 0, maxTurns: 25, conversationUrl: null, jobId: null,
  liveText: '', error: '', question: '', policy: { autoEdits: false },
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

function DiffView({ diff }: { diff: string }) {
  if (!diff) return null;
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
  onDecide: (id: string, decision: 'approve' | 'reject' | 'approve_all_edits') => void;
}) {
  const isExec = item.kind === 'exec';
  return (
    <div className={`agent-approval ${isExec ? 'exec' : 'edit'}`}>
      <div className="agent-approval-head">
        {isExec ? <ShieldAlert size={15} /> : <FilePen size={15} />}
        <strong>{isExec ? 'Chạy lệnh' : item.tool === 'write_file' ? 'Ghi file' : 'Sửa file'}</strong>
        {item.source === 'vibe' && <span className="agent-badge">từ trang Gemini</span>}
      </div>
      <code className="agent-approval-target" title={item.label}>{isExec ? '$ ' : ''}{item.label}</code>
      {item.summary && <div className="agent-approval-summary">{item.summary}</div>}
      {!isExec && <DiffView diff={item.diff} />}
      {isExec && <div className="agent-warn">Lệnh chạy với quyền của bạn trong thư mục dự án. Chỉ duyệt nếu bạn hiểu rõ lệnh này.</div>}
      <div className="agent-approval-actions">
        <button className="agent-btn primary" disabled={busy} onClick={() => onDecide(item.id, 'approve')}><Check size={14} /> Duyệt</button>
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
        </span>
      </button>
      {step.summary && <div className="agent-step-summary">{step.summary}</div>}
      {open && (
        <div className="agent-step-detail">
          {step.diff && <DiffView diff={step.diff} />}
          {step.output && <pre className="agent-output">{step.output}</pre>}
          {step.text && !step.output && <pre className="agent-output">{step.text}</pre>}
        </div>
      )}
    </div>
  );
}

export function AgentPanel({ connected, workspaceOpen, onToast, onFilesChanged }: {
  connected: boolean;
  workspaceOpen: boolean;
  onToast: (message: string) => void;
  onFilesChanged?: () => void;
}) {
  const [state, setState] = useState<AgentState>(EMPTY);
  const [goal, setGoal] = useState('');
  const [reply, setReply] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastStepCount = useRef(0);

  useEffect(() => {
    let alive = true;
    window.studio.agent.state().then(s => { if (alive) setState(s); }).catch(() => {});
    const off = window.studio.agent.onState(s => { if (alive) setState(s); });
    return () => { alive = false; off(); };
  }, []);

  const refreshCheckpoints = useCallback(() => {
    window.studio.agent.checkpoints().then(setCheckpoints).catch(() => {});
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

  const start = () => run(async () => { await window.studio.agent.start(goal); setGoal(''); });
  const send = () => run(async () => { await window.studio.agent.reply(reply); setReply(''); });
  const decide = (id: string, decision: 'approve' | 'reject' | 'approve_all_edits') =>
    run(async () => { await window.studio.agent.approve(id, decision); if (decision !== 'reject') onFilesChanged?.(); });
  const copyPrompt = () => run(async () => {
    if (!state.jobId) return;
    const prompt = await window.studio.agent.jobPrompt(state.jobId);
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
      await window.studio.agent.undo(cp.id);
    } catch (err) {
      if (/đã thay đổi sau checkpoint/.test(errText(err))) {
        if (window.confirm(`${cp.path} đã được sửa tiếp sau thay đổi này. Hoàn tác sẽ ghi đè các chỉnh sửa mới hơn. Tiếp tục?`)) {
          await window.studio.agent.undo(cp.id, true);
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
    <div className="agent-pane">
      <div className="agent-top">
        <div className={`agent-status ${status}`}>
          {working && <LoaderCircle size={13} className="agent-spin" />}
          <span>{STATUS_LABEL[status]}</span>
          {hasRun && status !== 'idle' && <span className="agent-turn">lượt {state.turn}/{state.maxTurns}</span>}
        </div>
        <label className="agent-toggle" title="Khi bật, các lần sửa/tạo file tự áp dụng (vẫn hoàn tác được). Chạy lệnh terminal LUÔN cần bạn duyệt.">
          <input
            type="checkbox" checked={state.policy.autoEdits}
            onChange={e => { void window.studio.agent.setPolicy({ autoEdits: e.target.checked }); }}
          />
          <span>Tự duyệt sửa file</span>
        </label>
      </div>
      {hasRun && state.context.chatIndex > 0 && (
        <ContextMeterBar
          context={state.context}
          canRotate={status !== 'running' && status !== 'waiting_approval'}
          onRotate={() => { void window.studio.agent.rotateNext().then(setState).catch(() => undefined); }}
        />
      )}
      {state.policy.autoEdits && (
        <div className="agent-note"><ShieldCheck size={13} /> Sửa file tự áp dụng. Lệnh terminal vẫn luôn hỏi bạn.</div>
      )}

      <div className="agent-scroll">
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
            <textarea placeholder="Mục tiêu cho agent. Ví dụ: tìm và sửa lỗi đăng nhập, rồi chạy test" value={goal} onChange={e => setGoal(e.target.value)} rows={3} />
            <button className="agent-btn primary" disabled={busy || !goal.trim()} onClick={start}><Play size={14} /> Bắt đầu</button>
          </>
        )}
        {awaitingReply && hasRun && (
          <>
            <textarea
              placeholder={status === 'waiting_user' ? 'Trả lời agent…' : 'Giao thêm việc cho agent (cùng cuộc trò chuyện)…'}
              value={reply} onChange={e => setReply(e.target.value)} rows={2}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (reply.trim() && !busy) void send(); } }}
            />
            <div className="agent-row">
              <button className="agent-btn primary" disabled={busy || !reply.trim()} onClick={send}>Gửi</button>
              <button className="agent-btn" disabled={busy} onClick={() => { void window.studio.agent.cancel().then(() => setState(s => ({ ...s, id: null, steps: [], status: 'idle' }))); }} title="Bắt đầu lại với mục tiêu mới">Phiên mới</button>
            </div>
          </>
        )}
        {status === 'error' && (
          <div className="agent-row">
            <button className="agent-btn primary" disabled={busy} onClick={() => run(() => window.studio.agent.retry())}><RotateCcw size={14} /> Thử lại</button>
            <button className="agent-btn" disabled={busy} onClick={() => run(() => window.studio.agent.cancel())}>Dừng</button>
          </div>
        )}
        {working && (
          <button className="agent-btn danger" onClick={() => run(() => window.studio.agent.cancel())}><Square size={13} /> Dừng agent</button>
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
    </div>
  );
}
