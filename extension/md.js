'use strict';
/**
 * DOM -> Markdown cho câu trả lời của Gemini Web.
 * Bản cũ dùng innerText nên mất rào chắn ```; không thể nhận diện khối code/tool-call.
 * Chỉ dùng giao diện node tối thiểu (nodeType, tagName, childNodes, textContent, getAttribute)
 * để có thể kiểm thử bằng Node không cần jsdom.
 */
(function (root) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'MAT-ICON', 'SVG', 'TEXTAREA', 'INPUT']);
  const HIDDEN_CLASS = /(?:^|\s)(?:cdk-visually-hidden|sr-only|visually-hidden)(?:\s|$)/;

  const kids = n => (n && n.childNodes ? Array.from(n.childNodes) : []);
  const tag = n => (n && n.nodeType === 1 && n.tagName ? String(n.tagName).toUpperCase() : '');
  const attr = (n, name) => (n && typeof n.getAttribute === 'function' ? n.getAttribute(name) || '' : '');
  const cls = n => attr(n, 'class');

  function findFirst(node, pred) {
    for (const c of kids(node)) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) return c;
      const deep = findFirst(c, pred);
      if (deep) return deep;
    }
    return null;
  }
  function fenceFor(code) {
    let longest = 2;
    const re = /`{3,}/g;
    let m;
    while ((m = re.exec(code))) longest = Math.max(longest, m[0].length);
    return '`'.repeat(longest + 1);
  }
  function inlineCode(text) {
    const t = String(text);
    let longest = 0;
    const re = /`+/g;
    let m;
    while ((m = re.exec(t))) longest = Math.max(longest, m[0].length);
    const d = '`'.repeat(longest + 1);
    const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
    return d + pad + t + pad + d;
  }
  function codeLanguage(block) {
    const codeEl = findFirst(block, n => tag(n) === 'CODE') || block;
    const m = /(?:^|\s)language-([A-Za-z0-9_+#.-]+)/.exec(cls(codeEl) + ' ' + cls(block));
    if (m) return m[1].toLowerCase();
    const deco = findFirst(block, n => /code-block-decoration/.test(cls(n)));
    if (deco) {
      const span = findFirst(deco, n => tag(n) === 'SPAN') || deco;
      const label = (span.textContent || '').trim().toLowerCase();
      if (/^[a-z0-9_+#.-]{1,24}$/.test(label)) return label;
    }
    return '';
  }
  function renderCodeBlock(block) {
    const pre = tag(block) === 'PRE' ? block : (findFirst(block, n => tag(n) === 'PRE') || block);
    const codeEl = findFirst(pre, n => tag(n) === 'CODE') || pre;
    let code = String(codeEl.textContent || '').replace(/\r\n/g, '\n');
    code = code.replace(/^\n+/, '').replace(/\s+$/, '');
    const f = fenceFor(code);
    return `\n\n${f}${codeLanguage(block)}\n${code}\n${f}\n\n`;
  }

  function hidden(n) {
    return SKIP_TAGS.has(tag(n)) || HIDDEN_CLASS.test(cls(n)) || attr(n, 'aria-hidden') === 'true' && tag(n) !== 'SPAN';
  }

  function inline(node, ctx) {
    return kids(node).map(c => render(c, ctx)).join('');
  }
  function renderList(node, ordered, depth) {
    const items = kids(node).filter(c => tag(c) === 'LI');
    const lines = [];
    items.forEach((li, i) => {
      const prefix = ordered ? `${i + 1}. ` : '- ';
      const body = inline(li, { depth: depth + 1 }).replace(/\n{3,}/g, '\n\n').replace(/\n\n(?=\s*(?:[-*]|\d+\.) )/g, '\n').trim();
      const pad = ' '.repeat(prefix.length);
      const bodyLines = body.split('\n');
      lines.push(prefix + bodyLines[0]);
      for (let k = 1; k < bodyLines.length; k++) lines.push(bodyLines[k] === '' ? '' : pad + bodyLines[k]);
    });
    return `\n\n${lines.join('\n')}\n\n`;
  }
  function renderTable(node) {
    const rows = [];
    (function collect(n) {
      for (const c of kids(n)) {
        if (tag(c) === 'TR') rows.push(kids(c).filter(x => tag(x) === 'TH' || tag(x) === 'TD').map(x => inline(x, {}).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
        else if (c.nodeType === 1) collect(c);
      }
    })(node);
    if (!rows.length) return '';
    const width = Math.max(...rows.map(r => r.length));
    const norm = rows.map(r => { const x = r.slice(); while (x.length < width) x.push(''); return `| ${x.join(' | ')} |`; });
    norm.splice(1, 0, `| ${new Array(width).fill('---').join(' | ')} |`);
    return `\n\n${norm.join('\n')}\n\n`;
  }

  function render(node, ctx) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const t = tag(node);
    if (hidden(node)) return '';
    if (t === 'CODE-BLOCK' || t === 'PRE') return renderCodeBlock(node);
    if (/^H[1-6]$/.test(t)) return `\n\n${'#'.repeat(Number(t[1]))} ${inline(node, ctx).trim()}\n\n`;
    switch (t) {
      case 'P': return `\n\n${inline(node, ctx).trim()}\n\n`;
      case 'BR': return '\n';
      case 'HR': return '\n\n---\n\n';
      case 'UL': return renderList(node, false, (ctx && ctx.depth) || 0);
      case 'OL': return renderList(node, true, (ctx && ctx.depth) || 0);
      case 'BLOCKQUOTE': return `\n\n${inline(node, ctx).trim().split('\n').map(l => '> ' + l).join('\n')}\n\n`;
      case 'TABLE': return renderTable(node);
      case 'STRONG': case 'B': { const s = inline(node, ctx).trim(); return s ? `**${s}**` : ''; }
      case 'EM': case 'I': { const s = inline(node, ctx).trim(); return s ? `*${s}*` : ''; }
      case 'CODE': return inlineCode(node.textContent || '');
      case 'A': {
        const href = attr(node, 'href');
        const text = inline(node, ctx).trim();
        return /^https?:\/\//i.test(href) && text ? `[${text}](${href})` : text;
      }
      case 'DIV': case 'SECTION': case 'ARTICLE': case 'MESSAGE-CONTENT': case 'LI':
        return inline(node, ctx) + '\n';
      default: {
        const math = attr(node, 'data-math');
        if (math) return `$${math}$`;
        return inline(node, ctx);
      }
    }
  }

  function htmlToMarkdown(el) {
    if (!el) return '';
    let out = render(el, { depth: 0 });
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out;
  }

  root.__gpsHtmlToMarkdown = htmlToMarkdown;
  if (typeof module !== 'undefined' && module.exports) module.exports = { htmlToMarkdown };
})(typeof globalThis !== 'undefined' ? globalThis : this);
