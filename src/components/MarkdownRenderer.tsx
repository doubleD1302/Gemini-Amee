import React, { useState } from 'react';
import { Check, CheckCheck, Copy, FileCode, Loader2, Terminal, Zap } from 'lucide-react';

interface CodeBlockProps {
  language: string;
  code: string;
  precedingContext?: string;
  activeFile?: string;
  availableFiles?: { path: string }[];
  onFileWritten?: (filePath: string) => void;
}

function parseFileTarget(language: string, rawCode: string, precedingContext = ''): { targetFile: string; cleanCode: string } {
  let targetFile = '';
  let cleanCode = rawCode;

  // 1. Language tag e.g. ```swift:PharmaTask/LockScreen.swift or ```typescript:src/App.tsx
  if (language.includes(':')) {
    const parts = language.split(':');
    if (parts[1]?.trim()) {
      targetFile = parts[1].trim();
    }
  }

  // 2. Check first 5 lines for comment e.g. // FILE: path/to/file or # FILE: path/to/file
  const lines = rawCode.split('\n');
  for (let j = 0; j < Math.min(lines.length, 5); j++) {
    const line = lines[j].trim();
    const match = line.match(/^(?:\/\/|#|\/\*|--)\s*(?:FILE|File|file|ĐƯỜNG DẪN|Đường dẫn|filepath):\s*([^\r\n*]+?)(?:\*\/)?$/i);
    if (match && match[1]) {
      targetFile = match[1].trim();
      const codeArr = [...lines];
      codeArr.splice(j, 1);
      cleanCode = codeArr.join('\n').replace(/^\s*[\r\n]/, '');
      break;
    }
  }

  // 3. Check preceding context lines if still not detected
  if (!targetFile && precedingContext) {
    const match = precedingContext.match(/`([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,10})`/) ||
                  precedingContext.match(/(?:file|tệp|tạo|sửa|cập nhật)\s*[:`'"]*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,10})/i);
    if (match && match[1]) {
      targetFile = match[1].trim();
    }
  }

  return { targetFile, cleanCode };
}

function CodeBlock({ language, code, precedingContext, activeFile, availableFiles, onFileWritten }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [showInput, setShowInput] = useState(false);

  const { targetFile: detectedTarget, cleanCode } = parseFileTarget(language, code, precedingContext);
  const effectiveTarget = detectedTarget || activeFile || '';
  const [customPath, setCustomPath] = useState(effectiveTarget);

  const handleCopy = async () => {
    try {
      if (window.studio?.copy) {
        await window.studio.copy(cleanCode || code);
      } else {
        await navigator.clipboard.writeText(cleanCode || code);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleApply = async (destPath: string) => {
    const target = (destPath || customPath).trim();
    if (!target) {
      setShowInput(true);
      return;
    }
    if (!window.studio?.writeFile) {
      alert('Chức năng ghi file chỉ khả dụng trên ứng dụng Desktop Gemini Project Studio.');
      return;
    }
    try {
      setApplying(true);
      const res = await window.studio.writeFile(target, cleanCode);
      setApplied(true);
      setShowInput(false);
      onFileWritten?.(res.path || target);
      setTimeout(() => setApplied(false), 3000);
    } catch (err: any) {
      alert('Không thể ghi vào file: ' + (err.message || String(err)));
    } finally {
      setApplying(false);
    }
  };

  const displayLang = language.split(':')[0]?.trim() || 'code';
  const targetBasename = effectiveTarget ? effectiveTarget.split('/').pop()?.split('\\').pop() : '';

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <div className="code-block-header-left">
          <span className="code-block-lang">
            <Terminal size={12} />
            {displayLang.toUpperCase()}
          </span>
          {effectiveTarget && (
            <span
              className="code-block-target-file"
              title={`File mục tiêu: ${effectiveTarget} (Bấm để đổi file)`}
              onClick={() => setShowInput(!showInput)}
              style={{ cursor: 'pointer' }}
            >
              <FileCode size={11} />
              {effectiveTarget}
            </span>
          )}
        </div>
        <div className="code-block-actions">
          <button
            className={`code-apply-btn ${applied ? 'applied' : ''}`}
            onClick={() => {
              if (effectiveTarget && !showInput) {
                void handleApply(effectiveTarget);
              } else {
                setShowInput(!showInput);
              }
            }}
            disabled={applying}
            title={effectiveTarget ? `Vibe Coding: Áp dụng trực tiếp vào ${effectiveTarget}` : 'Chọn file để ghi trực tiếp'}
          >
            {applying ? (
              <>
                <Loader2 size={12} className="spin" />
                <span>Đang ghi...</span>
              </>
            ) : applied ? (
              <>
                <CheckCheck size={12} />
                <span>Đã ghi vào file!</span>
              </>
            ) : (
              <>
                <Zap size={12} />
                <span>{effectiveTarget ? `Ghi vào ${targetBasename}` : 'Áp dụng vào file'}</span>
              </>
            )}
          </button>
          <button
            className={`code-copy-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            title="Sao chép toàn bộ mã này"
          >
            {copied ? (
              <>
                <Check size={12} />
                <span>Đã chép!</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>Sao chép mã</span>
              </>
            )}
          </button>
        </div>
      </div>

      {showInput && (
        <div className="code-target-input-bar">
          <span>Đường dẫn file đích:</span>
          <input
            type="text"
            list="gps-files-list"
            value={customPath}
            onChange={e => setCustomPath(e.target.value)}
            placeholder="Ví dụ: src/App.tsx hoặc PharmaTask/LockScreenWidget.swift"
            onKeyDown={e => { if (e.key === 'Enter') void handleApply(customPath); }}
            autoFocus
          />
          {availableFiles && availableFiles.length > 0 && (
            <datalist id="gps-files-list">
              {availableFiles.map(f => (
                <option key={f.path} value={f.path} />
              ))}
            </datalist>
          )}
          <button className="confirm-btn" onClick={() => void handleApply(customPath)} disabled={applying}>
            Ghi file
          </button>
          <button className="cancel-btn" onClick={() => setShowInput(false)}>Hủy</button>
        </div>
      )}

      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Inline formatting helper for bold, italic, inline code, and links
function renderInline(text: string): React.ReactNode[] {
  // Regex to split inline code, bold, italic, links
  // 1: `code`
  // 2: **bold**
  // 3: *italic*
  // 4: [text](url)
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(regex);

  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={i} className="inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('[') && part.includes('](') && part.endsWith(')')) {
      const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (match) {
        return (
          <a
            key={i}
            href={match[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
          >
            {match[1]}
          </a>
        );
      }
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export function MarkdownRenderer({
  content,
  activeFile,
  availableFiles,
  onFileWritten
}: {
  content: string;
  activeFile?: string;
  availableFiles?: { path: string }[];
  onFileWritten?: (filePath: string) => void;
}) {
  if (!content) return null;

  // Split into lines and parse blocks
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced Code Block: ```lang[:path]
    if (line.trim().startsWith('```')) {
      const langMatch = line.trim().match(/^```([^\s`]+)?/);
      const language = langMatch && langMatch[1] ? langMatch[1] : '';
      const precedingLines = lines.slice(Math.max(0, i - 4), i).join(' ');
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <CodeBlock
          key={`code-${i}`}
          language={language}
          code={codeLines.join('\n')}
          precedingContext={precedingLines}
          activeFile={activeFile}
          availableFiles={availableFiles}
          onFileWritten={onFileWritten}
        />
      );
      continue;
    }

    // Markdown Table: lines with |
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const headerCols = tableLines[0]
          .split('|')
          .slice(1, -1)
          .map(c => c.trim());
        const bodyLines = tableLines.slice(2); // Skip separator row

        elements.push(
          <div key={`table-${i}`} className="md-table-container">
            <table className="md-table">
              <thead>
                <tr>
                  {headerCols.map((c, colIdx) => (
                    <th key={colIdx}>{renderInline(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyLines.map((rowStr, rowIdx) => {
                  const cols = rowStr
                    .split('|')
                    .slice(1, -1)
                    .map(c => c.trim());
                  return (
                    <tr key={rowIdx}>
                      {cols.map((colVal, cIdx) => (
                        <td key={cIdx}>{renderInline(colVal)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(<h3 key={`h3-${i}`} className="md-h3">{renderInline(line.slice(4))}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={`h2-${i}`} className="md-h2">{renderInline(line.slice(3))}</h2>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<h1 key={`h1-${i}`} className="md-h1">{renderInline(line.slice(2))}</h1>);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={`quote-${i}`} className="md-quote">
          {quoteLines.map((ql, qIdx) => (
            <p key={qIdx}>{renderInline(ql)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered List (- or *)
    if (/^\s*[-*]\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="md-ul">
          {listItems.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered List (1. )
    if (/^\s*\d+\.\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="md-ol">
          {listItems.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Horizontal Rule
    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      elements.push(<hr key={`hr-${i}`} className="md-hr" />);
      i++;
      continue;
    }

    // Empty Line
    if (!line.trim()) {
      elements.push(<div key={`empty-${i}`} className="md-space" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="md-p">
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return <div className="markdown-content">{elements}</div>;
}
