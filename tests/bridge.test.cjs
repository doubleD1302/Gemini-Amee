'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Bridge, loadOrCreateState} = require('../desktop/bridge.cjs');

async function harness(opts){
  const bridge=new Bridge(opts);await bridge.start();
  const {url,token}=bridge.info();
  async function call(route,method='GET',body,auth=true){
    const response=await fetch(url+route,{method,headers:{...(auth?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  }
  return {bridge,call};
}

test('local HTTP bridge authenticates and relays exactly one job and final reply',async()=>{
  const {bridge,call}=await harness();
  try{
    const unauthorized=await call('/v1/next','GET',undefined,false);
    assert.equal(unauthorized.status,401);
    const job=bridge.enqueue('Explain login','Full project prompt',['src/app.ts']);
    const first=await call('/v1/next');
    assert.equal(first.data.job.id,job.id);
    assert.equal(first.data.job.prompt,'Full project prompt');
    const second=await call('/v1/next');assert.equal(second.data.job,null);
    const bad=await call('/v1/result','POST',{id:job.id,status:'bad',text:'abc'});assert.equal(bad.status,400);
    const sent=await call('/v1/result','POST',{id:job.id,status:'sent',text:'working'});assert.equal(sent.status,200);
    const completed=await call('/v1/result','POST',{id:job.id,status:'final',text:'Your answer'});assert.equal(completed.status,200);
    assert.equal(bridge.getJob(job.id).answer,'Your answer');
    const duplicate=await call('/v1/result','POST',{id:job.id,status:'error',text:'late'});assert.equal(duplicate.data.duplicate,true);
    assert.equal(bridge.getJob(job.id).status,'final');
  }finally{await bridge.stop();}
});

test('token + port persist across restarts so the extension does not need re-pairing',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gps-state-'));
  try{
    const file=path.join(dir,'sub','bridge-state.json');
    const a=loadOrCreateState(file),b=loadOrCreateState(file);
    assert.equal(a.token,b.token);assert.equal(a.port,b.port);
    assert.match(a.token,/^[0-9a-f]{64}$/);
    fs.writeFileSync(file,'{broken');
    const c=loadOrCreateState(file);assert.match(c.token,/^[0-9a-f]{64}$/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('falls back to a random port when the fixed port is busy',async()=>{
  const first=new Bridge({port:0});await first.start();
  const busy=first.port;
  const second=new Bridge({port:busy});
  try{
    await second.start();
    assert.notEqual(second.port,busy);assert.equal(second.portFallback,true);
  }finally{await second.stop();await first.stop();}
});

test('newChat/expectConversation are delivered; conversationUrl and error code are stored',async()=>{
  const {bridge,call}=await harness();
  try{
    const j=bridge.enqueue('q','p',[],{newChat:true,expectConversation:'https://gemini.google.com/app/abc123'});
    const n=await call('/v1/next');
    assert.equal(n.data.job.newChat,true);
    assert.equal(n.data.job.expectConversation,'https://gemini.google.com/app/abc123');
    await call('/v1/result','POST',{id:j.id,status:'streaming',text:'hi',conversationUrl:'https://gemini.google.com/app/xyz789'});
    assert.equal(bridge.getJob(j.id).conversationUrl,'https://gemini.google.com/app/xyz789');
    await call('/v1/result','POST',{id:j.id,status:'streaming',text:'hi2',conversationUrl:'https://evil.example/app/1'});
    assert.equal(bridge.getJob(j.id).conversationUrl,'https://gemini.google.com/app/xyz789','foreign URLs must be ignored');
    await call('/v1/result','POST',{id:j.id,status:'error',text:'mismatch',code:'conversation_mismatch'});
    assert.equal(bridge.getJob(j.id).code,'conversation_mismatch');
  }finally{await bridge.stop();}
});

test('cancel tells the extension to stop and blocks later results',async()=>{
  const {bridge,call}=await harness();
  try{
    const j=bridge.enqueue('q','p',[]);await call('/v1/next');
    assert.equal(bridge.cancel(j.id),true);
    const r=await call('/v1/result','POST',{id:j.id,status:'streaming',text:'x'});
    assert.equal(r.data.cancelled,true);
    assert.equal(bridge.getJob(j.id).status,'cancelled');
    assert.equal(bridge.cancel(j.id),false);
  }finally{await bridge.stop();}
});

test('watchdog re-queues a dispatched job once, then errors; stuck waits time out instead of hanging forever',async()=>{
  const bridge=new Bridge({dispatchTimeoutMs:100,waitTimeoutMs:100,streamIdleTimeoutMs:100,maxAttempts:2});
  const events=[];bridge.on('job',j=>events.push(j.status));
  const j=bridge.enqueue('q','p',[]);
  const job=bridge.getJob(j.id);
  // lần 1: được nhận rồi im lặng
  job.attempts++;job.dispatchedAt=Date.now()-1000;bridge.setJob(job,{status:'dispatched'});
  bridge.sweep();assert.equal(job.status,'queued');
  // lần 2: vẫn im lặng -> lỗi
  job.attempts++;job.dispatchedAt=Date.now()-1000;bridge.setJob(job,{status:'dispatched'});
  bridge.sweep();assert.equal(job.status,'error');assert.equal(job.code,'timeout');
  // đã gửi nhưng Gemini không trả lời
  const k=bridge.getJob(bridge.enqueue('q','p',[]).id);bridge.setJob(k,{status:'sent'});k.updatedAt=Date.now()-1000;
  bridge.sweep();assert.equal(k.status,'error');
  // stream đứng giữa chừng: giữ lại phần đã có
  const s=bridge.getJob(bridge.enqueue('q','p',[]).id);bridge.setJob(s,{status:'streaming',answer:'partial'});s.updatedAt=Date.now()-1000;
  bridge.sweep();assert.equal(s.status,'error');assert.equal(s.answer,'partial');
  // job đã xong không bị đụng tới
  const f=bridge.getJob(bridge.enqueue('q','p',[]).id);bridge.setJob(f,{status:'final',answer:'ok'});f.updatedAt=Date.now()-99999;
  bridge.sweep();assert.equal(f.status,'final');
});

test('requeue and manual completion go through the same job events',()=>{
  const bridge=new Bridge();const seen=[];bridge.on('job',j=>seen.push(j.status));
  const j=bridge.enqueue('q','old',[]);
  assert.equal(bridge.requeue(j.id,{prompt:'new',newChat:true}),true);
  assert.equal(bridge.getPrompt(j.id),'new');assert.equal(bridge.getJob(j.id).newChat,true);
  assert.equal(bridge.completeManually(j.id,'pasted answer'),true);
  assert.equal(bridge.getJob(j.id).status,'final');
  assert.equal(bridge.completeManually(j.id,'again'),false);
  assert.deepEqual(seen.slice(-1),['final']);
  assert.throws(()=>bridge.completeManually('nope','x'),/not found/);
});

test('browser file writes are only PROPOSALS delegated to Studio, never written directly',async()=>{
  const {bridge,call}=await harness();
  try{
    const none=await call('/v1/write-file','POST',{path:'a.ts',content:'x'});assert.equal(none.status,503);
    let received=null;
    bridge.onProposeWrite=async(p,c)=>{received={p,c};return {id:'act_1'};};
    const ok=await call('/v1/write-file','POST',{path:'src/a.ts',content:'hello'});
    assert.equal(ok.status,200);assert.equal(ok.data.pending,true);
    assert.deepEqual(received,{p:'src/a.ts',c:'hello'});
    bridge.onProposeWrite=async()=>{throw new Error('Path outside project');};
    const bad=await call('/v1/write-file','POST',{path:'../x',content:'y'});assert.equal(bad.status,400);
    assert.match(bad.data.error,/outside project/);
  }finally{await bridge.stop();}
});
