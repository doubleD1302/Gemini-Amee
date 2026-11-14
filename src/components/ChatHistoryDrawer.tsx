import { useMemo, useState, useRef, useEffect, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  Clock,
  Download,
  Edit3,
  FileDown,
  Folder,
  History,
  Layers3,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import type { ChatSession } from '../types';
import {
  exportSessionAsMarkdown,
  exportSessionsAsJSON,
  formatRelativeTime,
  groupSessionsByDate,
  downloadTextFile
} from '../utils/historyStorage';

interface ChatHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  currentWorkspaceRoot?: string;
  currentWorkspaceName?: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onDeleteSession: (id: string) => void;
  onClearAllSessions: () => void;
  onImportSessions: (imported: ChatSession[]) => void;
  onToast: (message: string) => void;
}

export function ChatHistoryDrawer({
  isOpen,
  onClose,
  sessions,
  activeSessionId,
  currentWorkspaceRoot,
  currentWorkspaceName,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onDeleteSession,
  onClearAllSessions,
  onImportSessions,
  onToast
}: ChatHistoryDrawerProps) {
  const [search, setSearch] = useState('');
  const [filterScope, setFilterScope] = useState<'current' | 'all'>('current');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState('');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when drawer opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 150);
    } else {
      setEditingSessionId(null);
      setConfirmClearOpen(false);
      setSessionToDelete(null);
    }
  }, [isOpen]);

  // Focus edit input when starting to rename
  useEffect(() => {
    if (editingSessionId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingSessionId]);

  // Handle escape key to close drawer or cancel edit
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        if (editingSessionId) {
          setEditingSessionId(null);
        } else if (confirmClearOpen) {
          setConfirmClearOpen(false);
        } else if (sessionToDelete) {
          setSessionToDelete(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, editingSessionId, confirmClearOpen, sessionToDelete, onClose]);

  // Filtered sessions
  const filteredSessions = useMemo(() => {
    let list = sessions;

    // Filter by workspace if selected and available
    if (filterScope === 'current' && currentWorkspaceRoot) {
      list = list.filter(s => s.workspaceRoot === currentWorkspaceRoot);
    }

    // Filter by search query
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(s => {
        if (s.title.toLowerCase().includes(q)) return true;
        if (s.workspaceName && s.workspaceName.toLowerCase().includes(q)) return true;
        // Search inside messages text
        return s.messages.some(m => m.text.toLowerCase().includes(q));
      });
    }

    return list;
  }, [sessions, filterScope, currentWorkspaceRoot, search]);

  // Grouped by date
  const groupedList = useMemo(() => {
    return groupSessionsByDate(filteredSessions);
  }, [filteredSessions]);

  const currentWorkspaceCount = useMemo(() => {
    if (!currentWorkspaceRoot) return 0;
    return sessions.filter(s => s.workspaceRoot === currentWorkspaceRoot).length;
  }, [sessions, currentWorkspaceRoot]);

  // Actions
  const handleStartRename = (e: MouseEvent, session: ChatSession) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditingTitleDraft(session.title);
  };

  const handleSaveRename = (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!editingSessionId) return;
    const trimmed = editingTitleDraft.trim();
    if (trimmed) {
      onRenameSession(editingSessionId, trimmed);
      onToast('Đã đổi tên cuộc trò chuyện');
    }
    setEditingSessionId(null);
  };

  const handleExportMarkdown = (e: MouseEvent, session: ChatSession) => {
    e.stopPropagation();
    const md = exportSessionAsMarkdown(session);
    const safeTitle = session.title.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 30);
    const dateStr = new Date(session.createdAt).toISOString().slice(0, 10);
    downloadTextFile(`chat_${safeTitle}_${dateStr}.md`, md, 'text/markdown');
    onToast(`Đã xuất cuộc trò chuyện "${session.title}" ra file .md`);
  };

  const handleExportAllJSON = () => {
    const json = exportSessionsAsJSON(sessions);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadTextFile(`gemini_studio_history_backup_${dateStr}.json`, json, 'application/json');
    onToast(`Đã xuất ${sessions.length} cuộc trò chuyện thành file JSON`);
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const text = ev.target?.result as string;
        const parsed = JSON.parse(text);
        const importedSessions: ChatSession[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.sessions)
          ? parsed.sessions
          : [];

        if (importedSessions.length === 0) {
          onToast('File JSON không chứa lịch sử cuộc trò chuyện hợp lệ');
          return;
        }

        onImportSessions(importedSessions);
        onToast(`Đã nhập thành công ${importedSessions.length} cuộc trò chuyện!`);
      } catch (err) {
        onToast('Lỗi đọc file JSON: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsText(file);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (!isOpen) return null;

  return (
    <div className="history-backdrop" onClick={onClose} role="presentation">
      <div
        className="history-drawer"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Lịch sử trò chuyện"
      >
        {/* Drawer Header */}
        <div className="history-drawer-header">
          <div className="history-header-title">
            <div className="history-header-icon">
              <History size={17} />
            </div>
            <div>
              <h3>Lịch sử trò chuyện</h3>
              <span className="history-subtitle">
                {sessions.length} phiên đã lưu · Tự động đồng bộ
              </span>
            </div>
          </div>

          <div className="history-header-actions">
            <button
              className="new-chat-action-btn"
              onClick={() => {
                onNewChat();
                onClose();
              }}
              title="Bắt đầu cuộc trò chuyện mới (+)"
            >
              <Plus size={14} />
              <span>Trò chuyện mới</span>
            </button>
            <button className="history-close-btn" onClick={onClose} title="Đóng lịch sử (Esc)" aria-label="Đóng">
              <X size={17} />
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="history-search-bar">
          <Search size={14} />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm theo tiêu đề hoặc nội dung tin nhắn..."
            aria-label="Tìm kiếm lịch sử"
          />
          {search && (
            <button className="history-search-clear" onClick={() => setSearch('')} title="Xóa tìm kiếm">
              <X size={12} />
            </button>
          )}
        </div>

        {/* Filter Scope Tabs */}
        {currentWorkspaceRoot && (
          <div className="history-scope-tabs">
            <button
              className={`scope-tab ${filterScope === 'current' ? 'active' : ''}`}
              onClick={() => setFilterScope('current')}
              title={`Chỉ hiển thị các cuộc trò chuyện của dự án ${currentWorkspaceName || ''}`}
            >
              <Folder size={12} />
              <span>Dự án này ({currentWorkspaceCount})</span>
            </button>
            <button
              className={`scope-tab ${filterScope === 'all' ? 'active' : ''}`}
              onClick={() => setFilterScope('all')}
              title="Xem tất cả cuộc trò chuyện từ mọi dự án"
            >
              <Layers3 size={12} />
              <span>Tất cả ({sessions.length})</span>
            </button>
          </div>
        )}

        {/* Sessions List */}
        <div className="history-sessions-container">
          {filteredSessions.length === 0 ? (
            <div className="history-empty-state">
              <div className="empty-icon-wrap">
                <MessageSquare size={32} />
              </div>
              <h4>{search ? 'Không tìm thấy kết quả' : 'Chưa có lịch sử trò chuyện'}</h4>
              <p>
                {search
                  ? `Không có cuộc trò chuyện nào khớp với từ khóa "${search}".`
                  : filterScope === 'current' && currentWorkspaceRoot
                  ? `Dự án "${currentWorkspaceName}" chưa có cuộc trò chuyện nào.`
                  : 'Bắt đầu gửi câu hỏi cho Gemini để lưu lại lịch sử giải đáp mã nguồn.'}
              </p>
              <button
                className="primary-button compact"
                onClick={() => {
                  onNewChat();
                  onClose();
                }}
              >
                <Plus size={14} /> Bắt đầu cuộc trò chuyện mới
              </button>
            </div>
          ) : (
            groupedList.map(group => (
              <div key={group.category} className="history-date-group">
                <div className="history-group-header">
                  <Calendar size={12} />
                  <span>{group.label}</span>
                  <span className="history-group-count">{group.sessions.length}</span>
                </div>

                <div className="history-group-items">
                  {group.sessions.map(session => {
                    const isActive = session.id === activeSessionId;
                    const isEditing = session.id === editingSessionId;
                    const lastMessage = session.messages[session.messages.length - 1];
                    const firstUserMsg = session.messages.find(m => m.role === 'user');
                    const previewText = lastMessage
                      ? (lastMessage.role === 'assistant' ? 'Gemini: ' : 'Bạn: ') + lastMessage.text
                      : firstUserMsg
                      ? firstUserMsg.text
                      : 'Chưa có tin nhắn nào';

                    return (
                      <div
                        key={session.id}
                        className={`history-item-card ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          if (isEditing) return;
                          onSelectSession(session.id);
                          onClose();
                        }}
                        title={isActive ? 'Cuộc trò chuyện đang mở' : 'Bấm để mở cuộc trò chuyện này'}
                      >
                        {/* Active Indicator Bar */}
                        {isActive && <div className="history-active-indicator" />}

                        <div className="history-item-content">
                          {isEditing ? (
                            <form
                              className="history-rename-form"
                              onSubmit={handleSaveRename}
                              onClick={e => e.stopPropagation()}
                            >
                              <input
                                ref={editInputRef}
                                type="text"
                                value={editingTitleDraft}
                                onChange={e => setEditingTitleDraft(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Escape') setEditingSessionId(null);
                                }}
                              />
                              <div className="rename-actions">
                                <button type="submit" className="rename-save-btn" title="Lưu tiêu đề">
                                  <Check size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="rename-cancel-btn"
                                  onClick={() => setEditingSessionId(null)}
                                  title="Hủy"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <div className="history-item-top">
                                <strong className="history-item-title">
                                  {session.title}
                                </strong>
                              </div>

                              <p className="history-item-preview">
                                {previewText}
                              </p>

                              <div className="history-item-meta">
                                <span className="meta-time">
                                  <Clock size={11} />
                                  {formatRelativeTime(session.updatedAt || session.createdAt)}
                                </span>
                                <span className="meta-badge">
                                  <MessageSquare size={11} />
                                  {session.messages.length} tin nhắn
                                </span>
                                {session.workspaceName && (filterScope === 'all' || !currentWorkspaceRoot) && (
                                  <span className="meta-workspace" title={`Thư mục: ${session.workspaceRoot}`}>
                                    <Folder size={11} />
                                    {session.workspaceName}
                                  </span>
                                )}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Hover Actions */}
                        {!isEditing && (
                          <div className="history-item-actions" onClick={e => e.stopPropagation()}>
                            <button
                              className="item-action-btn"
                              onClick={e => handleStartRename(e, session)}
                              title="Đổi tên cuộc trò chuyện"
                            >
                              <Edit3 size={13} />
                            </button>
                            <button
                              className="item-action-btn"
                              onClick={e => handleExportMarkdown(e, session)}
                              title="Xuất file Markdown (.md)"
                            >
                              <FileDown size={13} />
                            </button>
                            <button
                              className="item-action-btn delete"
                              onClick={e => {
                                e.stopPropagation();
                                setSessionToDelete(session);
                              }}
                              title="Xóa cuộc trò chuyện này"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Drawer Footer Toolbar */}
        <div className="history-drawer-footer">
          <div className="footer-left">
            <button
              className="footer-btn"
              onClick={handleExportAllJSON}
              disabled={sessions.length === 0}
              title="Xuất toàn bộ lịch sử thành file JSON để lưu trữ"
            >
              <Download size={13} />
              <span>Xuất sao lưu</span>
            </button>
            <button
              className="footer-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Nhập lịch sử từ file JSON"
            >
              <Upload size={13} />
              <span>Nhập sao lưu</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>

          <div className="footer-right">
            {sessions.length > 0 && (
              <button
                className="footer-btn danger"
                onClick={() => setConfirmClearOpen(true)}
                title="Xóa toàn bộ lịch sử trò chuyện"
              >
                <Trash2 size={13} />
                <span>Xóa tất cả</span>
              </button>
            )}
          </div>
        </div>

        {/* Confirmation Modal for Deleting Single Session */}
        {sessionToDelete && (
          <div className="history-confirm-overlay" onClick={() => setSessionToDelete(null)}>
            <div className="history-confirm-dialog" onClick={e => e.stopPropagation()}>
              <div className="confirm-icon warning">
                <Trash2 size={20} />
              </div>
              <h4>Xóa cuộc trò chuyện?</h4>
              <p>
                Bạn có chắc chắn muốn xóa cuộc trò chuyện <strong>"{sessionToDelete.title}"</strong> ({sessionToDelete.messages.length} tin nhắn)? Hành động này không thể hoàn tác.
              </p>
              <div className="confirm-buttons">
                <button className="outline-button compact" onClick={() => setSessionToDelete(null)}>
                  Hủy bỏ
                </button>
                <button
                  className="danger-button compact"
                  onClick={() => {
                    onDeleteSession(sessionToDelete.id);
                    onToast(`Đã xóa cuộc trò chuyện "${sessionToDelete.title}"`);
                    setSessionToDelete(null);
                  }}
                >
                  Xác nhận xóa
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Confirmation Modal for Clearing All Sessions */}
        {confirmClearOpen && (
          <div className="history-confirm-overlay" onClick={() => setConfirmClearOpen(false)}>
            <div className="history-confirm-dialog" onClick={e => e.stopPropagation()}>
              <div className="confirm-icon danger">
                <AlertCircle size={20} />
              </div>
              <h4>Xóa toàn bộ lịch sử?</h4>
              <p>
                Toàn bộ <strong>{sessions.length} cuộc trò chuyện</strong> đã lưu sẽ bị xóa vĩnh viễn khỏi máy tính. Bạn nên bấm "Xuất sao lưu" trước khi xóa.
              </p>
              <div className="confirm-buttons">
                <button className="outline-button compact" onClick={() => setConfirmClearOpen(false)}>
                  Hủy bỏ
                </button>
                <button
                  className="danger-button compact"
                  onClick={() => {
                    onClearAllSessions();
                    onToast('Đã xóa sạch toàn bộ lịch sử trò chuyện');
                    setConfirmClearOpen(false);
                  }}
                >
                  Xóa tất cả
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
