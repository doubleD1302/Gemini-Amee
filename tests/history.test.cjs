'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Re-implement the pure logic in CJS for unit testing matching src/utils/historyStorage.ts
function generateSessionTitle(promptText) {
  if (!promptText) return 'Cuộc trò chuyện mới';
  let cleaned = promptText.replace(/^\[Chế độ:[^\]]+\]\s*/i, '').trim();
  cleaned = cleaned.replace(/^(Đóng vai|Hãy|Cho tôi hỏi|Xin hãy|Giải thích|Phân tích|Hướng dẫn)\s+/i, '');
  const firstLine = cleaned.split('\n')[0].trim();
  if (!firstLine) return 'Cuộc trò chuyện mới';
  if (firstLine.length <= 48) {
    return firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
  }
  return (firstLine.slice(0, 48).trim()) + '…';
}

function formatRelativeTime(timestamp, mockNow) {
  if (!timestamp) return 'Vừa xong';
  const now = mockNow || Date.now();
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

function groupSessionsByDate(sessions, mockNow) {
  const now = mockNow ? new Date(mockNow) : new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfPast7 = startOfToday - 7 * 86400000;
  const startOfPast30 = startOfToday - 30 * 86400000;

  const groups = {
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

  const result = [];
  if (groups.today.length > 0) result.push({ category: 'today', label: 'Hôm nay', sessions: groups.today });
  if (groups.yesterday.length > 0) result.push({ category: 'yesterday', label: 'Hôm qua', sessions: groups.yesterday });
  if (groups.past7.length > 0) result.push({ category: 'past7', label: '7 ngày trước', sessions: groups.past7 });
  if (groups.past30.length > 0) result.push({ category: 'past30', label: '30 ngày trước', sessions: groups.past30 });
  if (groups.older.length > 0) result.push({ category: 'older', label: 'Cũ hơn', sessions: groups.older });

  return result;
}

function exportSessionAsMarkdown(session) {
  const lines = [
    `# 💬 ${session.title}`,
    '',
    `- **Dự án**: ${session.workspaceName || 'Chưa liên kết dự án'}`,
    `- **Số lượt trao đổi**: ${session.messages.length} tin nhắn`,
    '',
    '---',
    ''
  ];

  session.messages.forEach((msg, idx) => {
    const sender = msg.role === 'user' ? '👤 BẠN' : '✨ GEMINI WEB';
    lines.push(`## ${idx + 1}. ${sender}`);
    lines.push(msg.text);
    lines.push('');
  });

  return lines.join('\n');
}

test('generateSessionTitle strips mode prefixes and extracts clean title', () => {
  assert.equal(generateSessionTitle(''), 'Cuộc trò chuyện mới');
  assert.equal(generateSessionTitle('[Chế độ: Rà soát Bug & Bảo mật] Kiểm tra lỗi SQL injection trong auth.ts'), 'Kiểm tra lỗi SQL injection trong auth.ts');
  assert.equal(generateSessionTitle('Hãy giải thích kiến trúc MVC của dự án này'), 'Giải thích kiến trúc MVC của dự án này');
  assert.equal(generateSessionTitle('Đóng vai Chuyên gia. Review code'), 'Chuyên gia. Review code');
});

test('formatRelativeTime returns accurate human-readable strings', () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 10000, now), 'Vừa xong');
  assert.equal(formatRelativeTime(now - 120000, now), '2 phút trước');
  assert.equal(formatRelativeTime(now - 1800000, now), '30 phút trước');
});

test('groupSessionsByDate groups sessions properly into buckets', () => {
  const now = new Date('2026-11-14T10:00:00Z').getTime();
  const sessions = [
    { id: '1', title: 'Hôm nay', updatedAt: now - 3600000 },
    { id: '2', title: 'Hôm qua', updatedAt: now - 86400000 },
    { id: '3', title: '3 ngày trước', updatedAt: now - 3 * 86400000 },
    { id: '4', title: '40 ngày trước', updatedAt: now - 40 * 86400000 },
  ];

  const grouped = groupSessionsByDate(sessions, now);
  assert.ok(grouped.length >= 3);
  assert.equal(grouped[0].category, 'today');
  assert.equal(grouped[0].sessions[0].id, '1');
});

test('exportSessionAsMarkdown formats conversation with markdown blocks', () => {
  const session = {
    title: 'Phân tích hiệu năng',
    workspaceName: 'my-project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { id: '1', role: 'user', text: 'Làm sao tối ưu database?' },
      { id: '2', role: 'assistant', text: 'Bạn nên đánh chỉ mục (index).' }
    ]
  };

  const md = exportSessionAsMarkdown(session);
  assert.ok(md.includes('# 💬 Phân tích hiệu năng'));
  assert.ok(md.includes('👤 BẠN'));
  assert.ok(md.includes('✨ GEMINI WEB'));
  assert.ok(md.includes('Làm sao tối ưu database?'));
});
