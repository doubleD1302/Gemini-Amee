import type { ChatSession } from '../types';

const STORAGE_KEY_SESSIONS = 'gps_chat_sessions_v1';
const STORAGE_KEY_ACTIVE_ID = 'gps_active_session_id_v1';

export function loadChatSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is ChatSession => s && typeof s.id === 'string' && Array.isArray(s.messages))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  } catch (err) {
    console.error('Failed to load chat history from localStorage', err);
    return [];
  }
}

// localStorage chỉ có ~5MB. Mỗi tin nhắn từng lưu cả prompt đã chuẩn bị (tới ~48.000 ký tự) nên rất nhanh đầy.
const MAX_STORED_CHARS = 3_500_000;
const KEEP_PREPARED_PROMPTS = 2; // chỉ giữ prompt của vài tin nhắn cuối mỗi phiên (đủ cho nút "sao chép lại")

/** Bỏ dữ liệu nặng và loại dần phiên cũ nhất nếu vẫn quá lớn. Không bao giờ bỏ phiên mới nhất. */
export function pruneSessionsForStorage(sessions: ChatSession[], maxChars: number = MAX_STORED_CHARS): ChatSession[] {
  let slim = sessions.map(s => ({
    ...s,
    messages: s.messages.map((m, i) => {
      if (m.preparedPrompt && i < s.messages.length - KEEP_PREPARED_PROMPTS) {
        const { preparedPrompt: _drop, ...rest } = m;
        void _drop;
        return rest;
      }
      return m;
    })
  }));
  let size = JSON.stringify(slim).length;
  while (size > maxChars && slim.length > 1) {
    let oldest = 0;
    for (let i = 1; i < slim.length; i++) {
      if ((slim[i].updatedAt || 0) < (slim[oldest].updatedAt || 0)) oldest = i;
    }
    slim = slim.filter((_, i) => i !== oldest);
    size = JSON.stringify(slim).length;
  }
  return slim;
}

export function saveChatSessions(sessions: ChatSession[]): void {
  // Hết quota thì thu nhỏ ngưỡng dần (giữ phiên mới nhất) thay vì mất toàn bộ lịch sử.
  let budget = MAX_STORED_CHARS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(pruneSessionsForStorage(sessions, budget)));
      return;
    } catch (err) {
      lastErr = err;
      budget = Math.floor(budget / 2);
    }
  }
  console.error('Failed to save chat history to localStorage', lastErr);
}

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_ID) || null;
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_ID);
    }
  } catch {
    // Ignore storage errors
  }
}

export function createNewSession(
  workspaceRoot?: string,
  workspaceName?: string,
  model?: string,
  mode?: string
): ChatSession {
  const now = Date.now();
  return {
    id: `sess_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: 'Cuộc trò chuyện mới',
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
    workspaceName,
    model,
    mode,
    messages: []
  };
}

export function generateSessionTitle(promptText: string): string {
  if (!promptText) return 'Cuộc trò chuyện mới';
  // Strip mode prefixes like [Chế độ: ...]
  let cleaned = promptText.replace(/^\[Chế độ:[^\]]+\]\s*/i, '').trim();
  // Strip common leading phrases
  cleaned = cleaned.replace(/^(Đóng vai|Hãy|Cho tôi hỏi|Xin hãy|Giải thích|Phân tích|Hướng dẫn)\s+/i, '');
  // Take first line or up to 50 chars
  const firstLine = cleaned.split('\n')[0].trim();
  if (!firstLine) return 'Cuộc trò chuyện mới';
  if (firstLine.length <= 48) {
    return firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
  }
  return (firstLine.slice(0, 48).trim()) + '…';
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Vừa xong';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);

  if (diffSec < 45) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))} phút trước`;

  const date = new Date(timestamp);
  const nowDate = new Date(now);

  const isToday = date.toDateString() === nowDate.toDateString();
  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  if (isToday) return `Hôm nay ${timeStr}`;
  if (isYesterday) return `Hôm qua ${timeStr}`;

  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();

  if (year === nowDate.getFullYear()) {
    return `${day}/${month} ${timeStr}`;
  }
  return `${day}/${month}/${year}`;
}

export interface DateGroupedSessions {
  category: 'today' | 'yesterday' | 'past7' | 'past30' | 'older';
  label: string;
  sessions: ChatSession[];
}

export function groupSessionsByDate(sessions: ChatSession[]): DateGroupedSessions[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfPast7 = startOfToday - 7 * 86400000;
  const startOfPast30 = startOfToday - 30 * 86400000;

  const groups: Record<DateGroupedSessions['category'], ChatSession[]> = {
    today: [],
    yesterday: [],
    past7: [],
    past30: [],
    older: []
  };

  sessions.forEach(session => {
    const t = session.updatedAt || session.createdAt || 0;
    if (t >= startOfToday) {
      groups.today.push(session);
    } else if (t >= startOfYesterday) {
      groups.yesterday.push(session);
    } else if (t >= startOfPast7) {
      groups.past7.push(session);
    } else if (t >= startOfPast30) {
      groups.past30.push(session);
    } else {
      groups.older.push(session);
    }
  });

  const result: DateGroupedSessions[] = [];
  if (groups.today.length > 0) result.push({ category: 'today', label: 'Hôm nay', sessions: groups.today });
  if (groups.yesterday.length > 0) result.push({ category: 'yesterday', label: 'Hôm qua', sessions: groups.yesterday });
  if (groups.past7.length > 0) result.push({ category: 'past7', label: '7 ngày trước', sessions: groups.past7 });
  if (groups.past30.length > 0) result.push({ category: 'past30', label: '30 ngày trước', sessions: groups.past30 });
  if (groups.older.length > 0) result.push({ category: 'older', label: 'Cũ hơn', sessions: groups.older });

  return result;
}

export function exportSessionAsMarkdown(session: ChatSession): string {
  const createdDate = new Date(session.createdAt).toLocaleString('vi-VN');
  const updatedDate = new Date(session.updatedAt).toLocaleString('vi-VN');

  const lines: string[] = [
    `# 💬 ${session.title}`,
    '',
    `- **Dự án**: ${session.workspaceName || 'Chưa liên kết dự án'}`,
    `- **Đường dẫn thư mục**: \`${session.workspaceRoot || 'N/A'}\``,
    `- **Thời gian tạo**: ${createdDate}`,
    `- **Cập nhật lần cuối**: ${updatedDate}`,
    `- **Số lượt trao đổi**: ${session.messages.length} tin nhắn`,
    '',
    '---',
    ''
  ];

  session.messages.forEach((msg, idx) => {
    const sender = msg.role === 'user' ? '👤 BẠN' : '✨ GEMINI WEB';
    lines.push(`## ${idx + 1}. ${sender}`);
    if (msg.included && msg.included.length > 0) {
      lines.push(`*Ngữ cảnh dự án (${msg.included.length} files)*: \`${msg.included.join('`, `')}\``);
      lines.push('');
    }
    lines.push(msg.text);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  lines.push('> *Được xuất từ Gemini Project Studio (Antigravity Chat History)*');
  return lines.join('\n');
}

export function exportSessionsAsJSON(sessions: ChatSession[]): string {
  return JSON.stringify(
    {
      app: 'Gemini Project Studio',
      version: '0.2.0',
      exportedAt: new Date().toISOString(),
      totalSessions: sessions.length,
      sessions
    },
    null,
    2
  );
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
