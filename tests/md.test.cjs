'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {htmlToMarkdown} = require('../extension/md.js');
const {parseToolCalls} = require('../desktop/agent-protocol.cjs');

// DOM giả tối thiểu (không cần jsdom).
function text(s){return {nodeType:3,textContent:s,childNodes:[]};}
function tc(n){return n.nodeType===3?n.textContent:n.childNodes.map(tc).join('');}
function el(tag,attrs={},...kids){
  const children=kids.map(k=>typeof k==='string'?text(k):k);
  const node={nodeType:1,tagName:tag.toUpperCase(),childNodes:children,getAttribute:n=>(n in attrs?attrs[n]:null)};
  Object.defineProperty(node,'textContent',{get:()=>children.map(tc).join('')});
  return node;
}
// Cấu trúc code-block giống Gemini: <code-block><div class="code-block-decoration"><span>lang</span><button>Copy</button></div><pre><code>..</code></pre></code-block>
const codeBlock=(lang,code)=>el('code-block',{},el('div',{class:'code-block-decoration'},el('span',{},lang),el('button',{},'Copy code')),el('div',{},el('pre',{},el('code',{class:'code-container'},el('span',{class:'tok'},code.slice(0,3)),code.slice(3)))));

test('keeps fenced code blocks with language, ignores the Copy button label',()=>{
  const md=htmlToMarkdown(el('message-content',{},el('p',{},'Xem ',el('code',{},'a.ts')),codeBlock('typescript','const x = 1;\nconsole.log(x);')));
  assert.match(md,/Xem `a\.ts`/);
  assert.match(md,/```typescript\nconst x = 1;\nconsole\.log\(x\);\n```/);
  assert.doesNotMatch(md,/Copy code/);
});

test('a gps-tool block survives the DOM round trip and parses back into a call',()=>{
  const body='tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE';
  const md=htmlToMarkdown(el('message-content',{},el('p',{},'Mình sẽ sửa:'),codeBlock('gps-tool',body)));
  const {calls,text:visible}=parseToolCalls(md);
  assert.equal(calls.length,1);assert.equal(calls[0].valid,true);
  assert.equal(calls[0].tool,'edit_file');assert.deepEqual(calls[0].args.edits,[{search:'const a = 1;',replace:'const a = 2;'}]);
  assert.match(visible,/Mình sẽ sửa:/);
});

test('a tool block still parses when Gemini shows a different label (e.g. "Text") or none',()=>{
  for(const lang of ['Text','','plaintext']){
    const md=htmlToMarkdown(el('message-content',{},codeBlock(lang,'tool: list_dir\npath: src')));
    assert.equal(parseToolCalls(md).calls.length,1,`label "${lang}"`);
  }
});

test('code that itself contains ``` gets a longer fence so it does not break',()=>{
  const inner='# T\n```js\nx\n```\nend';
  const md=htmlToMarkdown(el('div',{},codeBlock('markdown',inner)));
  assert.match(md,/````markdown\n# T\n```js\nx\n```\nend\n````/);
  const body='tool: write_file\npath: R.md\n---\n'+inner;
  const calls=parseToolCalls(htmlToMarkdown(el('div',{},codeBlock('gps-tool',body)))).calls;
  assert.equal(calls[0].args.body,inner);
});

test('headings, emphasis, links, lists (nested), quotes, tables, hr',()=>{
  const md=htmlToMarkdown(el('div',{},
    el('h2',{},'Tiêu đề'),
    el('p',{},el('strong',{},'đậm'),' và ',el('em',{},'nghiêng'),' ',el('a',{href:'https://example.com'},'liên kết'),' ',el('a',{href:'javascript:alert(1)'},'xấu')),
    el('ul',{},el('li',{},'một',el('ul',{},el('li',{},'con'))),el('li',{},'hai')),
    el('ol',{},el('li',{},'a'),el('li',{},'b')),
    el('blockquote',{},el('p',{},'trích dẫn')),
    el('table',{},el('thead',{},el('tr',{},el('th',{},'Cột 1'),el('th',{},'Cột 2'))),el('tbody',{},el('tr',{},el('td',{},'x'),el('td',{},'y|z')))),
    el('hr')));
  assert.match(md,/## Tiêu đề/);assert.match(md,/\*\*đậm\*\* và \*nghiêng\* \[liên kết\]\(https:\/\/example\.com\) xấu/);
  assert.doesNotMatch(md,/javascript:/);
  assert.match(md,/- một\n\s+- con\n- hai/);assert.match(md,/1\. a\n2\. b/);
  assert.match(md,/> trích dẫn/);
  assert.match(md,/\| Cột 1 \| Cột 2 \|\n\| --- \| --- \|\n\| x \| y\\\|z \|/);
  assert.match(md,/\n---$/);
});

test('skips buttons, icons and visually-hidden labels; collapses blank lines',()=>{
  const md=htmlToMarkdown(el('div',{},el('span',{class:'cdk-visually-hidden'},'Gemini đã nói'),el('button',{},'Sao chép'),el('mat-icon',{},'content_copy'),el('p',{},'Nội dung'),el('p',{},''),el('p',{},'Tiếp')));
  assert.equal(md,'Nội dung\n\nTiếp');
});

test('empty / null input is safe',()=>{assert.equal(htmlToMarkdown(null),'');assert.equal(htmlToMarkdown(el('div')),'');});

/* ---------- Cấu trúc THẬT của Gemini Web (khung xương chụp bằng chẩn đoán ngày 2026-11-14, giao diện tiếng Việt) ----------
   message-content > div.markdown > p/ol/ul/h3 + response-element.no-md > code-block > div.code-block > div.formatted-code-block-internal-container
   > div.animated-opacity > [div.code-block-decoration > span(nhãn) + div.buttons > gem-icon-button > button > gem-icon > mat-icon] + pre > code#code-content > span.hljs-*  */
const geminiIcon=name=>el('gem-icon-button',{},el('button',{class:'mdc-icon-button'},el('span',{class:'mat-mdc-button-persistent-ripple'}),el('gem-icon',{},el('mat-icon',{role:'img'},name)),el('span',{class:'mat-focus-indicator'})));
const realCodeBlock=(label,spans)=>el('response-element',{class:'no-md md-has-block-component'},el('code-block',{class:'enable-luminous-code-block'},el('div',{class:'code-block'},el('div',{class:'formatted-code-block-internal-container'},el('div',{class:'animated-opacity'},
  el('div',{class:'code-block-decoration header-formatted'},el('span',{},label),el('div',{class:'buttons'},geminiIcon('download'),geminiIcon('content_copy'))),
  el('pre',{},el('code',{id:'code-content',role:'text',class:'code-container formatted'},...spans)))))));
const realMessage=(label,spans)=>el('message-content',{},el('div',{class:'markdown markdown-main-panel md-content'},
  el('p',{},el('span',{},'Mình sẽ đọc file '),el('b',{},'trước'),el('span',{},':')),
  realCodeBlock(label,spans),
  el('h3',{},'Lưu ý'),
  el('ul',{},el('li',{},el('p',{},el('span',{},'Dùng '),el('code',{},'read_file'),el('span',{},' để đọc.')))),
  el('div',{class:'attachment-container unknown md-has-block-component'},el('response-element',{class:'no-md'},el('elicitations',{},el('button',{class:'elicitation-item'},'Gợi ý bấm'))))));
const toolSpans=[el('span',{class:'hljs-meta'},'tool: read_file\n'),el('span',{class:'hljs-comment'},el('span',{class:'hljs-doctag'},'path'),': src/a.ts')];

test('REAL Gemini DOM: gps-tool block keeps its fence, language and body; icon labels and buttons are dropped',()=>{
  const md=htmlToMarkdown(realMessage('gps-tool',toolSpans));
  assert.match(md,/Mình sẽ đọc file \*\*trước\*\*:/);
  assert.match(md,/```gps-tool\ntool: read_file\npath: src\/a\.ts\n```/);
  assert.doesNotMatch(md,/content_copy|download|Gợi ý bấm/);
  assert.match(md,/### Lưu ý/);
  assert.match(md,/- Dùng `read_file` để đọc\./);
  const {calls}=parseToolCalls(md);
  assert.equal(calls.length,1);assert.equal(calls[0].valid,true);
  assert.equal(calls[0].tool,'read_file');assert.equal(calls[0].args.path,'src/a.ts');
});

test('REAL Gemini DOM: the tool call is still found when Gemini rewrites the language label (case, spaces, localized)',()=>{
  for(const label of ['Gps-tool','GPS-TOOL','Văn bản thuần','Plain text','']){
    const md=htmlToMarkdown(realMessage(label,toolSpans));
    const {calls}=parseToolCalls(md);
    assert.equal(calls.length,1,'label='+JSON.stringify(label)+'\n'+md);
    assert.equal(calls[0].valid,true);
    assert.equal(calls[0].tool,'read_file');
  }
});

test('REAL Gemini DOM: hundreds of hljs spans and nested fences in code are preserved verbatim',()=>{
  const lines=Array.from({length:120},(_,i)=>'line '+i+'\n');
  const spans=[el('span',{class:'hljs-meta'},'tool: write_file\npath: README.md\n---\n'),el('span',{class:'hljs-comment'},'```js\nconsole.log(1)\n```\n'),...lines.map(l=>el('span',{class:'hljs-string'},l))];
  const md=htmlToMarkdown(realMessage('gps-tool',spans));
  assert.match(md,/````gps-tool\ntool: write_file/,'fence is longer than the inner ```');
  assert.match(md,/line 119\n````/);
  const {calls}=parseToolCalls(md);
  assert.equal(calls.length,1);assert.equal(calls[0].valid,true);assert.equal(calls[0].tool,'write_file');
  assert.match(calls[0].args.body||calls[0].args.content||'', /line 119/);
});
