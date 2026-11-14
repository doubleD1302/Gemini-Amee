import { useState, useEffect } from 'react';
import {
  Sparkles, Laptop, PlugZap, BookOpen, Lightbulb, ShieldCheck,
  FolderOpen, Globe2, KeyRound, Copy, Check, ExternalLink,
  ChevronRight, ArrowRight, X, Maximize2, CheckCircle2,
  Terminal, Shield, Eye, Cpu, Zap, Brain, ShieldAlert,
  Wrench, FileText, Layers3, Sliders
} from 'lucide-react';

export type TabType = 'quickstart' | 'extension' | 'modes-models' | 'manual' | 'prompts' | 'safety';
export type BrowserType = 'edge' | 'chrome';
export type ModelOption = 'gemini-pro' | 'gemini-flash' | 'gemini-thinking' | 'auto';
export type ModeOption = 'general' | 'bug-audit' | 'refactor' | 'docs' | 'vibe-code';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenFolder: () => void;
  onCopyPairInfo: () => void;
  onShowExtension: () => void;
  onOpenGemini: (browser?: 'default' | 'edge' | 'chrome') => void;
  onSelectPrompt: (prompt: string) => void;
  isConnected: boolean;
  hasWorkspace?: boolean;
  workspaceName?: string;
  initialTab?: TabType;
  selectedModel?: ModelOption;
  onSelectModel?: (model: ModelOption) => void;
  selectedMode?: ModeOption;
  onSelectMode?: (mode: ModeOption) => void;
}

interface GuideMove {
  id: number;
  title: string;
  description: string;
  pinBoxEdge: { left: number; top: number; width: number; height: number };
  pinBoxChrome: { left: number; top: number; width: number; height: number };
  action?: {
    label: string;
    onClick: () => void;
    icon: typeof Copy;
  };
}

export function OnboardingModal({
  isOpen,
  onClose,
  onOpenFolder,
  onCopyPairInfo,
  onShowExtension,
  onOpenGemini,
  onSelectPrompt,
  isConnected,
  hasWorkspace = false,
  workspaceName = '',
  initialTab = 'quickstart',
  selectedModel = 'gemini-pro',
  onSelectModel,
  selectedMode = 'general',
  onSelectMode
}: OnboardingModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [browser, setBrowser] = useState<BrowserType>('edge');
  const [activeSpot, setActiveSpot] = useState<number | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedPair, setCopiedPair] = useState(false);
  const [isEnlarged, setIsEnlarged] = useState(false);
  const [promptCategory, setPromptCategory] = useState<'all' | 'beginner' | 'analysis' | 'docs' | 'refactor'>('all');

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEnlarged) {
          setIsEnlarged(false);
        } else if (isOpen) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isEnlarged, onClose]);

  if (!isOpen) return null;

  const copyUrl = async (url: string) => {
    try {
      if (window.studio?.copy) {
        await window.studio.copy(url);
      } else {
        await navigator.clipboard.writeText(url);
      }
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2200);
    } catch {
      // fallback
    }
  };

  const handleCopyPair = () => {
    onCopyPairInfo();
    setCopiedPair(true);
    setTimeout(() => setCopiedPair(false), 2200);
  };

  const extensionMoves: GuideMove[] = [
    {
      id: 1,
      title: browser === 'edge' ? 'Mở trang edge://extensions' : 'Mở trang chrome://extensions',
      description: `Nhập địa chỉ quản lý tiện ích trên trình duyệt ${browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}. Bạn có thể bấm nút Copy dưới đây để dán nhanh vào thanh địa chỉ.`,
      pinBoxEdge: { left: 16, top: 8, width: 44, height: 16 },
      pinBoxChrome: { left: 16, top: 8, width: 44, height: 16 },
      action: {
        label: copiedUrl ? 'Đã sao chép link!' : (browser === 'edge' ? 'Copy edge://extensions' : 'Copy chrome://extensions'),
        onClick: () => copyUrl(browser === 'edge' ? 'edge://extensions' : 'chrome://extensions'),
        icon: copiedUrl ? Check : Copy
      }
    },
    {
      id: 2,
      title: browser === 'edge' ? 'Bật "Chế độ dành cho nhà phát triển"' : 'Bật công tắc "Developer mode"',
      description: browser === 'edge'
        ? 'Ở menu bên trái, tìm và gạt công tắc "Chế độ dành cho nhà phát triển" (Developer mode) sang trạng thái BẬT.'
        : 'Ở góc trên cùng bên phải màn hình, gạt công tắc "Developer mode" sang BẬT để hiển thị thanh công cụ tiện ích.',
      pinBoxEdge: { left: 4, top: 40, width: 28, height: 18 },
      pinBoxChrome: { left: 68, top: 8, width: 26, height: 16 }
    },
    {
      id: 3,
      title: browser === 'edge' ? 'Bấm "Tải phần mở rộng chưa giải nén"' : 'Bấm "Load unpacked" (Tải tiện ích đã giải nén)',
      description: 'Bấm nút này và trỏ tới thư mục Extension đã chuẩn bị sẵn trong máy tính của bạn.',
      pinBoxEdge: { left: 34, top: 28, width: 32, height: 18 },
      pinBoxChrome: { left: 16, top: 28, width: 30, height: 18 },
      action: {
        label: 'Mở thư mục Extension trên máy',
        onClick: onShowExtension,
        icon: FolderOpen
      }
    },
    {
      id: 4,
      title: 'Dán mã kết nối (Pairing Token)',
      description: 'Bấm biểu tượng Extension ✦ trên thanh công cụ trình duyệt (hoặc biểu tượng Mảnh ghép 🧩 góc trên bên phải), chọn "⚡ Tự động dán" rồi bấm "Lưu & Kết nối".',
      pinBoxEdge: { left: 62, top: 48, width: 34, height: 44 },
      pinBoxChrome: { left: 62, top: 48, width: 34, height: 44 },
      action: {
        label: copiedPair ? 'Đã copy Pairing Code!' : 'Sao chép mã kết nối (Pairing JSON)',
        onClick: handleCopyPair,
        icon: copiedPair ? Check : KeyRound
      }
    },
    {
      id: 5,
      title: 'Mở tab gemini.google.com và giữ mở',
      description: 'Mở tab Gemini Web đã đăng nhập tài khoản Google của bạn. Studio sẽ tự động trò chuyện với tab này.',
      pinBoxEdge: { left: 16, top: 76, width: 44, height: 18 },
      pinBoxChrome: { left: 16, top: 76, width: 44, height: 18 },
      action: {
        label: `Mở Gemini Web bằng ${browser === 'edge' ? 'Edge' : 'Chrome'} ↗`,
        onClick: () => onOpenGemini(browser),
        icon: ExternalLink
      }
    }
  ];

  const prompts = [
    {
      category: 'beginner',
      tag: 'Người mới',
      tagClass: 'badge-sky',
      title: 'Giải thích tổng quan dự án làm gì',
      prompt: 'Hãy giải thích tổng quan dự án này làm gì, giải quyết bài toán nào và dành cho đối tượng người dùng nào bằng ngôn ngữ dễ hiểu, không dùng thuật ngữ kỹ thuật phức tạp.'
    },
    {
      category: 'beginner',
      tag: 'Chạy thử',
      tagClass: 'badge-green',
      title: 'Hướng dẫn cài đặt & chạy thử trên máy',
      prompt: 'Hãy hướng dẫn tôi cách cài đặt các môi trường, công cụ cần thiết và các lệnh cụ thể để chạy thử dự án này trên máy tính Windows từng bước một.'
    },
    {
      category: 'analysis',
      tag: 'Phân tích',
      tagClass: 'badge-purple',
      title: 'Tìm lỗi tiềm ẩn & đánh giá rủi ro bảo mật',
      prompt: 'Phân tích toàn diện các rủi ro, lỗi tiềm ẩn, vấn đề bảo mật và các điểm nghẽn hiệu năng trong mã nguồn dự án này. Đưa ra giải pháp khắc phục chi tiết cho từng điểm.'
    },
    {
      category: 'analysis',
      tag: 'Kiến trúc',
      tagClass: 'badge-purple',
      title: 'Phân tích luồng dữ liệu & cấu trúc module',
      prompt: 'Vẽ sơ đồ kiến trúc và giải thích luồng dữ liệu (Data Flow) chính của ứng dụng này từ khi nhận yêu cầu của người dùng đến lúc trả về kết quả.'
    },
    {
      category: 'docs',
      tag: 'Tài liệu',
      tagClass: 'badge-amber',
      title: 'Viết tài liệu Hướng dẫn sử dụng (User Manual)',
      prompt: 'Viết một bản tài liệu hướng dẫn sử dụng chi tiết (User Manual) bằng tiếng Việt cho dự án này, liệt kê toàn bộ các tính năng hiện có và cách thao tác.'
    },
    {
      category: 'refactor',
      tag: 'Tối ưu',
      tagClass: 'badge-pink',
      title: 'Đề xuất cải tiến & refactor mã nguồn',
      prompt: 'Hãy đề xuất danh sách các điểm nên tái cấu trúc (refactoring) để mã nguồn sạch hơn, dễ bảo trì hơn và tuân thủ các quy chuẩn thiết kế phần mềm hiện đại.'
    }
  ];

  const filteredPrompts = promptCategory === 'all'
    ? prompts
    : prompts.filter(p => p.category === promptCategory);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal onboarding-modal-cos"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Hướng dẫn cài đặt & sử dụng Gemini Project Studio"
      >
        {/* Top Header */}
        <div className="cos-head">
          <div className="cos-brand">
            <div className="cos-brand-badge">
              <Sparkles size={20} />
            </div>
            <div>
              <div className="cos-title-row">
                <h2>Hướng dẫn Gemini Project Studio</h2>
                <span className="cos-version-tag">Chuẩn Chat On Steroids</span>
              </div>
              <p className="cos-subtitle">
                Kết nối thông minh giữa mã nguồn máy bạn và <b>Gemini Web</b> qua Extension hoặc chế độ Thủ công
              </p>
            </div>
          </div>
          <button className="icon-button close-btn" onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        {/* Navigation Tabs (Phased architecture) */}
        <nav className="cos-tabs" aria-label="Các mục hướng dẫn">
          <button
            className={`cos-tab ${activeTab === 'quickstart' ? 'active' : ''}`}
            onClick={() => setActiveTab('quickstart')}
          >
            <Laptop size={15} />
            <span>1. Bắt đầu nhanh</span>
          </button>

          <button
            className={`cos-tab ${activeTab === 'extension' ? 'active' : ''}`}
            onClick={() => setActiveTab('extension')}
          >
            <PlugZap size={15} />
            <span>2. Cài Extension (Visual Guide)</span>
            {isConnected ? (
              <span className="cos-pill ok">● Đã kết nối</span>
            ) : (
              <span className="cos-pill rec">Khuyên dùng</span>
            )}
          </button>

          <button
            className={`cos-tab ${activeTab === 'modes-models' ? 'active' : ''}`}
            onClick={() => setActiveTab('modes-models')}
          >
            <Cpu size={15} />
            <span>3. Đổi Chế độ &amp; Model</span>
            <span className="cos-pill rec">Quan trọng</span>
          </button>

          <button
            className={`cos-tab ${activeTab === 'manual' ? 'active' : ''}`}
            onClick={() => setActiveTab('manual')}
          >
            <BookOpen size={15} />
            <span>4. Chế độ Thủ công</span>
            <span className="cos-pill plain">Zero-install</span>
          </button>

          <button
            className={`cos-tab ${activeTab === 'prompts' ? 'active' : ''}`}
            onClick={() => setActiveTab('prompts')}
          >
            <Lightbulb size={15} />
            <span>5. Prompts mẫu</span>
          </button>

          <button
            className={`cos-tab ${activeTab === 'safety' ? 'active' : ''}`}
            onClick={() => setActiveTab('safety')}
          >
            <ShieldCheck size={15} />
            <span>6. Cam kết An toàn</span>
          </button>
        </nav>

        {/* Content Body */}
        <div className="cos-body">
          {/* TAB 1: QUICKSTART STEPPER WIZARD */}
          {activeTab === 'quickstart' && (
            <div className="cos-pane">
              {/* Ready Hero Banner if already connected */}
              {isConnected ? (
                <div className="cos-ready-hero">
                  <div className="ready-icon-wrap">
                    <CheckCircle2 size={32} />
                  </div>
                  <div className="ready-info">
                    <h3>Bạn đã sẵn sàng 100%!</h3>
                    <p>
                      Studio đã kết nối thành công với Extension trên trình duyệt. Bạn có thể chọn bất kỳ câu hỏi nào dưới đây để bắt đầu ngay!
                    </p>
                    <div className="ready-quick-actions">
                      <button
                        className="btn-glow"
                        onClick={() => {
                          onSelectPrompt('Hãy giải thích tổng quan dự án này làm gì, giải quyết bài toán nào và dành cho đối tượng người dùng nào bằng ngôn ngữ dễ hiểu nhất.');
                          onClose();
                        }}
                      >
                        <Sparkles size={14} /> Hỏi tổng quan dự án ➔
                      </button>
                      <button
                        className="ghost-button compact"
                        onClick={() => {
                          onSelectPrompt('Hãy hướng dẫn tôi cách cài đặt và các lệnh để chạy thử dự án này trên máy tính Windows từng bước một.');
                          onClose();
                        }}
                      >
                        Hướng dẫn chạy app ↗
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="cos-waiting-banner">
                  <div className="pulse-dot-wrap">
                    <span className="pulse-dot" />
                  </div>
                  <div>
                    <strong>Trạng thái kết nối: Chờ kết nối từ Extension</strong>
                    <span>
                      Sau khi hoàn thành Bước 2 (Cài Extension), Extension sẽ tự động ghép nối với Studio tại cổng <code>localhost:3000</code>.
                    </span>
                  </div>
                </div>
              )}

              {/* Wizard Steps */}
              <ol className="cos-wizard-steps">
                {/* Step 1: Folder */}
                <li className={`cos-step ${hasWorkspace ? 'done' : 'active'}`}>
                  <div className="step-pin">
                    {hasWorkspace ? <Check size={14} /> : '1'}
                  </div>
                  <div className="step-main">
                    <div className="step-title-row">
                      <h4>Chọn thư mục mã nguồn dự án</h4>
                      {hasWorkspace && (
                        <span className="status-tag success">Đã chọn: {workspaceName || 'Dự án'}</span>
                      )}
                    </div>
                    <p className="step-desc">
                      Bấm nút bên dưới để mở thư mục chứa mã nguồn hoặc website/ứng dụng bạn muốn tìm hiểu. Studio sẽ quét các file và chỉ lập chỉ mục (Read-Only) an toàn.
                    </p>
                    <div className="step-actions">
                      <button className="primary-button compact" onClick={() => { onOpenFolder(); }}>
                        <FolderOpen size={14} />
                        <span>{hasWorkspace ? 'Đổi thư mục khác…' : 'Mở thư mục dự án ngay'}</span>
                      </button>
                    </div>
                  </div>
                </li>

                {/* Step 2: Read-Only Safety */}
                <li className="cos-step done">
                  <div className="step-pin">
                    <ShieldCheck size={14} />
                  </div>
                  <div className="step-main">
                    <div className="step-title-row">
                      <h4>Cam kết an toàn mã nguồn 100%</h4>
                      <span className="status-tag success">Read-Only Enforced</span>
                    </div>
                    <p className="step-desc">
                      Gemini Project Studio hoạt động ở chế độ <b>Chỉ Đọc (Read-Only)</b>. Ứng dụng tuyệt đối không có tính năng xóa, ghi đè hay sửa đổi bất kỳ file nào trên máy của bạn.
                    </p>
                  </div>
                </li>

                {/* Step 3: Choose Workflow Mode */}
                <li className={`cos-step ${isConnected ? 'done' : 'active'}`}>
                  <div className="step-pin">
                    {isConnected ? <Check size={14} /> : '2'}
                  </div>
                  <div className="step-main">
                    <div className="step-title-row">
                      <h4>Chọn cách làm việc cùng Gemini</h4>
                    </div>
                    <p className="step-desc">
                      Bạn có thể chọn 1 trong 2 phương thức tiện lợi tùy nhu cầu:
                    </p>
                    <div className="cos-choice-grid">
                      <div
                        className={`choice-card ${isConnected ? 'highlight' : ''}`}
                        onClick={() => setActiveTab('extension')}
                      >
                        <div className="choice-header">
                          <PlugZap size={18} />
                          <strong>Cách 1: Dùng Extension (Tự động 100%)</strong>
                          <span className="choice-pill">Khuyên dùng</span>
                        </div>
                        <p>
                          Cài tiện ích 1 lần duy nhất cho Edge hoặc Chrome. Studio sẽ tự động chuyển câu hỏi sang tab Gemini và nhận câu trả lời về giao diện đẹp mắt.
                        </p>
                        <span className="choice-link">
                          Xem hướng dẫn cài đặt trực quan <ChevronRight size={13} />
                        </span>
                      </div>

                      <div
                        className="choice-card"
                        onClick={() => setActiveTab('manual')}
                      >
                        <div className="choice-header">
                          <BookOpen size={18} />
                          <strong>Cách 2: Chế độ Thủ công (Copy-Paste)</strong>
                          <span className="choice-pill plain">Không cần cài gì</span>
                        </div>
                        <p>
                          Studio tự động gom các file liên quan thành prompt hoàn chỉnh. Bạn chỉ việc nhấn Copy và dán vào bất kỳ trình duyệt nào (Edge, Chrome, Brave, Firefox).
                        </p>
                        <span className="choice-link">
                          Xem quy trình thủ công <ChevronRight size={13} />
                        </span>
                      </div>
                    </div>
                  </div>
                </li>

                {/* Step 4: Ask Question */}
                <li className="cos-step">
                  <div className="step-pin">3</div>
                  <div className="step-main">
                    <div className="step-title-row">
                      <h4>Đặt bất kỳ câu hỏi nào bạn muốn</h4>
                    </div>
                    <p className="step-desc">
                      Hỏi về cách vận hành, tìm bug, giải thích thuật toán, hoặc hướng dẫn chạy app từng bước một cho người mới bắt đầu.
                    </p>
                    <div className="step-actions">
                      <button className="ghost-button compact" onClick={() => setActiveTab('prompts')}>
                        <Lightbulb size={14} /> Xem các mẫu câu hỏi hay
                      </button>
                    </div>
                  </div>
                </li>
              </ol>
            </div>
          )}

          {/* TAB 2: EXTENSION SETUP WITH INTERACTIVE VISUAL STAGE */}
          {activeTab === 'extension' && (
            <div className="cos-pane">
              {/* Browser Segment Picker */}
              <div className="cos-browser-picker">
                <span className="picker-label">Chọn trình duyệt bạn đang sử dụng:</span>
                <div className="browser-segments" role="radiogroup" aria-label="Trình duyệt">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={browser === 'edge'}
                    className={`browser-option ${browser === 'edge' ? 'is-selected' : ''}`}
                    onClick={() => { setBrowser('edge'); setActiveSpot(null); }}
                  >
                    <Globe2 size={16} />
                    <span><b>Microsoft Edge</b> (Có sẵn trên Windows - Khuyên dùng)</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={browser === 'chrome'}
                    className={`browser-option ${browser === 'chrome' ? 'is-selected' : ''}`}
                    onClick={() => { setBrowser('chrome'); setActiveSpot(null); }}
                  >
                    <Globe2 size={16} />
                    <span><b>Google Chrome</b> (Phổ biến)</span>
                  </button>
                </div>
              </div>

              {/* Status Header */}
              <div className="ext-status-strip">
                <div className={`status-pill ${isConnected ? 'connected' : 'waiting'}`}>
                  <span className="dot" />
                  <span>{isConnected ? 'Extension: Đã kết nối thành công' : 'Extension: Chờ cài đặt & kết nối'}</span>
                </div>
                <button
                  className="ghost-button compact zoom-btn"
                  onClick={() => setIsEnlarged(true)}
                  title="Phóng to ảnh mô phỏng trực quan"
                >
                  <Maximize2 size={13} />
                  <span>Phóng to mô phỏng</span>
                </button>
              </div>

              {/* Dual-Column Layout: Left Moves + Right Interactive Stage */}
              <div className="cos-guide-layout">
                {/* Moves Column */}
                <div className="cos-guide-moves-col">
                  <h4 className="column-title">Các bước thao tác ({browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'})</h4>
                  <ol className="guide-moves">
                    {extensionMoves.map((m) => {
                      const isLit = activeSpot === m.id;
                      return (
                        <li
                          key={m.id}
                          className={`guide-move ${isLit ? 'is-lit' : ''}`}
                          onMouseEnter={() => setActiveSpot(m.id)}
                          onMouseLeave={() => setActiveSpot(null)}
                          onClick={() => setActiveSpot(m.id)}
                          tabIndex={0}
                        >
                          <span className="guide-pin">{m.id}</span>
                          <div className="move-body">
                            <strong className="move-title">{m.title}</strong>
                            <p className="move-desc">{m.description}</p>
                            {m.action && (
                              <button
                                className="action-pill-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  m.action?.onClick();
                                }}
                              >
                                <m.action.icon size={13} />
                                <span>{m.action.label}</span>
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>

                {/* Stage Column (Interactive Mockup with Hotspots) */}
                <div className="cos-guide-stage-col">
                  <div className="column-head">
                    <span className="stage-caption">Mô phỏng vị trí thao tác trên màn hình:</span>
                    <span className="stage-hint">Rê chuột vào từng bước để sáng đèn vị trí</span>
                  </div>

                  <div className="guide-stage">
                    {/* Browser Mockup Window */}
                    <div className="browser-mockup">
                      {/* Browser Chrome Header */}
                      <div className="mockup-topbar">
                        <div className="window-dots">
                          <span className="wdot red" />
                          <span className="wdot yellow" />
                          <span className="wdot green" />
                        </div>
                        <div className="mockup-tabs">
                          <div className="mockup-tab active">
                            <span>Tiện ích mở rộng ({browser === 'edge' ? 'Edge' : 'Chrome'})</span>
                          </div>
                          <div className="mockup-tab">
                            <span>✦ Gemini Web</span>
                          </div>
                        </div>
                      </div>

                      {/* Mockup Navigation Bar */}
                      <div className="mockup-nav">
                        <div className="nav-controls">
                          <span>‹</span>
                          <span>›</span>
                          <span className="reload-glyph">↻</span>
                        </div>
                        <div className={`mockup-address-bar ${activeSpot === 1 ? 'is-highlighted' : ''}`}>
                          <Globe2 size={12} />
                          <span className="address-text">
                            {browser === 'edge' ? 'edge://extensions' : 'chrome://extensions'}
                          </span>
                          <button
                            className="mockup-copy-chip"
                            onClick={() => copyUrl(browser === 'edge' ? 'edge://extensions' : 'chrome://extensions')}
                            title="Sao chép địa chỉ"
                          >
                            <Copy size={11} />
                          </button>
                        </div>
                        <div className="nav-extension-icon">
                          <span className="ext-icon-dot">✦</span>
                        </div>
                      </div>

                      {/* Mockup Canvas */}
                      <div className="mockup-viewport">
                        {browser === 'edge' ? (
                          /* Microsoft Edge Mockup Layout */
                          <div className="edge-layout">
                            <div className="edge-sidebar">
                              <div className="edge-side-item active">Quản lý phần mở rộng</div>
                              <div className="edge-side-item">Cửa hàng Edge Add-ons</div>
                              <div className={`edge-dev-switch ${activeSpot === 2 ? 'is-highlighted' : ''}`}>
                                <span>Chế độ nhà phát triển</span>
                                <div className="toggle-switch on"><span className="toggle-thumb" /></div>
                              </div>
                            </div>
                            <div className="edge-content">
                              <div className="edge-action-bar">
                                <button className={`edge-btn-load ${activeSpot === 3 ? 'is-highlighted' : ''}`}>
                                  Tải phần mở rộng chưa giải nén
                                </button>
                              </div>
                              <div className="mockup-card-list">
                                <div className="mockup-ext-card">
                                  <div className="card-icon">✦</div>
                                  <div className="card-details">
                                    <strong>Gemini Project Studio Bridge</strong>
                                    <span>Phiên bản v0.2 · Chế độ an toàn Read-Only</span>
                                  </div>
                                  <div className="card-toggle on" />
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          /* Google Chrome Mockup Layout */
                          <div className="chrome-layout">
                            <div className="chrome-header">
                              <div className="chrome-title">Tiện ích mở rộng</div>
                              <div className={`chrome-dev-switch ${activeSpot === 2 ? 'is-highlighted' : ''}`}>
                                <span>Developer mode</span>
                                <div className="toggle-switch on"><span className="toggle-thumb" /></div>
                              </div>
                            </div>
                            <div className="chrome-actions">
                              <button className={`chrome-btn-load ${activeSpot === 3 ? 'is-highlighted' : ''}`}>
                                Load unpacked
                              </button>
                              <button className="chrome-btn-quiet">Pack extension</button>
                              <button className="chrome-btn-quiet">Update</button>
                            </div>
                            <div className="mockup-card-list">
                              <div className="mockup-ext-card">
                                <div className="card-icon">✦</div>
                                <div className="card-details">
                                  <strong>Gemini Project Studio Bridge</strong>
                                  <span>ID: jffh... · Read-Only local bridge</span>
                                </div>
                                <div className="card-toggle on" />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Floating Popup Mockup for Move 4 */}
                        <div className={`mockup-popup-card ${activeSpot === 4 ? 'is-highlighted' : ''}`}>
                          <div className="popup-head">
                            <div className="popup-title">
                              <span>✦</span>
                              <strong>Gemini Studio Bridge</strong>
                            </div>
                            <span className="popup-status-dot online" />
                          </div>
                          <div className="popup-body">
                            <div className="popup-input-field">
                              <span className="field-label">Server Bridge URL:</span>
                              <div className="field-val">http://localhost:3000</div>
                            </div>
                            <div className="popup-input-field">
                              <span className="field-label">Auth Token:</span>
                              <div className="field-val">••••••••••••••••</div>
                            </div>
                            <div className="popup-btns">
                              <button className="popup-btn-autopaste is-pulsing" onClick={handleCopyPair}>
                                ⚡ Tự động dán
                              </button>
                              <button className="popup-btn-save">
                                Lưu &amp; Kết nối
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Interactive Hotspot Pins */}
                        {extensionMoves.map((m) => {
                          const box = browser === 'edge' ? m.pinBoxEdge : m.pinBoxChrome;
                          const isLit = activeSpot === m.id;
                          return (
                            <div
                              key={m.id}
                              className={`guide-spot ${isLit ? 'is-lit' : ''}`}
                              style={{
                                left: `${box.left}%`,
                                top: `${box.top}%`,
                                width: `${box.width}%`,
                                height: `${box.height}%`
                              }}
                              onClick={() => setActiveSpot(m.id)}
                              onMouseEnter={() => setActiveSpot(m.id)}
                              onMouseLeave={() => setActiveSpot(null)}
                            >
                              <span className="spot-pin">{m.id}</span>
                              {isLit && (
                                <div className="spot-tooltip">
                                  <strong>{m.title}</strong>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: MODES & MODELS HUB (NEW) */}
          {activeTab === 'modes-models' && (
            <div className="cos-pane">
              {/* Header Box */}
              <div className="modes-lead-card">
                <div className="lead-icon-circle">
                  <Sliders size={24} />
                </div>
                <div>
                  <h3>Trung tâm Điều khiển Chế độ &amp; Mô hình Gemini</h3>
                  <p>
                    Tùy biến sức mạnh của Gemini để giải quyết đúng bài toán: từ đọc kiến trúc toàn diện, rà soát lỗ hổng bảo mật, cho tới chọn mô hình phù hợp (Flash siêu tốc vs Pro suy luận sâu).
                  </p>
                </div>
              </div>

              {/* Section 1: Choose AI Model */}
              <div className="config-section">
                <div className="section-head-row">
                  <div>
                    <h4>1. Chọn Mô hình AI (Gemini Model)</h4>
                    <span className="subhead-text">Mô hình AI xử lý mã nguồn của bạn:</span>
                  </div>
                  <span className="active-badge">
                    Đang chọn: <b>{selectedModel === 'gemini-pro' ? 'Gemini 2.5 Pro' : selectedModel === 'gemini-flash' ? 'Gemini 2.5 Flash' : selectedModel === 'gemini-thinking' ? 'Gemini Thinking' : 'Tự động'}</b>
                  </span>
                </div>

                <div className="models-grid">
                  <div
                    className={`model-card ${selectedModel === 'gemini-pro' ? 'is-active' : ''}`}
                    onClick={() => onSelectModel?.('gemini-pro')}
                  >
                    <div className="model-head">
                      <div className="model-icon pro"><Sparkles size={18} /></div>
                      <div className="model-titles">
                        <strong>Gemini 2.5 Pro</strong>
                        <span className="model-tag-rec">Khuyên dùng cho Code</span>
                      </div>
                      {selectedModel === 'gemini-pro' && <CheckCircle2 size={16} className="selected-check" />}
                    </div>
                    <p className="model-summary">
                      Cửa sổ ngữ cảnh <b>2.000.000 tokens</b> khổng lồ. Hiểu trọn vẹn sự liên kết giữa hàng trăm file, suy luận kiến trúc phức tạp và giải quyết các bài toán lớn.
                    </p>
                    <div className="model-stats">
                      <span>Độ sâu: ★★★★★</span>
                      <span>Ngữ cảnh: 2M Tokens</span>
                    </div>
                  </div>

                  <div
                    className={`model-card ${selectedModel === 'gemini-flash' ? 'is-active' : ''}`}
                    onClick={() => onSelectModel?.('gemini-flash')}
                  >
                    <div className="model-head">
                      <div className="model-icon flash"><Zap size={18} /></div>
                      <div className="model-titles">
                        <strong>Gemini 2.5 Flash</strong>
                        <span className="model-tag-speed">Siêu tốc độ 1-2s</span>
                      </div>
                      {selectedModel === 'gemini-flash' && <CheckCircle2 size={16} className="selected-check" />}
                    </div>
                    <p className="model-summary">
                      Tốc độ phản hồi cực nhanh chỉ 1-2 giây. Phù hợp hoàn hảo cho việc tra cứu cú pháp, giải thích hàm ngắn, chỉnh sửa đoạn code nhỏ hoặc hỏi đáp nhanh.
                    </p>
                    <div className="model-stats">
                      <span>Tốc độ: ★★★★★</span>
                      <span>Độ trễ: Cực thấp</span>
                    </div>
                  </div>

                  <div
                    className={`model-card ${selectedModel === 'gemini-thinking' ? 'is-active' : ''}`}
                    onClick={() => onSelectModel?.('gemini-thinking')}
                  >
                    <div className="model-head">
                      <div className="model-icon think"><Brain size={18} /></div>
                      <div className="model-titles">
                        <strong>Gemini Thinking</strong>
                        <span className="model-tag-deep">Tư duy từng bước</span>
                      </div>
                      {selectedModel === 'gemini-thinking' && <CheckCircle2 size={16} className="selected-check" />}
                    </div>
                    <p className="model-summary">
                      Suy luận logic nhiều tầng (Chain of Thought). Tự kiểm tra lại từng giả định trước khi trả lời, cực kỳ xuất sắc khi tìm các bug logic xoắn não và thiết kế giải thuật.
                    </p>
                    <div className="model-stats">
                      <span>Suy luận: Chuyên sâu</span>
                      <span>Logic: Đỉnh cao</span>
                    </div>
                  </div>

                  <div
                    className={`model-card ${selectedModel === 'auto' ? 'is-active' : ''}`}
                    onClick={() => onSelectModel?.('auto')}
                  >
                    <div className="model-head">
                      <div className="model-icon auto"><Globe2 size={18} /></div>
                      <div className="model-titles">
                        <strong>Tự động (Theo Web)</strong>
                        <span className="model-tag-auto">Theo tab mở sẵn</span>
                      </div>
                      {selectedModel === 'auto' && <CheckCircle2 size={16} className="selected-check" />}
                    </div>
                    <p className="model-summary">
                      Sử dụng chính xác mô hình mà bạn đang chọn sẵn trên giao diện tab <code>gemini.google.com</code> của trình duyệt.
                    </p>
                    <div className="model-stats">
                      <span>Tự động thích ứng</span>
                      <span>Không cần cấu hình</span>
                    </div>
                  </div>
                </div>

                {/* Guide to change model on Gemini Web */}
                <div className="gemini-web-model-tip">
                  <div className="tip-header">
                    <Globe2 size={15} />
                    <strong>Cách chuyển đổi Model trực tiếp trên trang Gemini Web:</strong>
                  </div>
                  <ol className="tip-steps">
                    <li>Mở tab <b>gemini.google.com</b> trên Edge hoặc Chrome.</li>
                    <li>Nhìn lên góc trên bên trái khung chat, bấm vào menu chọn model: <code>[ Gemini 2.5 Flash ▾ ]</code> hoặc <code>[ Gemini Advanced ▾ ]</code>.</li>
                    <li>Chọn model bạn muốn sử dụng (ví dụ <b>Gemini 2.5 Pro</b>). Toàn bộ câu hỏi gửi từ Studio sẽ được xử lý bằng model đó ngay lập tức!</li>
                  </ol>
                </div>
              </div>

              {/* Section 2: Choose Analysis Mode */}
              <div className="config-section">
                <div className="section-head-row">
                  <div>
                    <h4>2. Chọn Chế độ Phân tích Chuyên biệt (Analysis Mode)</h4>
                    <span className="subhead-text">Tự động định hướng phong cách và góc nhìn phân tích của Gemini:</span>
                  </div>
                  <span className="active-badge">
                    Đang chọn: <b>{selectedMode === 'vibe-code' ? '⚡ Vibe Coding (Ghi file trực tiếp)' : selectedMode === 'general' ? 'Tổng quan & Kiến trúc' : selectedMode === 'bug-audit' ? 'Rà soát Bug & Bảo mật' : selectedMode === 'refactor' ? 'Tối ưu & Tái cấu trúc' : 'Soạn thảo Tài liệu'}</b>
                  </span>
                </div>

                <div className="analysis-modes-grid">
                  <div
                    className={`mode-card ${selectedMode === 'vibe-code' ? 'is-active' : ''}`}
                    onClick={() => onSelectMode?.('vibe-code')}
                  >
                    <div className="mode-card-header">
                      <Zap size={18} className="mode-ico vibe" />
                      <strong>⚡ 1. Vibe Coding (Ghi file trực tiếp)</strong>
                      {selectedMode === 'vibe-code' && <Check size={14} className="mode-check" />}
                    </div>
                    <p>
                      Đóng vai Lập trình viên Vibe Coding. Xuất code hoàn chỉnh có gắn thẻ file (<code>// FILE: path</code>) kèm nút 1-click Áp dụng trực tiếp vào dự án.
                    </p>
                    <span className="mode-usecase">Dành cho: Hiện thực tính năng mới, sửa code tự động</span>
                  </div>

                  <div
                    className={`mode-card ${selectedMode === 'general' ? 'is-active' : ''}`}
                    onClick={() => onSelectMode?.('general')}
                  >
                    <div className="mode-card-header">
                      <Layers3 size={18} className="mode-ico general" />
                      <strong>1. Tổng quan &amp; Kiến trúc</strong>
                      {selectedMode === 'general' && <Check size={14} className="mode-check" />}
                    </div>
                    <p>
                      Đóng vai Trợ lý Kiến trúc. Giải thích toàn diện luồng dữ liệu, cách các module giao tiếp và mục đích tổng thể của dự án bằng ngôn ngữ dễ hiểu.
                    </p>
                    <span className="mode-usecase">Dành cho: Người mới, tiếp cận dự án lạ</span>
                  </div>

                  <div
                    className={`mode-card ${selectedMode === 'bug-audit' ? 'is-active' : ''}`}
                    onClick={() => onSelectMode?.('bug-audit')}
                  >
                    <div className="mode-card-header">
                      <ShieldAlert size={18} className="mode-ico bug" />
                      <strong>2. Rà soát Bug &amp; Bảo mật</strong>
                      {selectedMode === 'bug-audit' && <Check size={14} className="mode-check" />}
                    </div>
                    <p>
                      Đóng vai Chuyên gia An ninh &amp; Rà soát Lỗi. Tập trung tìm kiếm các lỗ hổng bảo mật, lỗi logic ngầm, memory leak và các ngoại lệ chưa được xử lý.
                    </p>
                    <span className="mode-usecase">Dành cho: Kiểm tra an ninh, rà soát trước khi release</span>
                  </div>

                  <div
                    className={`mode-card ${selectedMode === 'refactor' ? 'is-active' : ''}`}
                    onClick={() => onSelectMode?.('refactor')}
                  >
                    <div className="mode-card-header">
                      <Wrench size={18} className="mode-ico refactor" />
                      <strong>3. Tối ưu &amp; Tái cấu trúc</strong>
                      {selectedMode === 'refactor' && <Check size={14} className="mode-check" />}
                    </div>
                    <p>
                      Đóng vai Kỹ sư Clean Code. Đề xuất tách file, tái cấu trúc hàm, áp dụng Design Pattern chuẩn mực và tối ưu tốc độ thuật toán.
                    </p>
                    <span className="mode-usecase">Dành cho: Dọn dẹp code, nâng cấp hiệu năng</span>
                  </div>

                  <div
                    className={`mode-card ${selectedMode === 'docs' ? 'is-active' : ''}`}
                    onClick={() => onSelectMode?.('docs')}
                  >
                    <div className="mode-card-header">
                      <FileText size={18} className="mode-ico docs" />
                      <strong>4. Soạn thảo Tài liệu</strong>
                      {selectedMode === 'docs' && <Check size={14} className="mode-check" />}
                    </div>
                    <p>
                      Đóng vai Technical Writer. Tự động viết tài liệu User Manual cho người dùng cuối, tài liệu API/Swagger, hoặc hướng dẫn cài đặt từng bước.
                    </p>
                    <span className="mode-usecase">Dành cho: Bàn giao dự án, viết hướng dẫn sử dụng</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ZERO-INSTALL MANUAL MODE */}
          {activeTab === 'manual' && (
            <div className="cos-pane">
              <div className="cos-lead-box">
                <BookOpen size={20} />
                <div>
                  <strong>Chế độ Thủ công (Không cần Extension / Zero-install)</strong>
                  <p>
                    Bạn sử dụng máy tính cơ quan, công ty hạn chế quyền cài tiện ích, hoặc muốn dùng ngay lập tức? Chế độ Thủ công hoạt động 100% trên <b>mọi trình duyệt</b> (Edge, Chrome, Brave, Cốc Cốc, Firefox, Safari) mà không yêu cầu cài đặt bất kỳ thành phần nào.
                  </p>
                </div>
              </div>

              {/* 3-Step Flow Diagram */}
              <div className="manual-stepper-cards">
                <div className="manual-step-item">
                  <div className="manual-num">Bước 1</div>
                  <div className="manual-card">
                    <div className="manual-icon-orb">
                      <Terminal size={20} />
                    </div>
                    <strong>Nhập câu hỏi trong Studio</strong>
                    <p>
                      Gõ câu hỏi bạn thắc mắc về mã nguồn. Studio sẽ tự động quét dự án và gom <b>tối đa 18 file quan trọng nhất</b> liên quan vào bộ nhớ tạm.
                    </p>
                    <span className="manual-tag">Tự động gom code</span>
                  </div>
                </div>

                <div className="flow-arrow-symbol">➔</div>

                <div className="manual-step-item">
                  <div className="manual-num">Bước 2</div>
                  <div className="manual-card">
                    <div className="manual-icon-orb">
                      <ExternalLink size={20} />
                    </div>
                    <strong>Dán vào Gemini Web (Ctrl+V)</strong>
                    <p>
                      Mở tab <b>gemini.google.com</b> trên trình duyệt bất kỳ, ấn <code>Ctrl + V</code> và bấm Gửi để nhận phân tích chuyên sâu từ mô hình AI mạnh mẽ nhất.
                    </p>
                    <button
                      className="outline-button compact"
                      onClick={() => onOpenGemini('default')}
                    >
                      Mở Gemini Web ngay ↗
                    </button>
                  </div>
                </div>

                <div className="flow-arrow-symbol">➔</div>

                <div className="manual-step-item">
                  <div className="manual-num">Bước 3</div>
                  <div className="manual-card">
                    <div className="manual-icon-orb">
                      <Eye size={20} />
                    </div>
                    <strong>Xem phản hồi trong Studio</strong>
                    <p>
                      Copy câu trả lời từ Gemini, bấm nút <i>"Dán câu trả lời thủ công"</i> ở góc phải Studio để xem định dạng Code block, Markdown và lưu trữ lịch sử.
                    </p>
                    <span className="manual-tag">Định dạng code đẹp</span>
                  </div>
                </div>
              </div>

              {/* Tips & Comparison Box */}
              <div className="cos-features-comparison">
                <h4>So sánh hai phương thức vận hành:</h4>
                <div className="comparison-table">
                  <div className="comp-row head">
                    <div>Tiêu chí</div>
                    <div>Dùng Extension (Khuyên dùng)</div>
                    <div>Chế độ Thủ công</div>
                  </div>
                  <div className="comp-row">
                    <div>Tốc độ &amp; Thao tác</div>
                    <div className="good">Tự động 100% (1 click gửi &amp; nhận về)</div>
                    <div>Cần copy và dán tay (Ctrl+C, Ctrl+V)</div>
                  </div>
                  <div className="comp-row">
                    <div>Yêu cầu cài đặt</div>
                    <div>Cài Extension 1 lần duy nhất</div>
                    <div className="good">Không cần cài bất kỳ thứ gì</div>
                  </div>
                  <div className="comp-row">
                    <div>Trình duyệt hỗ trợ</div>
                    <div>Microsoft Edge &amp; Google Chrome</div>
                    <div className="good">Tất cả trình duyệt (Edge, Chrome, Brave, Firefox,...)</div>
                  </div>
                  <div className="comp-row">
                    <div>Độ an toàn</div>
                    <div className="good">100% Read-Only trên máy</div>
                    <div className="good">100% Read-Only trên máy</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: SMART PROMPT TEMPLATES */}
          {activeTab === 'prompts' && (
            <div className="cos-pane">
              <div className="prompts-head-bar">
                <div>
                  <h4 className="prompts-title">Mẹo đặt câu hỏi thông minh cho người mới</h4>
                  <p className="prompts-desc">
                    Không cần rành lập trình! Chọn một mẫu câu bên dưới, Studio sẽ tự động nạp câu hỏi và bắt đầu phân tích:
                  </p>
                </div>

                {/* Filter categories */}
                <div className="prompt-filters">
                  <button
                    className={`filter-btn ${promptCategory === 'all' ? 'active' : ''}`}
                    onClick={() => setPromptCategory('all')}
                  >
                    Tất cả
                  </button>
                  <button
                    className={`filter-btn ${promptCategory === 'beginner' ? 'active' : ''}`}
                    onClick={() => setPromptCategory('beginner')}
                  >
                    Người mới
                  </button>
                  <button
                    className={`filter-btn ${promptCategory === 'analysis' ? 'active' : ''}`}
                    onClick={() => setPromptCategory('analysis')}
                  >
                    Phân tích
                  </button>
                  <button
                    className={`filter-btn ${promptCategory === 'docs' ? 'active' : ''}`}
                    onClick={() => setPromptCategory('docs')}
                  >
                    Tài liệu
                  </button>
                  <button
                    className={`filter-btn ${promptCategory === 'refactor' ? 'active' : ''}`}
                    onClick={() => setPromptCategory('refactor')}
                  >
                    Tối ưu
                  </button>
                </div>
              </div>

              {/* Prompt Card Grid */}
              <div className="cos-prompts-grid">
                {filteredPrompts.map((item, idx) => (
                  <div key={idx} className="cos-prompt-card">
                    <div className="card-top">
                      <span className={`prompt-tag ${item.tagClass}`}>{item.tag}</span>
                      <h5>{item.title}</h5>
                    </div>
                    <p className="prompt-text">"{item.prompt}"</p>
                    <div className="card-foot">
                      <button
                        className="btn-use-prompt"
                        onClick={() => {
                          onSelectPrompt(item.prompt);
                          onClose();
                        }}
                      >
                        <span>Sử dụng prompt này</span>
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 6: SAFETY & PRIVACY COMMITMENTS */}
          {activeTab === 'safety' && (
            <div className="cos-pane">
              <div className="safety-hero-card">
                <div className="safety-hero-icon">
                  <ShieldCheck size={36} />
                </div>
                <div>
                  <h3>Cam kết An toàn Tuyệt đối 100% cho Mã Nguồn</h3>
                  <p>
                    Gemini Project Studio được thiết kế với tiêu chuẩn an toàn bảo mật nghiêm ngặt nhất. Bạn hoàn toàn yên tâm khi sử dụng với bất kỳ dự án nào.
                  </p>
                </div>
              </div>

              <div className="safety-pillars-grid">
                <div className="pillar-card">
                  <div className="pillar-num">01</div>
                  <div className="pillar-icon"><Shield size={20} /></div>
                  <h4>Chế độ Read-Only Tuyệt đối</h4>
                  <p>
                    Ứng dụng chỉ đọc file (fs.readFile) để phân tích cú pháp. Không chứa bất kỳ API ghi đè, tạo mới hay xóa file nào trên ổ cứng máy bạn.
                  </p>
                </div>

                <div className="pillar-card">
                  <div className="pillar-num">02</div>
                  <div className="pillar-icon"><Laptop size={20} /></div>
                  <h4>Xử lý Local 100%</h4>
                  <p>
                    Bộ quét mã nguồn, lập chỉ mục (indexer) và tìm kiếm từ khóa diễn ra hoàn toàn offline trong máy bạn. Không lưu trữ mã nguồn trên cloud trung gian.
                  </p>
                </div>

                <div className="pillar-card">
                  <div className="pillar-num">03</div>
                  <div className="pillar-icon"><KeyRound size={20} /></div>
                  <h4>Không cần API Key / Thẻ Visa</h4>
                  <p>
                    Tận dụng trực tiếp tài khoản Google Gemini Web cá nhân miễn phí của bạn. Không phát sinh chi phí hàng tháng hay rủi ro lộ API Key.
                  </p>
                </div>

                <div className="pillar-card">
                  <div className="pillar-num">04</div>
                  <div className="pillar-icon"><Eye size={20} /></div>
                  <h4>Minh bạch Dữ liệu</h4>
                  <p>
                    Bạn luôn có thể xem trước chính xác những file nào và nội dung gì được gom làm ngữ cảnh (Context) trước khi gửi sang Gemini.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="cos-footer">
          <div className="footer-left">
            <span className="footer-status-indicator">
              <span className={`dot ${isConnected ? 'online' : 'offline'}`} />
              {isConnected ? 'Bridge đang hoạt động: Đã kết nối' : 'Bridge: Sẵn sàng kết nối tại localhost:3000'}
            </span>
          </div>

          <div className="footer-right">
            <button className="outline-button" onClick={onClose}>
              Đóng hướng dẫn
            </button>

            {activeTab === 'quickstart' && (
              <button className="primary-button" onClick={() => setActiveTab('extension')}>
                Xem hướng dẫn cài Extension <ChevronRight size={15} />
              </button>
            )}

            {activeTab === 'extension' && (
              <button className="primary-button" onClick={() => setActiveTab('modes-models')}>
                Xem đổi chế độ &amp; model <ChevronRight size={15} />
              </button>
            )}

            {activeTab === 'modes-models' && (
              <button className="primary-button" onClick={() => setActiveTab('prompts')}>
                Xem các mẫu câu hỏi hay <ChevronRight size={15} />
              </button>
            )}

            {activeTab === 'manual' && (
              <button className="primary-button" onClick={() => setActiveTab('prompts')}>
                Chọn câu hỏi mẫu ngay <ChevronRight size={15} />
              </button>
            )}

            {activeTab === 'prompts' && (
              <button className="primary-button" onClick={onClose}>
                Bắt đầu trò chuyện ngay ➔
              </button>
            )}

            {activeTab === 'safety' && (
              <button className="primary-button" onClick={() => setActiveTab('quickstart')}>
                Quay lại Bắt đầu nhanh
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Fullscreen Enlarged Dialog (Enlarge Shot feature from chat-on-steroids) */}
      {isEnlarged && (
        <div className="cos-enlarge-dialog" onClick={() => setIsEnlarged(false)}>
          <div className="enlarge-panel" onClick={e => e.stopPropagation()}>
            <div className="enlarge-head">
              <h3>Mô phỏng chi tiết cài đặt Extension ({browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'})</h3>
              <button className="icon-button" onClick={() => setIsEnlarged(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="enlarge-body">
              <div className="enlarge-stage-wrapper">
                <div className="enlarge-legend">
                  <h4>Danh sách vị trí cần bấm:</h4>
                  <ol>
                    {extensionMoves.map((m) => (
                      <li key={m.id} className={activeSpot === m.id ? 'is-lit' : ''} onClick={() => setActiveSpot(m.id)}>
                        <span className="legend-pin">{m.id}</span>
                        <div>
                          <strong>{m.title}</strong>
                          <p>{m.description}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
