'use strict';
const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {scanProject, readProjectFile, writeProjectFile, searchProject, buildContext} = require('../desktop/workspace.cjs');
let roots = [];
afterEach(()=>{for(const p of roots)fs.rmSync(p,{recursive:true,force:true});roots=[];});
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gps-test-'));roots.push(dir);
  fs.mkdirSync(path.join(dir,'src'));
  fs.mkdirSync(path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'src','app.ts'),'export function loginUser() { return "ok"; }\n');
  fs.writeFileSync(path.join(dir,'src','utils.ts'),'export const VERSION = 3;\n');
  fs.writeFileSync(path.join(dir,'package.json'),'{"name":"demo"}');
  fs.writeFileSync(path.join(dir,'.env'),'JWT_SECRET=do-not-expose');
  fs.writeFileSync(path.join(dir,'config.pem'),'PRIVATE KEY');
  fs.writeFileSync(path.join(dir,'node_modules','leak.js'),'IGNORE');
  return dir;
}
test('indexes normal project files but skips credentials, artifacts and dependencies',()=>{
  const dir=fixture();const index=scanProject(dir);const paths=index.files.map(f=>f.path);
  assert(paths.includes('src/app.ts'));assert(paths.includes('package.json'));
  assert(!paths.includes('.env'));assert(!paths.includes('config.pem'));
  assert(!paths.some(p=>p.startsWith('node_modules/')));
});
test('rejects escape paths, secrets and symlink file references',()=>{
  const dir=fixture();const outside=path.join(os.tmpdir(),'gps-outside.txt');fs.writeFileSync(outside,'secret');
  try{
    assert.throws(()=>readProjectFile(dir,'../gps-outside.txt'),/outside project/);
    assert.throws(()=>readProjectFile(dir,'.env'),/excluded/);
    assert.throws(()=>readProjectFile(dir,'node_modules/leak.js'),/excluded/);
    try {
      fs.symlinkSync(outside,path.join(dir,'src','link.ts'));
      assert.throws(()=>readProjectFile(dir,'src/link.ts'),/not a regular/);
    } catch (error) {
      if (!['EPERM','EACCES'].includes(error.code)) throw error; // Windows without Developer Mode may forbid symlink creation
    }
  }finally{fs.rmSync(outside,{force:true});}
});
test('reads source and finds text with a line number',()=>{
  const dir=fixture();
  const result=readProjectFile(dir,'src/app.ts');
  assert.match(result.content,/loginUser/);
  const matches=searchProject(dir,'loginUser');
  assert(matches.some(m=>m.path==='src/app.ts'&&m.line===1));
});
test('creates a bounded, read-only project prompt and prioritizes active file',()=>{
  const dir=fixture();
  const result=buildContext(dir,'Explain loginUser', {activePath:'src/app.ts',maxFiles:2,maxCharacters:1000});
  assert(result.included.includes('src/app.ts'));
  assert.match(result.prompt,/READ-ONLY snapshot/);
  assert.match(result.prompt,/USER QUESTION:\nExplain loginUser/);
  assert.doesNotMatch(result.prompt,/do-not-expose|PRIVATE KEY/);
  assert(result.included.length<=2);
});
test('creates streamlined follow-up prompt without re-dumping entire file tree',()=>{
  const dir=fixture();
  const followUp=buildContext(dir,'How to call loginUser?', {activePath:'src/app.ts',isFollowUp:true});
  assert.match(followUp.prompt,/CONTINUING CONVERSATION/);
  assert.match(followUp.prompt,/USER QUESTION:\nHow to call loginUser\?/);
  assert.doesNotMatch(followUp.prompt,/FILE TREE:/);
});
test('writes to project file safely, returns previous content, never pollutes the project, blocks private files',()=>{
  const dir=fixture();
  const updateRes = writeProjectFile(dir, 'src/app.ts', 'export function loginUserV2() { return "v2"; }');
  assert.equal(updateRes.path, 'src/app.ts');
  assert.match(updateRes.previous, /loginUser\(\)/);
  assert.equal(updateRes.created, false);
  assert(!fs.existsSync(path.join(dir,'.gps_backups')), 'no backup folder must be created inside the project');
  assert.deepEqual(fs.readdirSync(path.join(dir,'src')).filter(n=>n.includes('gps-tmp')), []);
  const updatedContent = readProjectFile(dir, 'src/app.ts').content;
  assert.match(updatedContent, /loginUserV2/);

  const newRes = writeProjectFile(dir, 'src/widgets/lock.ts', 'export const widget = true;');
  assert.equal(newRes.created, true);
  assert.equal(newRes.previous, null);
  assert.match(readProjectFile(dir, 'src/widgets/lock.ts').content, /widget = true/);

  assert.throws(() => writeProjectFile(dir, '.env', 'BAD'), /excluded/);
  assert.throws(() => writeProjectFile(dir, '../outside.ts', 'BAD'), /outside project/);
  assert.throws(() => writeProjectFile(dir, '.git/hooks/pre-commit', 'BAD'), /excluded/);
});
test('refuses to write through a symlinked directory that points outside the project',()=>{
  const dir=fixture();
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'gps-outside-dir-'));roots.push(outside);
  try{
    try { fs.symlinkSync(outside,path.join(dir,'escape'),'junction'); }
    catch (error) { if (['EPERM','EACCES'].includes(error.code)) return; throw error; }
    assert.throws(()=>writeProjectFile(dir,'escape/pwned.ts','x'),/outside project/);
    assert.throws(()=>writeProjectFile(dir,'escape/deep/pwned.ts','x'),/outside project/);
    assert(!fs.existsSync(path.join(outside,'pwned.ts')));
  }finally{ /* cleanup via afterEach */ }
});
test('removeProjectFile deletes only regular files inside the project',()=>{
  const dir=fixture();
  const {removeProjectFile}=require('../desktop/workspace.cjs');
  removeProjectFile(dir,'src/utils.ts');
  assert(!fs.existsSync(path.join(dir,'src','utils.ts')));
  assert.throws(()=>removeProjectFile(dir,'../x'),/outside project/);
});
test('honours the root .gitignore (dirs, globs, negation) when indexing',()=>{
  const dir=fixture();
  fs.writeFileSync(path.join(dir,'.gitignore'),'generated/\n*.log.ts\n/secret-notes.md\n!keep.log.ts\n# comment\n');
  fs.mkdirSync(path.join(dir,'generated'));
  fs.writeFileSync(path.join(dir,'generated','big.ts'),'export const g = 1;');
  fs.writeFileSync(path.join(dir,'src','debug.log.ts'),'x');
  fs.writeFileSync(path.join(dir,'src','keep.log.ts'),'y');
  fs.writeFileSync(path.join(dir,'secret-notes.md'),'z');
  const paths=scanProject(dir,true).files.map(f=>f.path);
  assert(!paths.some(p=>p.startsWith('generated/')));
  assert(!paths.includes('src/debug.log.ts'));
  assert(paths.includes('src/keep.log.ts'));
  assert(!paths.includes('secret-notes.md'));
  assert(paths.includes('src/app.ts'));
});
test('extractTerms understands Vietnamese and camelCase, so non-ASCII questions still rank files',()=>{
  const {extractTerms}=require('../desktop/workspace.cjs');
  const t=extractTerms('Giải thích chức năng đăng nhập trong loginUser');
  assert(t.includes('đăng'));assert(t.includes('nhập'));assert(t.includes('login'));assert(t.includes('user'));
});
test('buildContext boosts files whose CONTENT matches and files named in the question',()=>{
  const dir=fixture();
  for(let i=0;i<30;i++) fs.writeFileSync(path.join(dir,'src',`filler${i}.ts`),`export const f${i} = ${i};\n`);
  fs.writeFileSync(path.join(dir,'src','zzz-auth.ts'),'// xử lý đăng nhập\nexport function dangNhap(){ return "xử lý đăng nhập"; }\n');
  const byContent=buildContext(dir,'đăng nhập bị lỗi',{maxFiles:3,maxCharacters:5000});
  assert(byContent.included.includes('src/zzz-auth.ts'),'content match should surface the file');
  const byName=buildContext(dir,'xem giúp tôi file src/filler7.ts',{maxFiles:2,maxCharacters:5000});
  assert(byName.included.includes('src/filler7.ts'));
});
test('marks truncated files and documents the real limits',()=>{
  const dir=fixture();
  fs.writeFileSync(path.join(dir,'src','long.ts'),'x'.repeat(5000));
  const r=buildContext(dir,'long.ts',{activePath:'src/long.ts',maxFiles:1,maxCharacters:1000});
  assert.match(r.prompt,/TRUNCATED/);
  const {limits}=require('../desktop/workspace.cjs');
  assert.equal(limits.CONTEXT_DEFAULT_FILES,12);
});
test('grepProject is async, supports regex/prefix/limits and reports filename matches',async()=>{
  const {grepProject}=require('../desktop/workspace.cjs');
  const dir=fixture();
  const a=await grepProject(dir,'loginUser');
  assert(a.some(m=>m.path==='src/app.ts'&&m.line===1));
  const b=await grepProject(dir,'^export (const|function)',{regex:true});
  assert(b.length>=2);
  const c=await grepProject(dir,'VERSION',{pathPrefix:'src'});
  assert(c.every(m=>m.path.startsWith('src/')));
  await assert.rejects(()=>grepProject(dir,'(',{regex:true}),/Invalid regex/);
  const d=await grepProject(dir,'export',{max:1});
  assert.equal(d.length,1);
});
