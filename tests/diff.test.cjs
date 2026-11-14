'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {unifiedDiff} = require('../desktop/diff.cjs');
const {CheckpointStore} = require('../desktop/checkpoints.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('unifiedDiff shows only changed hunks with context',()=>{
  const a=Array.from({length:30},(_,i)=>`line${i}`).join('\n')+'\n';
  const b=a.replace('line15','LINE15 changed');
  const d=unifiedDiff(a,b,{label:'f.txt'});
  assert.equal(d.changed,true);assert.equal(d.added,1);assert.equal(d.removed,1);
  assert.match(d.diff,/^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ /);
  assert.match(d.diff,/-line15\n\+LINE15 changed/);
  assert(!d.diff.includes('line0'),'far-away lines must not appear');
  assert(d.diff.includes('line12')&&d.diff.includes('line18'));
});
test('unifiedDiff handles new file, deletion, identical text and CRLF',()=>{
  const n=unifiedDiff('', 'a\nb\n');assert.equal(n.added,2);assert.equal(n.removed,0);
  const del=unifiedDiff('a\nb\n','');assert.equal(del.removed,2);
  assert.equal(unifiedDiff('same\n','same\n').changed,false);
  assert.equal(unifiedDiff('a\r\nb\r\n','a\nb\n').changed,false);
});
test('unifiedDiff stays fast on large inputs by falling back instead of O(n*m)',()=>{
  const a=Array.from({length:5000},(_,i)=>`a${i}`).join('\n'),b=Array.from({length:5000},(_,i)=>`b${i}`).join('\n');
  const t=Date.now();const d=unifiedDiff(a,b,{maxLines:50});
  assert(Date.now()-t<2000);assert.equal(d.added,5000);assert.match(d.diff,/cắt bớt/);
});

function io(root){return {
  read:rel=>{const p=path.join(root,rel);return fs.existsSync(p)?fs.readFileSync(p,'utf8'):null;},
  write:(rel,t)=>{fs.mkdirSync(path.dirname(path.join(root,rel)),{recursive:true});fs.writeFileSync(path.join(root,rel),t);},
  remove:rel=>fs.unlinkSync(path.join(root,rel))
};}
test('checkpoints restore previous content, delete created files, and refuse to clobber newer edits',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'gps-cp-'));const root=path.join(base,'proj');fs.mkdirSync(root);
  try{
    const store=new CheckpointStore(path.join(base,'store'));
    fs.writeFileSync(path.join(root,'a.txt'),'v1');
    const cp1=store.record(root,'a.txt','v1','v2',{source:'agent'});fs.writeFileSync(path.join(root,'a.txt'),'v2');
    const cp2=store.record(root,'new.txt',null,'hello',{source:'vibe'});fs.writeFileSync(path.join(root,'new.txt'),'hello');
    assert.equal(store.list(root)[0].id,cp2.id,'newest first');
    store.undo(root,cp1.id,io(root));assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'v1');
    store.undo(root,cp2.id,io(root));assert(!fs.existsSync(path.join(root,'new.txt')));
    assert.throws(()=>store.undo(root,cp1.id,io(root)),/already undone/);
    const cp3=store.record(root,'a.txt','v1','v3');fs.writeFileSync(path.join(root,'a.txt'),'v3 + manual edit');
    assert.throws(()=>store.undo(root,cp3.id,io(root)),e=>e.code==='CONFLICT');
    store.undo(root,cp3.id,io(root),{force:true});assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'v1');
    assert.throws(()=>store.undo(root,'cp_nope',io(root)),/not found/);
    assert(!fs.readdirSync(root).some(n=>n.includes('gps')),'project folder must stay clean');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
