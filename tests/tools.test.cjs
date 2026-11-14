'use strict';
const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {TOOLS} = require('../desktop/tools.cjs');
const {CheckpointStore} = require('../desktop/checkpoints.cjs');

let cleanup=[];afterEach(()=>{for(const p of cleanup)fs.rmSync(p,{recursive:true,force:true});cleanup=[];});
function setup(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'gps-tools-'));cleanup.push(base);
  const root=path.join(base,'proj');fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','a.ts'),'export const a = 1;\nexport function hello() {\n  return "hi";\n}\n');
  fs.writeFileSync(path.join(root,'src','crlf.ts'),'line1\r\nline2\r\nline3\r\n');
  fs.writeFileSync(path.join(root,'.env'),'SECRET=1');
  const checkpoints=new CheckpointStore(path.join(base,'cp'));
  return {root,checkpoints,ctx:{root,checkpoints,source:'agent'}};
}
const run=async(name,ctx,args)=>{const t=TOOLS[name];t.prepare(ctx,args);return t.run(ctx,args);};

test('read_file returns numbered lines, honours ranges, and blocks secrets / escapes',async()=>{
  const {ctx}=setup();
  const all=await run('read_file',ctx,{path:'src/a.ts'});
  assert.match(all.output,/FILE src\/a\.ts · dòng 1-4 \/ 4/);assert.match(all.output,/2 \| export function hello/);
  const part=await run('read_file',ctx,{path:'src/a.ts',start_line:'2',end_line:'3'});
  assert.match(part.output,/dòng 2-3/);assert.doesNotMatch(part.output,/export const a/);
  await assert.rejects(()=>run('read_file',ctx,{path:'.env'}),/excluded/);
  await assert.rejects(()=>run('read_file',ctx,{path:'../etc/passwd'}),/outside project/);
  assert.throws(()=>TOOLS.read_file.prepare(ctx,{}),/path/);
});
test('read_file paginates long files',async()=>{
  const {ctx,root}=setup();
  fs.writeFileSync(path.join(root,'src','long.ts'),Array.from({length:1000},(_,i)=>`l${i}`).join('\n'));
  const r=await run('read_file',ctx,{path:'src/long.ts'});
  assert.match(r.output,/dòng 1-400 \/ 1000/);assert.match(r.output,/start_line/);
  const r2=await run('read_file',ctx,{path:'src/long.ts',start_line:'401'});assert.match(r2.output,/dòng 401-800/);
});
test('list_dir and grep work and respect exclusions',async()=>{
  const {ctx}=setup();
  const l=await run('list_dir',ctx,{});assert.match(l.output,/src\//);assert.match(l.output,/src\/a\.ts/);assert.doesNotMatch(l.output,/\.env/);
  await assert.rejects(()=>run('list_dir',ctx,{path:'nope'}),/Không có gì/);
  const g=await run('grep',ctx,{pattern:'hello'});assert.match(g.output,/src\/a\.ts:2: export function hello/);
  const none=await run('grep',ctx,{pattern:'zzzzzz'});assert.match(none.output,/Không có kết quả/);
  const re=await run('grep',ctx,{pattern:'^export const',regex:'true'});assert.match(re.output,/a\.ts:1/);
  assert.throws(()=>TOOLS.grep.prepare(ctx,{pattern:'  '}),/pattern/);
});
test('write_file previews a diff, then writes and records a checkpoint',async()=>{
  const {ctx,root,checkpoints}=setup();
  const prepNew=TOOLS.write_file.prepare(ctx,{path:'src/new.ts',body:'export const n = 1;'});
  assert.equal(prepNew.created,true);assert.match(prepNew.diff,/\+export const n = 1;/);
  assert(!fs.existsSync(path.join(root,'src','new.ts')),'prepare must have no side effects');
  const r=await TOOLS.write_file.run(ctx,{path:'src/new.ts',body:'export const n = 1;'});
  assert.equal(fs.readFileSync(path.join(root,'src','new.ts'),'utf8'),'export const n = 1;\n');
  assert(r.checkpoint);assert.equal(checkpoints.list(root)[0].created,true);
  const prepOver=TOOLS.write_file.prepare(ctx,{path:'src/a.ts',body:'export const a = 2;\n'});
  assert.match(prepOver.summary,/Ghi đè/);
  assert.throws(()=>TOOLS.write_file.prepare(ctx,{path:'src/a.ts',body:fs.readFileSync(path.join(root,'src','a.ts'),'utf8')}),/giống hệt/);
  assert.throws(()=>TOOLS.write_file.prepare(ctx,{path:'src/x.ts'}),/Thiếu nội dung/);
  assert.throws(()=>TOOLS.write_file.prepare(ctx,{path:'.env',body:'x'}),/excluded/);
});
test('write_file keeps CRLF line endings of the existing file',async()=>{
  const {ctx,root}=setup();
  await TOOLS.write_file.run(ctx,{path:'src/crlf.ts',body:'line1\nCHANGED\nline3\n'});
  assert.equal(fs.readFileSync(path.join(root,'src','crlf.ts'),'utf8'),'line1\r\nCHANGED\r\nline3\r\n');
});
test('edit_file: exact match, multiple hunks, checkpoint + undo',async()=>{
  const {ctx,root,checkpoints}=setup();
  const args={path:'src/a.ts',edits:[{search:'export const a = 1;',replace:'export const a = 2;'},{search:'  return "hi";',replace:'  return "hello";'}]};
  const prep=TOOLS.edit_file.prepare(ctx,args);
  assert.match(prep.diff,/-export const a = 1;/);assert.match(prep.diff,/\+  return "hello";/);
  assert.equal(fs.readFileSync(path.join(root,'src','a.ts'),'utf8').includes('a = 1'),true,'prepare is side-effect free');
  const r=await TOOLS.edit_file.run(ctx,args);
  assert.match(fs.readFileSync(path.join(root,'src','a.ts'),'utf8'),/a = 2[\s\S]*"hello"/);
  const {CheckpointStore:CS}=require('../desktop/checkpoints.cjs');
  checkpoints.undo(root,r.checkpoint,{read:rel=>fs.readFileSync(path.join(root,rel),'utf8'),write:(rel,t)=>fs.writeFileSync(path.join(root,rel),t),remove:()=>{}});
  assert.match(fs.readFileSync(path.join(root,'src','a.ts'),'utf8'),/a = 1/);void CS;
});
test('edit_file: tolerant of trailing-whitespace/blank-line differences, strict about ambiguity and misses',async()=>{
  const {ctx,root}=setup();
  fs.writeFileSync(path.join(root,'src','dup.ts'),'foo();\nbar();\nfoo();\n');
  assert.throws(()=>TOOLS.edit_file.prepare(ctx,{path:'src/dup.ts',edits:[{search:'foo();',replace:'baz();'}]}),/khớp 2 chỗ/);
  await TOOLS.edit_file.run(ctx,{path:'src/dup.ts',replace_all:'true',edits:[{search:'foo();',replace:'baz();'}]});
  assert.equal(fs.readFileSync(path.join(root,'src','dup.ts'),'utf8'),'baz();\nbar();\nbaz();\n');
  // khoảng trắng cuối dòng + dòng trống thừa ở đầu/cuối SEARCH
  await TOOLS.edit_file.run(ctx,{path:'src/a.ts',edits:[{search:'\nexport function hello() {   \n  return "hi";\n}\n',replace:'export function hello() {\n  return "yo";\n}'}]});
  assert.match(fs.readFileSync(path.join(root,'src','a.ts'),'utf8'),/return "yo";/);
  assert.throws(()=>TOOLS.edit_file.prepare(ctx,{path:'src/a.ts',edits:[{search:'does not exist',replace:'x'}]}),/Không tìm thấy/);
  assert.throws(()=>TOOLS.edit_file.prepare(ctx,{path:'src/missing.ts',edits:[{search:'a',replace:'b'}]}),/không tồn tại/);
  assert.throws(()=>TOOLS.edit_file.prepare(ctx,{path:'src/a.ts',edits:[{search:'   ',replace:'b'}]}),/rỗng/);
  assert.throws(()=>TOOLS.edit_file.prepare(ctx,{path:'src/a.ts'}),/SEARCH/);
});
test('edit_file preserves CRLF',async()=>{
  const {ctx,root}=setup();
  await TOOLS.edit_file.run(ctx,{path:'src/crlf.ts',edits:[{search:'line2',replace:'LINE-TWO'}]});
  assert.equal(fs.readFileSync(path.join(root,'src','crlf.ts'),'utf8'),'line1\r\nLINE-TWO\r\nline3\r\n');
});
test('run_command captures output/exit code, times out, and can be aborted',async()=>{
  const {ctx}=setup();
  const ok=await run('run_command',ctx,{command:`node -e "console.log('xin chào'); console.error('warn')"`});
  assert.equal(ok.ok,true);assert.match(ok.output,/Exit code: 0/);assert.match(ok.output,/xin chào/);assert.match(ok.output,/warn/);
  const bad=await run('run_command',ctx,{command:`node -e "process.exit(3)"`});
  assert.equal(bad.ok,false);assert.match(bad.output,/Exit code: 3/);
  const slow=await run('run_command',ctx,{command:`node -e "setTimeout(()=>{},20000)"`,timeout_sec:'1'});
  assert.equal(slow.ok,false);assert.match(slow.output,/bị dừng/);
  const ac=new AbortController();setTimeout(()=>ac.abort(),300);
  const aborted=await TOOLS.run_command.run({...ctx,signal:ac.signal},{command:`node -e "setTimeout(()=>{},20000)"`});
  assert.match(aborted.output,/bị dừng/);
  assert.throws(()=>TOOLS.run_command.prepare(ctx,{}),/command/);
});
test('tool kinds: only reads auto-run; edits and commands require approval',()=>{
  assert.deepEqual(Object.fromEntries(Object.values(TOOLS).map(t=>[t.name,t.kind])),{read_file:'read',list_dir:'read',grep:'read',search_code:'read',write_file:'edit',edit_file:'edit',run_command:'exec',git_status:'read',git_diff:'read',git_commit:'exec',plan:'control',finish:'control',ask_user:'control'});
});
