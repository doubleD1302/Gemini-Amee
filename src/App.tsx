import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ErrorInfo, FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import {
  Activity, ArrowRight, ArrowUp, BookOpen, BookOpenText, Brain, BrainCircuit,
  Check, CheckCircle2, ChevronDown, ChevronRight, ClipboardCopy, Clock,
  Code2, Copy, Cpu, Edit3, ExternalLink, FileCode2, FileJson2, FileText, Folder,
  FolderOpen, Globe2, HelpCircle, History, KeyRound, Layers3,
  Lightbulb, LoaderCircle, LockKeyhole, MessageSquare, PanelRight, PlugZap, Plus, Save, Search,
  Send, ShieldAlert, ShieldCheck, Sparkles, TerminalSquare, Undo, WandSparkles, Wrench, X, Zap
} from 'lucide-react';
import type { BridgeConnection, ChatMessage, ChatSession, Job, Prepared, ProjectFile, SearchMatch, WorkspaceInfo } from './types';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { OnboardingModal, type ModelOption, type ModeOption, type TabType } from './components/OnboardingModal';
import { ChatHistoryDrawer } from './components/ChatHistoryDrawer';
import { AgentSessions } from './components/AgentSessions';
import {
  loadChatSessions,
  saveChatSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  createNewSession,
  generateSessionTitle,
  formatRelativeTime
} from './utils/historyStorage';

type Message = ChatMessage;
type InspectorTab = 'preview' | 'bridge' | 'agent';
type FileFilter = 'all' | 'code' | 'docs' | 'config';

function shortBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function statusText(status?: Message['status']) {
  switch (status) {
    case 'queued': return 'Đang xếp hàng gửi';
    case 'dispatched': return 'Đang gửi sang Gemini Web';
    case 'sent': return 'Gemini đang chuẩn bị trả lời…';
    case 'streaming': return 'Gemini đang viết câu trả lời…';
    case 'error': return 'Không gửi được';
    case 'manual': return 'Chờ dán câu trả lời thủ công';
    default: return 'Đã nhận phản hồi';
  }
}

function fileIcon(file: ProjectFile) {
  if (/\.json$/i.test(file.name)) return <FileJson2 size={15} />;
  if (/\.(md|txt|markdown)$/i.test(file.name)) return <FileText size={15} />;
  return <FileCode2 size={15} />;
}

function normalizedError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('App error', error, info.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <BrainCircuit size={40} />
          <h1>Không thể hiển thị ứng dụng</h1>
          <p>{this.state.error}</p>
          <button onClick={() => window.location.reload()}>Tải lại giao diện</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MainApp() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [connection, setConnection] = useState<BridgeConnection>({ url: 'Đang khởi tạo…', connected: false });
  const [activeFile, setActiveFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [question, setQuestion] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [isEditingHeaderTitle, setIsEditingHeaderTitle] = useState(false);
  const [headerTitleDraft, setHeaderTitleDraft] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('preview');
  const [fileFilter, setFileFilter] = useState<FileFilter>('all');
  const [previewMode, setPreviewMode] = useState<'code' | 'preview' | 'edit'>('code');
  const [editorContent, setEditorContent] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualReply, setManualReply] = useState('');
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingTab, setOnboardingTab] = useState<TabType>('quickstart');
  const [selectedModel, setSelectedModel] = useState<ModelOption>('gemini-pro');
  const [analysisMode, setAnalysisMode] = useState<ModeOption>('general');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const headerTitleInputRef = useRef<HTMLInputElement>(null);

  // Active session and messages derivation
  const activeSession = useMemo(() => {
    if (!activeSessionId) return sessions[0] || null;
    return sessions.find(s => s.id === activeSessionId) || sessions[0] || null;
  }, [sessions, activeSessionId]);

  const messages = useMemo(() => {
    return activeSession?.messages || [];
  }, [activeSession]);

  const recentSessions = useMemo(() => {
    return sessions
      .filter(s => s.messages.length > 0 && s.id !== activeSession?.id)
      .slice(0, 4);
  }, [sessions, activeSession]);

  const inform = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 3400);
  }, []);

  const updateActiveSessionMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setSessions(prevSessions => {
      let currentId = activeSessionId;
      let next = [...prevSessions];
      let idx = next.findIndex(s => s.id === currentId);

      if (idx === -1) {
        const newSess = createNewSession(workspace?.root, workspace?.name, selectedModel, analysisMode);
        next.unshift(newSess);
        idx = 0;
        currentId = newSess.id;
        setActiveSessionId(newSess.id);
        saveActiveSessionId(newSess.id);
      }

      const target = next[idx];
      const updatedMessages = updater(target.messages);

      let title = target.title;
      if ((title === 'Cuộc trò chuyện mới' || !title) && updatedMessages.length > 0) {
        const firstUser = updatedMessages.find(m => m.role === 'user');
        if (firstUser) {
          title = generateSessionTitle(firstUser.text);
        }
      }

      next[idx] = {
        ...target,
        title,
        messages: updatedMessages,
        updatedAt: Date.now(),
        workspaceRoot: workspace?.root || target.workspaceRoot,
        workspaceName: workspace?.name || target.workspaceName
      };

      saveChatSessions(next);
      return next;
    });
  }, [activeSessionId, workspace, selectedModel, analysisMode]);

  // Close popover menus when clicking outside
  useEffect(() => {
    const handleWindowClick = () => {
      setShowModelMenu(false);
      setShowModeMenu(false);
    };
    if (showModelMenu || showModeMenu) {
      window.addEventListener('click', handleWindowClick);
      return () => window.removeEventListener('click', handleWindowClick);
    }
  }, [showModelMenu, showModeMenu]);

  // Load saved chat sessions from storage on startup
  useEffect(() => {
    const loaded = loadChatSessions();
    const savedActiveId = loadActiveSessionId();
    if (loaded.length > 0) {
      setSessions(loaded);
      const found = savedActiveId && loaded.some(s => s.id === savedActiveId);
      if (found) {
        setActiveSessionId(savedActiveId);
      } else {
        setActiveSessionId(loaded[0].id);
        saveActiveSessionId(loaded[0].id);
      }
    } else {
      const initialSess = createNewSession();
      setSessions([initialSess]);
      setActiveSessionId(initialSess.id);
      saveActiveSessionId(initialSess.id);
      saveChatSessions([initialSess]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    window.studio.init().then(data => {
      if (active) {
        setWorkspace(data.workspace);
        setConnection(data.connection);
        // Show onboarding if no workspace open
        if (!data.workspace) {
          const hasSeen = localStorage.getItem('gps_seen_onboarding');
          if (!hasSeen) {
            setOnboardingOpen(true);
            localStorage.setItem('gps_seen_onboarding', 'true');
          }
        }
      }
    }).catch(err => setError(normalizedError(err)));

    const offJob = window.studio.onJob((job: Job) => {
      setSessions(prevSessions => {
        let matched = false;
        const nextSessions = prevSessions.map(session => {
          const hasJob = session.messages.some(m => m.jobId === job.id);
          if (!hasJob) return session;

          matched = true;
          const updatedMessages = session.messages.map(m => {
            if (m.jobId === job.id) {
              return {
                ...m,
                status: job.status,
                text: (job.status === 'final' || job.status === 'streaming' || job.status === 'error')
                  ? (job.answer || statusText(job.status))
                  : m.text
              };
            }
            return m;
          });

          return {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now()
          };
        });

        if (matched) {
          saveChatSessions(nextSessions);
          return nextSessions;
        }
        return prevSessions;
      });
    });

    const offConn = window.studio.onConnection(setConnection);
    const interval = window.setInterval(() => window.studio.connection().then(setConnection).catch(() => {}), 3000);
    return () => { active = false; offJob(); offConn(); window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    if (!workspace || !search.trim()) { setSearchResults([]); return; }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      window.studio.search(search).then(items => { if (!cancelled) setSearchResults(items); }).catch(err => setError(normalizedError(err)));
    }, 260);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [search, workspace]);

  const files = useMemo(() => workspace?.files ?? [], [workspace]);

  const filteredFiles = useMemo(() => {
    if (fileFilter === 'all') return files;
    if (fileFilter === 'docs') return files.filter(f => /\.(md|txt|markdown)$/i.test(f.name));
    if (fileFilter === 'config') return files.filter(f => /\.(json|yaml|yml|toml|config\.[a-z]+)$/i.test(f.name));
    return files.filter(f => !/\.(md|txt|markdown|json|yaml|yml|toml)$/i.test(f.name));
  }, [files, fileFilter]);

  const displayFiles = useMemo(() => {
    if (search.trim()) {
      const names = new Set(searchResults.map(x => x.path));
      return filteredFiles.filter(f => names.has(f.path) || f.path.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100);
    }
    return filteredFiles.filter(f => {
      const parts = f.path.split('/');
      return parts.slice(0, -1).every((_, i) => expandedDirs.has(parts.slice(0, i + 1).join('/')));
    });
  }, [filteredFiles, search, searchResults, expandedDirs]);

  const visibleFolders = useMemo(() => {
    const dirs = new Set<string>();
    filteredFiles.forEach(f => f.path.split('/').slice(0, -1).forEach((_, i) => dirs.add(f.path.split('/').slice(0, i + 1).join('/'))));
    return [...dirs].sort();
  }, [filteredFiles]);

  const listRows = useMemo(() => {
    if (search.trim()) return displayFiles.map(f => ({ type: 'file' as const, path: f.path, file: f }));
    const rows: Array<{ type: 'folder' | 'file'; path: string; file?: ProjectFile }> = [];
    visibleFolders.forEach(path => {
      const parent = path.split('/').slice(0, -1);
      if (parent.every((_, i) => expandedDirs.has(parent.slice(0, i + 1).join('/')))) rows.push({ type: 'folder', path });
    });
    displayFiles.forEach(f => rows.push({ type: 'file', path: f.path, file: f }));
    return rows.sort((a, b) => {
      const aParts = a.path.split('/'); const bParts = b.path.split('/');
      const min = Math.min(aParts.length, bParts.length);
      for (let i = 0; i < min; i++) {
        if (aParts[i] !== bParts[i]) return aParts[i].localeCompare(bParts[i]);
      }
      return aParts.length - bParts.length;
    });
  }, [search, displayFiles, visibleFolders, expandedDirs]);

  const projectStats = `${files.length} file${files.length !== 1 ? 's' : ''}`;

  const chooseWorkspace = useCallback(async () => {
    try {
      const result = await window.studio.chooseFolder();
      if (!result) return;
      setWorkspace(result);
      setActiveFile('');
      setFileContent('');
      setSearch('');
      setSearchResults([]);
      setPrepared(null);

      // Check if there is an existing session for this workspace
      const matchingSession = sessions.find(s => s.workspaceRoot === result.root);
      if (matchingSession) {
        setActiveSessionId(matchingSession.id);
        saveActiveSessionId(matchingSession.id);
      } else if (activeSession && activeSession.messages.length === 0) {
        // Tag current empty session with this workspace
        setSessions(prev => {
          const next = prev.map(s => s.id === activeSession.id ? {
            ...s,
            workspaceRoot: result.root,
            workspaceName: result.name
          } : s);
          saveChatSessions(next);
          return next;
        });
      } else {
        // Create a new session for this workspace
        const newSess = createNewSession(result.root, result.name, selectedModel, analysisMode);
        setSessions(prev => {
          const next = [newSess, ...prev];
          saveChatSessions(next);
          return next;
        });
        setActiveSessionId(newSess.id);
        saveActiveSessionId(newSess.id);
      }

      const folders = new Set<string>();
      result.files.forEach(f => {
        const first = f.path.split('/');
        if (first.length > 1) folders.add(first[0]);
      });
      setExpandedDirs(folders);
      inform(`Đã mở dự án: ${result.name}`);
    } catch (err) {
      setError(normalizedError(err));
    }
  }, [sessions, activeSession, selectedModel, analysisMode, inform]);

  const selectFile = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    const p = event.currentTarget.dataset.path;
    if (!p) return;
    try {
      const f = await window.studio.readFile(p);
      setActiveFile(p);
      setFileContent(f.content);
      setEditorContent(f.content);
      setInspectorTab('preview');
      setPreviewMode(/\.(md|markdown|txt)$/i.test(p) ? 'preview' : 'code');
    } catch (err) {
      setError(normalizedError(err));
    }
  }, []);

  const toggleDir = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const dir = event.currentTarget.dataset.path;
    if (!dir) return;
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  const getPromptWithMode = useCallback((rawQuestion: string, mode: ModeOption) => {
    switch (mode) {
      case 'vibe-code':
        return `[Chế độ: Vibe Coding - Chỉnh sửa trực tiếp file dự án]
Bạn là một AI Vibe Coding siêu hạng. Nhiệm vụ của bạn là trực tiếp viết và cập nhật mã nguồn theo yêu cầu:
1. Xuất code hoàn chỉnh, sẵn sàng chạy ngay, không viết code tóm tắt hay bỏ lửng.
2. BẮT BUỘC ghi rõ đường dẫn file ở dòng đầu tiên của mỗi code block theo định dạng chuẩn:
   // FILE: duong_dan/file.ext
   (hoặc # FILE: duong_dan/file.ext đối với python/sh)
   Ví dụ:
   \`\`\`swift
   // FILE: PharmaTaskWidgets/PharmaTaskLockScreenWidget.swift
   import WidgetKit
   ...
   \`\`\`
3. Giải thích ngắn gọn, súc tích, ưu tiên tính sẵn sàng và tính chính xác của code.\n\n${rawQuestion}`;
      case 'bug-audit':
        return `[Chế độ: Rà soát Bug & Bảo mật] Đóng vai Chuyên gia An ninh & Rà soát Lỗi cấp cao. Hãy kiểm tra kỹ lưỡng các lỗi tiềm ẩn, vấn đề bảo mật, memory leak và các điểm nghẽn hiệu năng:\n\n${rawQuestion}`;
      case 'refactor':
        return `[Chế độ: Tối ưu & Tái cấu trúc] Đóng vai Kỹ sư Kiến trúc Mã nguồn cấp cao. Hãy phân tích và đề xuất phương án refactor, clean code và tối ưu hóa hiệu năng:\n\n${rawQuestion}`;
      case 'docs':
        return `[Chế độ: Soạn thảo Tài liệu] Đóng vai Technical Writer chuyên nghiệp. Hãy soạn thảo hướng dẫn sử dụng và giải thích kỹ thuật chi tiết, dễ hiểu từng bước:\n\n${rawQuestion}`;
      default:
        return rawQuestion;
    }
  }, []);

  const handleFileWritten = useCallback(async (filePath: string) => {
    inform(`Đã cập nhật ${filePath}`);
    if (activeFile === filePath) {
      try {
        const res = await window.studio.readFile(filePath);
        setFileContent(res.content);
        setEditorContent(res.content);
      } catch {}
    }
    try {
      const updated = await window.studio.init();
      if (updated.workspace) setWorkspace(updated.workspace);
    } catch {}
  }, [activeFile, inform]);

  // Listen to background file write events from Bridge/Extension
  useEffect(() => {
    if (!window.studio?.onFileWritten) return;
    const unsub = window.studio.onFileWritten(({ path: writtenPath }) => {
      void handleFileWritten(writtenPath);
    });
    return unsub;
  }, [handleFileWritten]);

  const hasUnsavedChanges = useMemo(() => {
    return activeFile ? editorContent !== fileContent : false;
  }, [activeFile, editorContent, fileContent]);

  const handleSaveActiveFile = useCallback(async () => {
    if (!activeFile || !window.studio?.writeFile || isSavingFile) return;
    try {
      setIsSavingFile(true);
      await window.studio.writeFile(activeFile, editorContent);
      setFileContent(editorContent);
      inform(`⚡ Vibe Coding: Đã lưu trực tiếp vào ${activeFile}!`);
      try {
        const updated = await window.studio.init();
        if (updated.workspace) setWorkspace(updated.workspace);
      } catch {}
    } catch (err: any) {
      setError('Lỗi khi lưu file: ' + (err.message || String(err)));
    } finally {
      setIsSavingFile(false);
    }
  }, [activeFile, editorContent, isSavingFile, inform]);

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleSaveActiveFile();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const newVal = val.substring(0, start) + '  ' + val.substring(end);
      setEditorContent(newVal);
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  };

  const sendMessage = useCallback(async (customPrompt?: string) => {
    const rawText = (customPrompt || question).trim();
    if (!rawText || !workspace || busy) return;
    const text = getPromptWithMode(rawText, analysisMode);
    setBusy(true);
    setError('');
    const uid = `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      const isFollowUp = messages.length > 0;
      const context = await window.studio.prepare(text, activeFile, isFollowUp);
      setPrepared(context);
      const userMessage: Message = { id: uid, role: 'user', text: rawText, timestamp: Date.now() };

      if (connection.connected) {
        const job = await window.studio.send(text, activeFile, isFollowUp);
        updateActiveSessionMessages(prev => [
          ...prev,
          userMessage,
          {
            id: `a-${job.id}`,
            role: 'assistant',
            jobId: job.id,
            status: 'queued',
            text: isFollowUp ? 'Đang gửi câu hỏi sang Gemini Web…' : 'Đang chuyển ngữ cảnh dự án sang Gemini Web…',
            included: job.included,
            preparedPrompt: context.prompt,
            timestamp: Date.now()
          }
        ]);
      } else {
        // Automatically copy to clipboard for non-tech users when offline
        await window.studio.copy(context.prompt);
        updateActiveSessionMessages(prev => [
          ...prev,
          userMessage,
          {
            id: `a-${uid}`,
            role: 'assistant',
            status: 'manual',
            text: `Extension chưa kết nối. Studio đã **tự động sao chép prompt kèm ngữ cảnh** của ${context.included.length} file vào bộ nhớ tạm!\n\n👉 Bạn chỉ cần:\n1. Mở tab **gemini.google.com**\n2. Bấm **Ctrl+V** để dán và hỏi\n3. Copy câu trả lời từ Gemini rồi bấm **"Dán câu trả lời thủ công"** ở bên dưới.`,
            included: context.included,
            preparedPrompt: context.prompt,
            timestamp: Date.now()
          }
        ]);
        inform('Đã copy prompt kèm code dự án vào clipboard!');
      }
      setQuestion('');
    } catch (err) {
      setError(normalizedError(err));
    } finally {
      setBusy(false);
    }
  }, [question, workspace, busy, activeFile, analysisMode, getPromptWithMode, connection.connected, updateActiveSessionMessages, inform, messages.length]);

  const handleComposerKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }, [sendMessage]);

  const copyPrepared = useCallback(async (promptText?: string) => {
    const p = promptText || prepared?.prompt;
    if (!p) {
      inform('Hãy nhập câu hỏi để tạo context trước');
      return;
    }
    await window.studio.copy(p);
    inform('Đã copy prompt kèm code dự án vào bộ nhớ tạm');
  }, [prepared, inform]);

  const prepareDraft = useCallback(async () => {
    const raw = question.trim();
    if (!raw || !workspace || busy) return;
    try {
      setBusy(true);
      const text = getPromptWithMode(raw, analysisMode);
      const isFollowUp = messages.length > 0;
      const result = await window.studio.prepare(text, activeFile, isFollowUp);
      setPrepared(result);
      await window.studio.copy(result.prompt);
      inform(isFollowUp
        ? 'Đã tạo và sao chép câu hỏi tiếp theo vào clipboard!'
        : `Đã tạo và sao chép context từ ${result.included.length} file vào clipboard!`);
    } catch (err) {
      setError(normalizedError(err));
    } finally {
      setBusy(false);
    }
  }, [question, workspace, busy, activeFile, analysisMode, getPromptWithMode, inform, messages.length]);

  const copyPairInfo = useCallback(async () => {
    try {
      await window.studio.copy(await window.studio.pairInfo());
      inform('Đã copy mã kết nối (Pairing JSON)! Hãy dán vào extension.');
    } catch (err) {
      setError(normalizedError(err));
    }
  }, [inform]);

  const copyFile = useCallback(async () => {
    await window.studio.copy(fileContent);
    inform('Đã copy nội dung file');
  }, [fileContent, inform]);

  const showExtension = useCallback(async () => {
    try {
      const folder = await window.studio.showExtension();
      inform(`Thư mục extension: ${folder}`);
    } catch (err) {
      setError(normalizedError(err));
    }
  }, [inform]);

  const importManual = useCallback(async () => {
    if (!manualReply.trim()) return;
    const last = [...messages].reverse().find(m => m.role === 'assistant' && m.status !== 'final');
    if (!last) {
      inform('Không có lượt câu hỏi nào đang chờ phản hồi');
      return;
    }
    try {
      if (last.jobId) await window.studio.importReply(last.jobId, manualReply);
      updateActiveSessionMessages(prev => prev.map(m => m.id === last.id ? { ...m, status: 'final', text: manualReply.trim() } : m));
      setManualReply('');
      setManualOpen(false);
      inform('Đã lưu và hiển thị câu trả lời từ Gemini!');
    } catch (err) {
      setError(normalizedError(err));
    }
  }, [manualReply, messages, updateActiveSessionMessages, inform]);

  const handleNewChat = useCallback(() => {
    if (activeSession && activeSession.messages.length === 0) {
      inform('Đang ở trong cuộc trò chuyện mới');
      textAreaRef.current?.focus();
      return;
    }

    const newSession = createNewSession(
      workspace?.root,
      workspace?.name,
      selectedModel,
      analysisMode
    );

    setSessions(prev => {
      const next = [newSession, ...prev];
      saveChatSessions(next);
      return next;
    });
    setActiveSessionId(newSession.id);
    saveActiveSessionId(newSession.id);
    setPrepared(null);
    inform('Đã tạo cuộc trò chuyện mới');
    setTimeout(() => textAreaRef.current?.focus(), 100);
  }, [activeSession, workspace, selectedModel, analysisMode, inform]);

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    saveActiveSessionId(id);
    setPrepared(null);
    const selected = sessions.find(s => s.id === id);
    if (selected) {
      inform(`Đã mở: ${selected.title}`);
    }
  }, [sessions, inform]);

  const handleRenameSession = useCallback((id: string, newTitle: string) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s);
      saveChatSessions(next);
      return next;
    });
  }, []);

  const handleDeleteSession = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      saveChatSessions(next);

      if (activeSessionId === id) {
        if (next.length > 0) {
          setActiveSessionId(next[0].id);
          saveActiveSessionId(next[0].id);
        } else {
          const fresh = createNewSession(workspace?.root, workspace?.name, selectedModel, analysisMode);
          saveChatSessions([fresh]);
          setActiveSessionId(fresh.id);
          saveActiveSessionId(fresh.id);
          return [fresh];
        }
      }
      return next;
    });
  }, [activeSessionId, workspace, selectedModel, analysisMode]);

  const handleClearAllSessions = useCallback(() => {
    const fresh = createNewSession(workspace?.root, workspace?.name, selectedModel, analysisMode);
    setSessions([fresh]);
    setActiveSessionId(fresh.id);
    saveActiveSessionId(fresh.id);
    saveChatSessions([fresh]);
  }, [workspace, selectedModel, analysisMode]);

  const handleImportSessions = useCallback((imported: ChatSession[]) => {
    setSessions(prev => {
      const existingIds = new Set(prev.map(s => s.id));
      const newItems = imported.filter(s => !existingIds.has(s.id));
      const merged = [...newItems, ...prev].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      saveChatSessions(merged);
      if (newItems.length > 0) {
        setActiveSessionId(newItems[0].id);
        saveActiveSessionId(newItems[0].id);
      }
      return merged;
    });
  }, []);

  const handleHeaderTitleSubmit = useCallback((e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!activeSession) return;
    const trimmed = headerTitleDraft.trim();
    if (trimmed && trimmed !== activeSession.title) {
      handleRenameSession(activeSession.id, trimmed);
      inform('Đã đổi tên cuộc trò chuyện');
    }
    setIsEditingHeaderTitle(false);
  }, [activeSession, headerTitleDraft, handleRenameSession, inform]);

  // Global Keyboard shortcuts: Ctrl+H (History), Ctrl+N (New Chat)
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setHistoryDrawerOpen(prev => !prev);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNewChat]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await window.studio.readClipboard();
      if (text && text.trim()) {
        setManualReply(text.trim());
        inform('Đã dán nội dung từ bộ nhớ tạm');
      } else {
        inform('Bộ nhớ tạm đang trống');
      }
    } catch {
      inform('Không thể đọc bộ nhớ tạm tự động');
    }
  }, [inform]);

  const openManual = useCallback(() => setManualOpen(true), []);
  const closeManual = useCallback(() => setManualOpen(false), []);
  const clearError = useCallback(() => setError(''), []);
  const setPreviewTab = useCallback(() => setInspectorTab('preview'), []);
  const setBridgeTab = useCallback(() => setInspectorTab('bridge'), []);
  const setAgentTab = useCallback(() => setInspectorTab('agent'), []);
  const refreshWorkspace = useCallback(() => {
    void window.studio.init().then(d => { if (d.workspace) setWorkspace(d.workspace); }).catch(() => {});
  }, []);
  const openGemini = useCallback((browser?: 'default' | 'edge' | 'chrome') => { void window.studio.openGemini(browser); }, []);
  const handleQuestionChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setQuestion(event.target.value), []);
  const handleSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value), []);
  const handleManualReplyChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setManualReply(event.target.value), []);

  const handleSelectPrompt = useCallback((promptText: string) => {
    setQuestion(promptText);
    textAreaRef.current?.focus();
  }, []);

  const handleSuggested = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const prompt = event.currentTarget.dataset.prompt || '';
    setQuestion(prompt);
    textAreaRef.current?.focus();
  }, []);

  const connected = connection.connected;

  return (
    <div className="app-shell">
      {/* Topbar Header */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 128 128" fill="none">
              <path d="M 64 22 C 64 43 43 64 22 64 C 43 64 64 85 64 106 C 64 85 85 64 106 64 C 85 64 64 43 64 22 Z" fill="url(#topGrad)"/>
              <circle cx="64" cy="64" r="7" fill="#ffffff"/>
              <defs>
                <linearGradient id="topGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#38bdf8"/>
                  <stop offset="100%" stopColor="#a855f7"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <span className="brand-text">GEMINI<span className="brand-soft"> / PROJECT STUDIO</span></span>
          <span className="version-tag">MVP v0.2</span>
        </div>

        <div className="top-actions">
          <button className="help-button" onClick={() => setOnboardingOpen(true)} title="Xem hướng dẫn chi tiết cho người mới">
            <HelpCircle size={15} />
            <span>Hướng dẫn người mới</span>
          </button>

          <div
            className={`status-pill ${connected ? 'connected' : 'disconnected'}`}
            onClick={setBridgeTab}
            title={connected ? 'Bridge đã kết nối với Chrome Extension' : 'Bridge offline · Bấm để xem hướng dẫn kết nối'}
            style={{ cursor: 'pointer' }}
          >
            <span className="status-light" />
            <span>{connected ? 'Bridge connected' : 'Bridge offline (Thủ công)'}</span>
          </div>

          <button className="ghost-button compact" onClick={() => openGemini('default')} title="Mở Gemini Web trong trình duyệt">
            <Globe2 size={15} />
            <span>Gemini Web</span>
            <ExternalLink size={12} />
          </button>
        </div>
      </header>

      {/* Main Grid Layout */}
      <div className="app-grid">
        {/* Left Sidebar: File Explorer */}
        <aside className="sidebar">
          <div className="section-label">
            <span>MÃ NGUỒN DỰ ÁN</span>
            <button className="icon-button" onClick={chooseWorkspace} title="Chọn thư mục project" aria-label="Chọn project">
              <FolderOpen size={16} />
            </button>
          </div>

          <button className="project-selector" onClick={chooseWorkspace} title="Bấm để đổi thư mục dự án">
            <div className="project-logo">
              <Folder size={17} />
            </div>
            <div className="project-meta">
              <strong>{workspace?.name || 'Chưa mở dự án'}</strong>
              <span>{workspace ? projectStats : 'Nhấp để chọn thư mục code'}</span>
            </div>
            <ChevronDown size={15} />
          </button>

          <div className="sidebar-search">
            <Search size={14} />
            <input
              value={search}
              onChange={handleSearchChange}
              placeholder="Tìm file hoặc nội dung..."
              aria-label="Tìm kiếm file"
              disabled={!workspace}
            />
            {search && (
              <button className="search-clear-btn" onClick={() => setSearch('')}>
                <X size={12} />
              </button>
            )}
          </div>

          {/* Quick File Category Tabs */}
          {workspace && !search.trim() && (
            <div className="file-filter-tabs">
              <button className={fileFilter === 'all' ? 'active' : ''} onClick={() => setFileFilter('all')}>Tất cả</button>
              <button className={fileFilter === 'code' ? 'active' : ''} onClick={() => setFileFilter('code')}>Code</button>
              <button className={fileFilter === 'docs' ? 'active' : ''} onClick={() => setFileFilter('docs')}>Tài liệu</button>
              <button className={fileFilter === 'config' ? 'active' : ''} onClick={() => setFileFilter('config')}>Config</button>
            </div>
          )}

          <div className="explorer-header">
            <span>DANH SÁCH FILE</span>
            <span>{search.trim() ? `${displayFiles.length} kết quả` : projectStats}</span>
          </div>

          <div className="file-list" aria-label="Danh sách file">
            {!workspace && (
              <div className="empty-files">
                <FolderOpen size={28} />
                <span>Mở thư mục để khám phá và hỏi đáp về codebase.</span>
                <button className="primary-button compact" onClick={chooseWorkspace}>
                  <FolderOpen size={14} /> Mở project
                </button>
              </div>
            )}
            {workspace && listRows.length === 0 && (
              <div className="empty-files">Không tìm thấy file phù hợp.</div>
            )}
            {listRows.map(row => row.type === 'folder' ? (
              <button
                key={'dir:' + row.path}
                className="file-row folder-row"
                style={{ paddingLeft: `${12 + (row.path.split('/').length - 1) * 12}px` }}
                data-path={row.path}
                onClick={toggleDir}
              >
                {expandedDirs.has(row.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={14} />
                <span className="file-label">{row.path.split('/').at(-1)}</span>
              </button>
            ) : (
              <button
                key={'file:' + row.path}
                data-path={row.path}
                onClick={selectFile}
                className={'file-row ' + (activeFile === row.path ? 'active' : '')}
                style={{ paddingLeft: `${25 + (row.path.split('/').length - 1) * 12}px` }}
              >
                {fileIcon(row.file!)}
                <span className="file-label">{row.file!.name}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-foot">
            <div className="sidebar-foot-icon"><ShieldCheck size={17} /></div>
            <div>
              <strong>Read-only workspace</strong>
              <span>An toàn 100% · Không sửa file</span>
            </div>
            <LockKeyhole size={13} />
          </div>
        </aside>

        {/* Center Panel: Chat & AI Conversation */}
        <main className="chat-panel">
          <div className="chat-header">
            <div className="chat-header-left">
              <div className="chat-heading">
                <div className="chat-heading-icon">
                  <Sparkles size={17} />
                </div>
                <div>
                  <h1>Trợ lý dự án Gemini</h1>
                  <span>Hiểu toàn diện mã nguồn · Không cần API key</span>
                </div>
              </div>

              <div className="chat-header-separator" />

              {/* Antigravity-style Session Navigation */}
              <div className="chat-session-nav">
                <button
                  className="history-toggle-btn"
                  onClick={() => setHistoryDrawerOpen(true)}
                  title="Mở lịch sử trò chuyện (Ctrl+H)"
                >
                  <History size={14} />
                  <span>Lịch sử</span>
                  {sessions.length > 0 && <span className="history-badge">{sessions.length}</span>}
                </button>

                <button
                  className="new-chat-btn"
                  onClick={handleNewChat}
                  title="Bắt đầu cuộc trò chuyện mới (Ctrl+N)"
                >
                  <Plus size={14} />
                  <span>Trò chuyện mới</span>
                </button>
              </div>

              {/* Current Session Title & Quick Rename */}
              {activeSession && (
                <div className="active-session-chip">
                  {isEditingHeaderTitle ? (
                    <form onSubmit={handleHeaderTitleSubmit} className="header-title-edit-form">
                      <input
                        ref={headerTitleInputRef}
                        type="text"
                        value={headerTitleDraft}
                        onChange={e => setHeaderTitleDraft(e.target.value)}
                        onBlur={handleHeaderTitleSubmit}
                        onKeyDown={e => {
                          if (e.key === 'Escape') setIsEditingHeaderTitle(false);
                        }}
                        autoFocus
                      />
                      <button type="submit" className="save-btn" title="Lưu tiêu đề">
                        <Check size={12} />
                      </button>
                    </form>
                  ) : (
                    <div
                      className="session-title-wrapper"
                      onClick={() => {
                        setHeaderTitleDraft(activeSession.title);
                        setIsEditingHeaderTitle(true);
                      }}
                      title="Bấm để đổi tên cuộc trò chuyện"
                    >
                      <span className="session-title-text">{activeSession.title}</span>
                      <button className="rename-hint-btn" title="Đổi tên">
                        <Edit3 size={11} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Interactive Model & Mode Selectors Bar */}
            <div className="chat-controls-bar">
              {/* Model Selector Chip with Dropdown */}
              <div className="chip-dropdown-wrapper">
                <button
                  className="model-chip-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModelMenu(prev => !prev);
                    setShowModeMenu(false);
                  }}
                  title="Bấm để đổi mô hình AI Gemini"
                >
                  <Cpu size={13} className="chip-ico" />
                  <span className="chip-text">
                    {selectedModel === 'gemini-pro' ? 'Gemini 2.5 Pro'
                      : selectedModel === 'gemini-flash' ? 'Gemini 2.5 Flash'
                      : selectedModel === 'gemini-thinking' ? 'Gemini Thinking'
                      : 'Gemini (Auto)'}
                  </span>
                  <ChevronDown size={11} className="chip-chevron" />
                </button>

                {showModelMenu && (
                  <div className="chip-dropdown-menu" onClick={e => e.stopPropagation()}>
                    <div className="dropdown-menu-header">Mô hình AI xử lý:</div>
                    <button
                      className={`dropdown-menu-item ${selectedModel === 'gemini-pro' ? 'active' : ''}`}
                      onClick={() => { setSelectedModel('gemini-pro'); setShowModelMenu(false); }}
                    >
                      <Sparkles size={14} className="item-ico pro" />
                      <div className="item-text">
                        <strong>Gemini 2.5 Pro</strong>
                        <small>Khuyên dùng · Context 2M tokens</small>
                      </div>
                      {selectedModel === 'gemini-pro' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${selectedModel === 'gemini-flash' ? 'active' : ''}`}
                      onClick={() => { setSelectedModel('gemini-flash'); setShowModelMenu(false); }}
                    >
                      <Zap size={14} className="item-ico flash" />
                      <div className="item-text">
                        <strong>Gemini 2.5 Flash</strong>
                        <small>Siêu tốc 1-2s · Câu hỏi ngắn</small>
                      </div>
                      {selectedModel === 'gemini-flash' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${selectedModel === 'gemini-thinking' ? 'active' : ''}`}
                      onClick={() => { setSelectedModel('gemini-thinking'); setShowModelMenu(false); }}
                    >
                      <Brain size={14} className="item-ico think" />
                      <div className="item-text">
                        <strong>Gemini Thinking</strong>
                        <small>Tư duy từng bước · Logic khó</small>
                      </div>
                      {selectedModel === 'gemini-thinking' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${selectedModel === 'auto' ? 'active' : ''}`}
                      onClick={() => { setSelectedModel('auto'); setShowModelMenu(false); }}
                    >
                      <Globe2 size={14} className="item-ico auto" />
                      <div className="item-text">
                        <strong>Tự động (Theo Web)</strong>
                        <small>Theo tab gemini.google.com</small>
                      </div>
                      {selectedModel === 'auto' && <Check size={14} className="item-check" />}
                    </button>
                    <div className="dropdown-menu-footer">
                      <button
                        className="dropdown-guide-link"
                        onClick={() => {
                          setShowModelMenu(false);
                          setOnboardingTab('modes-models');
                          setOnboardingOpen(true);
                        }}
                      >
                        <HelpCircle size={12} /> Hướng dẫn đổi model trên web ↗
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Analysis Mode Selector Chip with Dropdown */}
              <div className="chip-dropdown-wrapper">
                <button
                  className="mode-chip-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModeMenu(prev => !prev);
                    setShowModelMenu(false);
                  }}
                  title="Bấm để đổi chế độ phân tích"
                >
                  <Layers3 size={13} className="chip-ico" />
                  <span className="chip-text">
                    {analysisMode === 'vibe-code' ? '⚡ Vibe Coding'
                      : analysisMode === 'general' ? 'Tổng quan'
                      : analysisMode === 'bug-audit' ? 'Rà soát Bug'
                      : analysisMode === 'refactor' ? 'Tối ưu code'
                      : 'Viết tài liệu'}
                  </span>
                  <ChevronDown size={11} className="chip-chevron" />
                </button>

                {showModeMenu && (
                  <div className="chip-dropdown-menu" onClick={e => e.stopPropagation()}>
                    <div className="dropdown-menu-header">Chế độ phân tích:</div>
                    <button
                      className={`dropdown-menu-item ${analysisMode === 'vibe-code' ? 'active' : ''}`}
                      onClick={() => { setAnalysisMode('vibe-code'); setShowModeMenu(false); }}
                    >
                      <Zap size={14} className="item-ico vibe" />
                      <div className="item-text">
                        <strong>⚡ Vibe Coding (Ghi file trực tiếp)</strong>
                        <small>Xuất code kèm nút 1-click Apply vào dự án</small>
                      </div>
                      {analysisMode === 'vibe-code' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${analysisMode === 'general' ? 'active' : ''}`}
                      onClick={() => { setAnalysisMode('general'); setShowModeMenu(false); }}
                    >
                      <Layers3 size={14} className="item-ico general" />
                      <div className="item-text">
                        <strong>Tổng quan &amp; Kiến trúc</strong>
                        <small>Luồng dữ liệu, hiểu toàn diện</small>
                      </div>
                      {analysisMode === 'general' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${analysisMode === 'bug-audit' ? 'active' : ''}`}
                      onClick={() => { setAnalysisMode('bug-audit'); setShowModeMenu(false); }}
                    >
                      <ShieldAlert size={14} className="item-ico bug" />
                      <div className="item-text">
                        <strong>Rà soát Bug &amp; Bảo mật</strong>
                        <small>Lỗ hổng, bug ngầm, leak RAM</small>
                      </div>
                      {analysisMode === 'bug-audit' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${analysisMode === 'refactor' ? 'active' : ''}`}
                      onClick={() => { setAnalysisMode('refactor'); setShowModeMenu(false); }}
                    >
                      <Wrench size={14} className="item-ico refactor" />
                      <div className="item-text">
                        <strong>Tối ưu &amp; Tái cấu trúc</strong>
                        <small>Clean code, modular, performance</small>
                      </div>
                      {analysisMode === 'refactor' && <Check size={14} className="item-check" />}
                    </button>
                    <button
                      className={`dropdown-menu-item ${analysisMode === 'docs' ? 'active' : ''}`}
                      onClick={() => { setAnalysisMode('docs'); setShowModeMenu(false); }}
                    >
                      <FileText size={14} className="item-ico docs" />
                      <div className="item-text">
                        <strong>Soạn thảo Tài liệu</strong>
                        <small>User manual, Swagger, HD cài đặt</small>
                      </div>
                      {analysisMode === 'docs' && <Check size={14} className="item-check" />}
                    </button>
                    <div className="dropdown-menu-footer">
                      <button
                        className="dropdown-guide-link"
                        onClick={() => {
                          setShowModeMenu(false);
                          setOnboardingTab('modes-models');
                          setOnboardingOpen(true);
                        }}
                      >
                        <HelpCircle size={12} /> Hướng dẫn các chế độ ↗
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Guide help icon */}
              <button
                className="guide-help-icon-btn"
                onClick={() => {
                  setOnboardingTab('modes-models');
                  setOnboardingOpen(true);
                }}
                title="Bấm để mở hướng dẫn Đổi chế độ & Model"
              >
                <HelpCircle size={14} />
              </button>
            </div>
          </div>

          <div className="chat-scroll">
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="hero-glyph">
                  <BrainCircuit size={40} strokeWidth={1.5} />
                  <span className="glow-dot" />
                </div>
                <div className="eyebrow">
                  <span className="eyebrow-dot" /> KHÔNG GIAN LÀM VIỆC AI MÃ NGUỒN CỦA BẠN
                </div>
                <h2>Hiểu trọn vẹn dự án.<br /><em>Cùng sức mạnh Gemini.</em></h2>
                <p>
                  Đặt bất kỳ câu hỏi nào về kiến trúc, ý nghĩa code hay cách chạy app. Studio sẽ tự động lọc các file liên quan nhất làm ngữ cảnh — hoàn toàn miễn phí & bảo mật.
                </p>

                {!workspace ? (
                  <div className="welcome-cta">
                    <button className="primary-button" onClick={chooseWorkspace}>
                      <FolderOpen size={16} /> Chọn thư mục dự án để bắt đầu <ArrowRight size={16} />
                    </button>
                    <button className="outline-button" onClick={() => setOnboardingOpen(true)}>
                      <BookOpen size={15} /> Xem hướng dẫn cho người mới
                    </button>
                  </div>
                ) : (
                  <div className="ready-banner">
                    <CheckCircle2 size={16} /> Dự án <strong>{workspace.name}</strong> đã sẵn sàng ({workspace.files.length} files)
                  </div>
                )}

                {/* Categorized Prompts */}
                <div className="suggestion-section">
                  <div className="suggestion-title">Gợi ý câu hỏi phổ biến:</div>
                  <div className="suggestion-grid">
                    <button
                      data-prompt="Hãy giải thích tổng quan dự án này làm gì, giải quyết bài toán nào và dành cho ai bằng ngôn ngữ dễ hiểu nhất."
                      onClick={handleSuggested}
                    >
                      <BookOpenText size={18} />
                      <strong>Dự án này làm gì?</strong>
                      <span>Giải thích chức năng và đối tượng sử dụng</span>
                      <ArrowRight size={15} />
                    </button>
                    <button
                      data-prompt="Hãy hướng dẫn tôi cách cài đặt và chạy thử dự án này trên máy tính Windows từng bước một."
                      onClick={handleSuggested}
                    >
                      <TerminalSquare size={18} />
                      <strong>Cách chạy thử app</strong>
                      <span>Hướng dẫn cài đặt từ A đến Z cho người mới</span>
                      <ArrowRight size={15} />
                    </button>
                    <button
                      data-prompt="Phân tích các rủi ro, lỗi tiềm ẩn, vấn đề bảo mật và các điểm chưa tối ưu trong project này. Đưa ra giải pháp khắc phục cụ thể."
                      onClick={handleSuggested}
                    >
                      <Activity size={18} />
                      <strong>Tìm lỗi & Review code</strong>
                      <span>Phát hiện lỗ hổng và đề xuất cải tiến</span>
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>

                {/* Recent Conversations (Antigravity Style) */}
                {recentSessions.length > 0 && (
                  <div className="recent-sessions-block">
                    <div className="recent-sessions-header">
                      <div className="recent-sessions-title">
                        <History size={14} />
                        <span>Cuộc trò chuyện gần đây</span>
                      </div>
                      <button className="view-all-history-btn" onClick={() => setHistoryDrawerOpen(true)}>
                        Xem tất cả ({sessions.length}) →
                      </button>
                    </div>

                    <div className="recent-sessions-cards">
                      {recentSessions.map(sess => {
                        const lastMsg = sess.messages[sess.messages.length - 1];
                        const firstUser = sess.messages.find(m => m.role === 'user');
                        const snippet = lastMsg ? lastMsg.text : firstUser ? firstUser.text : 'Chưa có tin nhắn';
                        return (
                          <div
                            key={sess.id}
                            className="recent-session-card"
                            onClick={() => handleSelectSession(sess.id)}
                            title="Bấm để tiếp tục cuộc trò chuyện này"
                          >
                            <div className="recent-card-top">
                              <div className="recent-card-icon">
                                <MessageSquare size={13} />
                              </div>
                              <strong className="recent-card-title">{sess.title}</strong>
                            </div>
                            <p className="recent-card-snippet">
                              {snippet.slice(0, 90)}{snippet.length > 90 ? '…' : ''}
                            </p>
                            <div className="recent-card-footer">
                              <span className="recent-card-time">
                                <Clock size={11} />
                                {formatRelativeTime(sess.updatedAt || sess.createdAt)}
                              </span>
                              <span className="recent-card-count">
                                {sess.messages.length} tin
                              </span>
                              {sess.workspaceName && (
                                <span className="recent-card-ws" title={sess.workspaceRoot}>
                                  <Folder size={11} /> {sess.workspaceName}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="message-list">
                {messages.map(msg => (
                  <article className={'message ' + msg.role} key={msg.id}>
                    <div className="message-avatar">
                      {msg.role === 'user' ? <span>BẠN</span> : <Sparkles size={17} />}
                    </div>
                    <div className="message-body">
                      <div className="message-label">
                        {msg.role === 'user' ? 'Bạn' : 'Gemini Web'}
                        {msg.status && (
                          <span className={'message-status ' + msg.status}>
                            {msg.status === 'final' ? <Check size={12} /> : <LoaderCircle size={12} className="spin" />}
                            {statusText(msg.status)}
                          </span>
                        )}
                      </div>

                      {/* Professional Markdown & Code Block Viewer */}
                      <div className="message-text">
                        <MarkdownRenderer content={msg.text} activeFile={activeFile} availableFiles={files} onFileWritten={handleFileWritten} />
                      </div>

                      {/* Manual Action Card when offline or error */}
                      {(msg.status === 'manual' || msg.status === 'error') && (
                        <div className="manual-action-card">
                          <div className="manual-card-header">
                            <Lightbulb size={16} />
                            <strong>{msg.status === 'error' ? 'Không gửi tự động được? 3 bước thao tác ngay:' : '3 bước lấy kết quả nhanh:'}</strong>
                          </div>
                          <div className="manual-card-actions">
                            <button className="primary-button compact" onClick={() => copyPrepared(msg.preparedPrompt)}>
                              <Copy size={13} /> 1. Copy lại prompt
                            </button>
                            <button className="ghost-button compact" onClick={() => openGemini('default')}>
                              <ExternalLink size={13} /> 2. Mở Gemini Web ↗
                            </button>
                            <button className="primary-button compact highlight" onClick={openManual}>
                              <ClipboardCopy size={13} /> 3. Dán câu trả lời vào đây
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Files included in context */}
                      {msg.included && msg.included.length > 0 && (
                        <div className="context-chips">
                          <Layers3 size={13} />
                          <span>Ngữ cảnh: <strong>{msg.included.length} file</strong> ({msg.included.slice(0, 3).join(', ')}{msg.included.length > 3 ? '...' : ''})</span>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Composer Input Area */}
          <div className="composer-area">
            {prepared && (
              <div className="context-badge">
                <div>
                  <CheckCircle2 size={14} /> Ngữ cảnh sẵn sàng: <strong>{prepared.included.length} files</strong> · {(prepared.characters / 1000).toFixed(1)}k ký tự
                </div>
                <button onClick={() => copyPrepared()}>
                  <Copy size={13} /> Copy prompt đã tạo
                </button>
              </div>
            )}

            <div className="composer">
              <textarea
                ref={textAreaRef}
                placeholder={workspace ? 'Hỏi Gemini bất cứ điều gì về dự án của bạn (ví dụ: giải thích luồng hoạt động, tìm lỗi...)' : 'Vui lòng mở thư mục dự án trước để bắt đầu...'}
                disabled={!workspace || busy}
                value={question}
                onChange={handleQuestionChange}
                onKeyDown={handleComposerKey}
                rows={3}
                aria-label="Câu hỏi cho Gemini"
              />
              <div className="composer-actions">
                <div className="composer-hints">
                  <span><Layers3 size={12} /> Tự động gom code</span>
                  <span><LockKeyhole size={12} /> Chỉ đọc (Read-only)</span>
                  {!connected && <span className="offline-hint"><Globe2 size={12} /> Chế độ thủ công sẵn sàng</span>}
                </div>
                <div className="composer-buttons">
                  <button
                    className="toolbar-action"
                    onClick={prepareDraft}
                    disabled={!workspace || !question.trim() || busy}
                    title="Tạo context từ các file liên quan mà không gửi ngay"
                  >
                    <WandSparkles size={14} /> Soạn context
                  </button>
                  <button
                    className="send-button"
                    onClick={() => sendMessage()}
                    disabled={!workspace || !question.trim() || busy}
                    aria-label="Gửi câu hỏi"
                    title="Gửi câu hỏi (Enter)"
                  >
                    {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="composer-note">
              <span>Enter để gửi · Shift+Enter để xuống dòng</span>
              <button onClick={openManual} title="Nhập câu trả lời từ Gemini Web nếu gửi thủ công">
                <ClipboardCopy size={13} /> Dán câu trả lời thủ công
              </button>
            </div>
          </div>
        </main>

        {/* Right Sidebar: Inspector (Code Preview & Bridge Tab) */}
        <aside className="inspector">
          <div className="inspector-top">
            <div className="inspector-caption">
              <PanelRight size={16} /> INSPECTOR
            </div>
            <div className="inspector-tabs">
              <button className={inspectorTab === 'preview' ? 'selected' : ''} onClick={setPreviewTab}>Xem file</button>
              <button className={inspectorTab === 'agent' ? 'selected' : ''} onClick={setAgentTab}>Agent</button>
              <button className={inspectorTab === 'bridge' ? 'selected' : ''} onClick={setBridgeTab}>
                Bridge {connected && <span className="tiny-dot-green" />}
              </button>
            </div>
          </div>

          {inspectorTab === 'preview' ? (
            <div className="preview-pane">
              {activeFile ? (
                <>
                  <div className="preview-path">
                    <FileCode2 size={15} />
                    <span title={activeFile}>{activeFile}</span>
                    {hasUnsavedChanges && (
                      <span className="unsaved-badge" title="Có thay đổi chưa lưu">● Chưa lưu</span>
                    )}
                    <div className="preview-toggle-group">
                      {/\.(md|markdown|txt)$/i.test(activeFile) && (
                        <button
                          className={previewMode === 'preview' ? 'active' : ''}
                          onClick={() => setPreviewMode('preview')}
                          title="Xem định dạng văn bản"
                        >
                          Định dạng
                        </button>
                      )}
                      <button
                        className={previewMode === 'code' ? 'active' : ''}
                        onClick={() => setPreviewMode('code')}
                        title="Xem mã nguồn"
                      >
                        Xem
                      </button>
                      <button
                        className={`edit-toggle-btn ${previewMode === 'edit' ? 'active' : ''}`}
                        onClick={() => setPreviewMode('edit')}
                        title="Chỉnh sửa trực tiếp file này (Vibe Coding)"
                      >
                        <Edit3 size={12} />
                        Sửa file
                      </button>
                    </div>

                    {previewMode === 'edit' ? (
                      <div className="preview-edit-actions">
                        <button
                          className="save-file-btn"
                          disabled={!hasUnsavedChanges || isSavingFile}
                          onClick={() => void handleSaveActiveFile()}
                          title="Lưu thay đổi trực tiếp vào file (Ctrl+S)"
                        >
                          {isSavingFile ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}
                          <span>Lưu (Ctrl+S)</span>
                        </button>
                        {hasUnsavedChanges && (
                          <button
                            className="revert-file-btn"
                            onClick={() => setEditorContent(fileContent)}
                            title="Hoàn tác về bản gốc"
                          >
                            <Undo size={13} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <button aria-label="Copy nội dung file" title="Sao chép toàn bộ file này" onClick={copyFile}>
                        <Copy size={14} />
                      </button>
                    )}
                  </div>

                  {previewMode === 'edit' ? (
                    <div className="preview-editor-container">
                      <textarea
                        className="preview-editor-textarea"
                        value={editorContent}
                        onChange={e => setEditorContent(e.target.value)}
                        onKeyDown={handleEditorKeyDown}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        placeholder="Nhập hoặc chỉnh sửa mã nguồn trực tiếp tại đây..."
                      />
                    </div>
                  ) : previewMode === 'preview' && /\.(md|markdown|txt)$/i.test(activeFile) ? (
                    <div className="preview-markdown-container">
                      <MarkdownRenderer content={fileContent} activeFile={activeFile} availableFiles={files} onFileWritten={handleFileWritten} />
                    </div>
                  ) : (
                    <div className="preview-code" aria-label="File preview">
                      <pre>
                        {fileContent.split('\n').map((line, index) => (
                          <span key={`${activeFile}:${index}`} className="code-line">
                            <i>{index + 1}</i>
                            <span>{line || ' '}</span>
                          </span>
                        ))}
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <div className="preview-empty">
                  <div className="preview-empty-graphic"><Code2 size={34} /></div>
                  <strong>Chưa chọn file</strong>
                  <span>Chọn một file trong Explorer bên trái để xem nội dung chi tiết.</span>
                </div>
              )}

              <div className="inspector-info">
                <div className="inspector-info-row"><span>Dự án</span><b>{workspace?.name || '—'}</b></div>
                <div className="inspector-info-row"><span>Files đã quét</span><b>{files.length}</b></div>
                <div className="inspector-info-row"><span>Bỏ qua (ẩn/lớn)</span><b>{workspace?.skipped ?? 0}</b></div>
                {activeFile && (
                  <div className="inspector-info-row">
                    <span>Kích thước</span><b>{shortBytes(files.find(f => f.path === activeFile)?.size || 0)}</b>
                  </div>
                )}
              </div>
            </div>
          ) : inspectorTab === 'agent' ? (
            <AgentSessions connected={connected} workspaceOpen={!!workspace} onToast={inform} onFilesChanged={refreshWorkspace} />
          ) : (
            <div className="bridge-pane">
              <div className="bridge-orb"><PlugZap size={26} /></div>
              <h3>Gemini Web Bridge</h3>
              <p>
                Tương thích hoàn hảo cả <b>Microsoft Edge</b> và <b>Google Chrome</b>. Giúp Studio tự động đưa ngữ cảnh dự án vào tài khoản Gemini Web của bạn mà không cần API key.
              </p>

              <div className="connection-card">
                <div>
                  <span className={'connection-dot ' + (connected ? 'online' : '')} />
                  <strong>{connected ? 'Đã kết nối thành công' : 'Chưa kết nối Extension'}</strong>
                </div>
                <small>{connection.url}{connection.appVersion ? ` · Studio v${connection.appVersion}` : ''}</small>
                {connection.extension && connection.extension.status !== 'unknown' && (
                  <small className={'bridge-compat ' + connection.extension.status} role="status">
                    {connection.extension.status === 'ok' && `Extension khớp phiên bản (v${connection.extension.version}, giao thức ${connection.extension.protocol}) ✓`}
                    {connection.extension.status === 'outdated' && `Extension CŨ${connection.extension.version ? ` (v${connection.extension.version})` : ' (chưa báo phiên bản)'}: chạy cap-nhat-extension.bat hoặc chép lại thư mục Extension rồi bấm Reload ở trang extensions của trình duyệt.`}
                    {connection.extension.status === 'newer' && `Extension mới hơn Studio (v${connection.extension.version}): hãy cập nhật ứng dụng Studio.`}
                  </small>
                )}
              </div>

              <div className="bridge-steps">
                <div><span>01</span><p>Mở thư mục Extension trên máy tính</p></div>
                <div><span>02</span><p>Edge (edge://extensions) hoặc Chrome (chrome://extensions) → Bật Developer mode → Load unpacked</p></div>
                <div><span>03</span><p>Copy pairing JSON và dán vào Extension</p></div>
                <div><span>04</span><p>Mở tab gemini.google.com và giữ mở</p></div>
              </div>

              <button className="outline-button" onClick={showExtension}>
                <FolderOpen size={15} /> Mở thư mục Extension trên máy
              </button>
              <button className="primary-button full" onClick={copyPairInfo}>
                <KeyRound size={15} /> Copy mã kết nối (Pairing JSON)
              </button>
              <div className="bridge-browser-actions">
                <button className="ghost-button compact full" onClick={() => openGemini('edge')}>
                  <Globe2 size={13} /> Mở Gemini Web bằng Microsoft Edge ↗
                </button>
                <button className="ghost-button compact full" onClick={() => openGemini('chrome')}>
                  <Globe2 size={13} /> Mở Gemini Web bằng Google Chrome ↗
                </button>
              </div>

              <div className="bridge-warning">
                <ShieldCheck size={16} />
                <span>Hoạt động trực tiếp trên Edge hoặc Chrome. Tuyệt đối không đọc mật khẩu, cookie cá nhân hay gửi dữ liệu ra máy chủ lạ.</span>
              </div>
            </div>
          )}

          <div className="inspector-footer">
            <TerminalSquare size={15} />
            <span>Local execution <strong>disabled</strong> (Chỉ đọc)</span>
          </div>
        </aside>
      </div>

      {/* Floating Notifications */}
      {error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Đóng lỗi"><X size={16} /></button>
        </div>
      )}
      {toast && (
        <div className="toast success" role="status">
          <CheckCircle2 size={16} />
          <span>{toast}</span>
        </div>
      )}

      {/* Manual Reply Importer Modal */}
      {manualOpen && (
        <div className="modal-backdrop" onClick={closeManual} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Dán câu trả lời Gemini">
            <div className="modal-head">
              <div>
                <h3>Nhập phản hồi từ Gemini Web</h3>
                <p>Dùng khi bạn gửi prompt thủ công sang Gemini Web và muốn đưa câu trả lời về Studio để lưu trữ và xem code định dạng chuẩn.</p>
              </div>
              <button className="icon-button" onClick={closeManual} aria-label="Đóng"><X size={18} /></button>
            </div>

            <div className="modal-quick-actions">
              <button className="ghost-button compact" onClick={pasteFromClipboard}>
                <ClipboardCopy size={13} /> ⚡ Dán nhanh từ bộ nhớ tạm (Clipboard)
              </button>
              <span className="modal-hint-key">Phím tắt: Ctrl + Enter để lưu</span>
            </div>

            <textarea
              value={manualReply}
              onChange={handleManualReplyChange}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void importManual();
                }
              }}
              placeholder="Dán câu trả lời mà Gemini Web đã phản hồi vào đây..."
              rows={11}
            />

            <div className="modal-actions">
              <button className="outline-button" onClick={closeManual}>Hủy</button>
              <button className="primary-button" disabled={!manualReply.trim()} onClick={importManual}>
                <Send size={15} /> Lưu &amp; Hiển thị câu trả lời
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat History Drawer (Antigravity Style) */}
      <ChatHistoryDrawer
        isOpen={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        currentWorkspaceRoot={workspace?.root}
        currentWorkspaceName={workspace?.name}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onClearAllSessions={handleClearAllSessions}
        onImportSessions={handleImportSessions}
        onToast={inform}
      />

      {/* Onboarding / Guided Walkthrough Modal */}
      <OnboardingModal
        isOpen={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        onOpenFolder={chooseWorkspace}
        onCopyPairInfo={copyPairInfo}
        onShowExtension={showExtension}
        onOpenGemini={openGemini}
        onSelectPrompt={handleSelectPrompt}
        isConnected={connected}
        hasWorkspace={!!workspace}
        workspaceName={workspace?.name}
        initialTab={onboardingTab}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        selectedMode={analysisMode}
        onSelectMode={setAnalysisMode}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
