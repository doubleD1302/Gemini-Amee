'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseToolCalls,formatToolResults,fenceFor,buildSystemPrompt,buildKickoff,buildRecap} = require('../desktop/agent-protocol.cjs');
const BT='`';const F=BT.repeat(3);const F4=BT.repeat(4);

test('parses header-only tool calls and strips them from the visible text',()=>{
  const md=`Mình sẽ đọc file trước.\n\n${F}gps-tool\ntool: read_file\npath: src/App.tsx\nstart_line: 10\n${F}\n\nXong.`;
  const {calls,text}=parseToolCalls(md);
  assert.equal(calls.length,1);
  assert.equal(calls[0].tool,'read_file');
  assert.deepEqual(calls[0].args,{path:'src/App.tsx',start_line:'10'});
  assert.equal(calls[0].valid,true);
  assert.match(text,/Mình sẽ đọc file trước\./);assert.doesNotMatch(text,/read_file/);assert.match(text,/Xong\./);
});

test('write_file body is raw (no JSON escaping) and may contain header-looking and JSON-looking lines',()=>{
  const md=`${F}gps-tool\ntool: write_file\npath: config.yml\n---\nname: demo\n{"a": "b\\n"}\nconsole.log("\\"quoted\\"");\n${F}`;
  const {calls}=parseToolCalls(md);
  assert.equal(calls[0].args.path,'config.yml');
  assert.equal(calls[0].args.body,'name: demo\n{"a": "b\\n"}\nconsole.log("\\"quoted\\"");');
});

test('a longer outer fence lets file content contain triple backticks',()=>{
  const md=`${F4}gps-tool\ntool: write_file\npath: README.md\n---\n# Title\n${F}js\nconst x = 1;\n${F}\nend\n${F4}`;
  const {calls}=parseToolCalls(md);
  assert.equal(calls.length,1);assert.equal(calls[0].valid,true);
  assert.match(calls[0].args.body,/```js\nconst x = 1;\n```\nend$/);
});

test('parses multiple SEARCH/REPLACE hunks',()=>{
  const md=`${F}gps-tool\ntool: edit_file\npath: a.ts\nreplace_all: true\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nfoo()\n=======\nbar()\nbaz()\n>>>>>>> REPLACE\n${F}`;
  const {calls}=parseToolCalls(md);
  assert.equal(calls[0].args.replace_all,'true');
  assert.deepEqual(calls[0].args.edits,[{search:'const a = 1;',replace:'const a = 2;'},{search:'foo()',replace:'bar()\nbaz()'}]);
});

test('detects tool blocks even when Gemini changes or drops the language label',()=>{
  for(const info of ['','text','json','GPS-TOOL']){
    const {calls}=parseToolCalls(`${F}${info}\ntool: list_dir\npath: src\n${F}`);
    assert.equal(calls.length,1,`info="${info}"`);assert.equal(calls[0].tool,'list_dir');
  }
});

test('ignores ordinary code blocks and tool examples nested inside another fence',()=>{
  const md=`${F}js\nconsole.log(1)\n${F}\n\n${F4}markdown\nVí dụ:\n${F}gps-tool\ntool: run_command\ncommand: rm -rf /\n${F}\n${F4}`;
  const {calls}=parseToolCalls(md);
  assert.equal(calls.length,0,'nothing inside a non-tool fence may run');
});

test('a truncated (unclosed) block is reported invalid and must not run',()=>{
  const {calls}=parseToolCalls(`${F}gps-tool\ntool: write_file\npath: a.ts\n---\nhalf a fi`);
  assert.equal(calls.length,1);assert.equal(calls[0].valid,false);assert.match(calls[0].error,/cắt/);
  const hunk=parseToolCalls(`${F}gps-tool\ntool: edit_file\npath: a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n${F}`).calls[0];
  assert.equal(hunk.valid,false);assert.match(hunk.error,/REPLACE/);
});

test('keeps call order and handles CRLF input',()=>{
  const md=`${F}gps-tool\r\ntool: grep\r\npattern: foo\r\n${F}\r\n${F}gps-tool\r\ntool: finish\r\n---\r\ndone\r\n${F}`;
  const {calls}=parseToolCalls(md);
  assert.deepEqual(calls.map(c=>c.tool),['grep','finish']);
  assert.equal(calls[0].args.pattern,'foo');assert.equal(calls[1].args.body,'done');
});

test('formatToolResults labels results as data and survives backticks in output',()=>{
  const out=formatToolResults([{tool:'read_file',status:'ok',label:'a.md',output:'```js\nx\n```'},{tool:'run_command',status:'failed',label:'npm test',output:'boom'}]);
  assert.match(out,/DỮ LIỆU/);assert.match(out,/\[TOOL RESULT 1\/2\] tool=read_file status=ok target=a\.md/);
  assert.match(out,/````text\n```js/);
  assert.equal(fenceFor('no ticks'),'```');assert.equal(fenceFor('``` and ````'),'`````');
});

test('formatToolResults truncates huge outputs with a marker',()=>{
  const out=formatToolResults([{tool:'run_command',status:'ok',output:'x'.repeat(200000)}],{maxChars:5000});
  assert(out.length<9000);assert.match(out,/đã cắt/);
});

test('system prompt documents every tool and the safety rules',()=>{
  const {specs}=require('../desktop/tools.cjs');
  const sys=buildSystemPrompt({specs:specs(),projectName:'demo',tree:'a.ts',fileCount:1,truncated:false});
  for(const n of ['read_file','list_dir','grep','write_file','edit_file','run_command','finish','ask_user']) assert.match(sys,new RegExp('### '+n));
  assert.match(sys,/không đáng tin/);assert.match(sys,/gps-tool/);
  assert.match(buildKickoff({systemPrompt:sys,goal:'Sửa lỗi X'}),/NHIỆM VỤ CỦA NGƯỜI DÙNG\nSửa lỗi X/);
  const recap=buildRecap({systemPrompt:sys,goal:'G',steps:['a','b'],followUp:'tiếp đi'});
  assert.match(recap,/TIẾN ĐỘ ĐÃ LÀM/);assert.match(recap,/- b/);assert.match(recap,/tiếp đi/);
});
