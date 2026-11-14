'use strict';
const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workspace = require('../desktop/workspace.cjs');
const tools = require('../desktop/tools.cjs');
const {Bridge} = require('../desktop/bridge.cjs');
const {CheckpointStore} = require('../desktop/checkpoints.cjs');
const {AgentRunner} = require('../desktop/agent.cjs');
const BT='`';const F=BT.repeat(3);
const call=(body)=>`${F}gps-tool\n${body}\n${F}`;

let cleanup=[];afterEach(()=>{for(const p of cleanup)fs.rmSync(p,{recursive:true,force:true});cleanup=[];});

/** Dựng runner + một "Gemini giả" trả lời theo kịch bản. */
function setup(script, opts={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'gps-agent-'));cleanup.push(base);
  const root=path.join(base,'proj');fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','a.ts'),'export const a = 1;\n');
  const bridge=new Bridge();
  const runner=new AgentRunner({bridge,workspace,tools,checkpoints:new CheckpointStore(path.join(base,'cp')),getRoot:()=>root,maxTurns:opts.maxTurns});
  const turns=[];let convCounter=0;
  bridge.on('job',pub=>{
    if(pub.status!=='queued'||pub.kind!=='agent')return;
    const job=bridge.getJob(pub.id);
    const info={prompt:job.prompt,newChat:job.newChat,expectConversation:job.expectConversation,id:job.id};
    turns.push(info);
    setImmediate(async()=>{
      if(job.status==='cancelled')return;
      const out=await script(info,turns.length-1);
      if(out==null)return;                       // giả lập Gemini im lặng
      if(job.status==='cancelled')return;
      const reply=typeof out==='string'?{answer:out}:out;
      const url=reply.conversationUrl!==undefined?reply.conversationUrl:`https://gemini.google.com/app/conv${job.newChat?++convCounter:convCounter}`;
      bridge.setJob(job,{status:reply.status||'final',answer:reply.answer,code:reply.code||'',conversationUrl:url});
    });
  });
  return {root,bridge,runner,turns,file:rel=>fs.readFileSync(path.join(root,rel),'utf8')};
}
function until(runner,pred,ms=4000){
  return new Promise((resolve,reject)=>{
    const check=()=>{const s=runner.snapshot();if(pred(s)){runner.removeListener('state',check);clearTimeout(t);resolve(s);}};
    const t=setTimeout(()=>{runner.removeListener('state',check);reject(new Error('timeout; status='+runner.snapshot().status+' steps='+JSON.stringify(runner.snapshot().steps.slice(-3))));},ms);
    runner.on('state',check);check();
  });
}

test('end to end: read -> edit (needs approval) -> finish, with continuity and checkpoint',async()=>{
  const env=setup(async(t,i)=>{
    if(i===0)return `Đọc file trước.\n${call('tool: read_file\npath: src/a.ts')}`;
    if(i===1)return `Sửa giá trị.\n${call('tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE')}`;
    return call('tool: finish\n---\nĐã đổi a thành 2.');
  });
  env.runner.start('Đổi a thành 2');
  const waiting=await until(env.runner,s=>s.status==='waiting_approval');
  assert.equal(waiting.pending.length,1);
  assert.equal(waiting.pending[0].tool,'edit_file');assert.match(waiting.pending[0].diff,/\+export const a = 2;/);
  assert.equal(env.file('src/a.ts'),'export const a = 1;\n','nothing is written before approval');
  await env.runner.approve(waiting.pending[0].id,'approve');
  const done=await until(env.runner,s=>s.status==='done');
  assert.equal(env.file('src/a.ts'),'export const a = 2;\n');
  // Giao thức & liên tục cuộc trò chuyện
  assert.equal(env.turns.length,3);
  assert.equal(env.turns[0].newChat,true);assert.match(env.turns[0].prompt,/### edit_file/);assert.match(env.turns[0].prompt,/Đổi a thành 2/);
  assert.equal(env.turns[1].newChat,false);assert.equal(env.turns[1].expectConversation,'https://gemini.google.com/app/conv1');
  assert.match(env.turns[1].prompt,/\[TOOL RESULT 1\/1\] tool=read_file/);assert.match(env.turns[1].prompt,/1 \| export const a = 1;/);
  assert.match(env.turns[2].prompt,/OK: đã sửa src\/a\.ts/);
  assert.equal(done.conversationUrl,'https://gemini.google.com/app/conv1');
  assert(done.steps.some(s=>s.type==='tool'&&s.tool==='finish'&&/a thành 2/.test(s.text)));
  // hoàn tác
  const cps=env.runner.listCheckpoints();assert.equal(cps.length,1);
  env.runner.undo(cps[0].id);assert.equal(env.file('src/a.ts'),'export const a = 1;\n');
});

test('rejecting an edit leaves the file untouched and tells Gemini not to repeat it',async()=>{
  const env=setup(async(t,i)=>{
    if(i===0)return call('tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 99;\n>>>>>>> REPLACE');
    return call('tool: finish\n---\nOK, giữ nguyên.');
  });
  env.runner.start('x');
  const w=await until(env.runner,s=>s.status==='waiting_approval');
  await env.runner.approve(w.pending[0].id,'reject','không muốn');
  await until(env.runner,s=>s.status==='done');
  assert.equal(env.file('src/a.ts'),'export const a = 1;\n');
  assert.match(env.turns[1].prompt,/status=rejected/);assert.match(env.turns[1].prompt,/TỪ CHỐI/);assert.match(env.turns[1].prompt,/không muốn/);
});

test('run_command ALWAYS needs approval, even with auto-approve edits on; auto-approve cannot be granted from a command',async()=>{
  const env=setup(async(t,i)=>i===0?call('tool: run_command\ncommand: node -e "console.log(40+2)"'):call('tool: finish\n---\nxong'));
  env.runner.setPolicy({autoEdits:true});
  env.runner.start('chạy thử');
  const w=await until(env.runner,s=>s.status==='waiting_approval');
  assert.equal(w.pending[0].kind,'exec');
  await assert.rejects(()=>env.runner.approve(w.pending[0].id,'approve_all_edits'),/chỉ.*sửa file/i);
  await env.runner.approve(w.pending[0].id,'approve');
  await until(env.runner,s=>s.status==='done');
  assert.match(env.turns[1].prompt,/Exit code: 0/);assert.match(env.turns[1].prompt,/42/);
});

test('auto-approve edits applies edits without prompting; "approve_all_edits" flips the policy',async()=>{
  const edit=(from,to)=>call(`tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`);
  const env=setup(async(t,i)=>i===0?edit('a = 1','a = 2'):i===1?edit('a = 2','a = 3'):call('tool: finish\n---\nok'));
  env.runner.start('x');
  const w=await until(env.runner,s=>s.status==='waiting_approval');
  await env.runner.approve(w.pending[0].id,'approve_all_edits');
  assert.equal(env.runner.snapshot().policy.autoEdits,true);
  await until(env.runner,s=>s.status==='done');
  assert.equal(env.file('src/a.ts'),'export const a = 3;\n','second edit applied with no prompt');
});

test('a failing step halts later mutations in the same message but still runs reads',async()=>{
  const env=setup(async(t,i)=>{
    if(i===0)return [call('tool: edit_file\npath: src/a.ts\n<<<<<<< SEARCH\nNOPE\n=======\nx\n>>>>>>> REPLACE'),call('tool: write_file\npath: src/b.ts\n---\nshould not exist'),call('tool: read_file\npath: src/a.ts')].join('\n');
    return call('tool: finish\n---\nok');
  });
  env.runner.setPolicy({autoEdits:true});
  env.runner.start('x');await until(env.runner,s=>s.status==='done');
  assert(!fs.existsSync(path.join(env.root,'src','b.ts')));
  const p=env.turns[1].prompt;
  assert.match(p,/tool=edit_file status=error/);assert.match(p,/tool=write_file status=skipped/);assert.match(p,/tool=read_file status=ok/);
});

test('unknown tools, truncated blocks and paths outside the project never execute',async()=>{
  const env=setup(async(t,i)=>{
    if(i===0)return [call('tool: delete_everything\npath: .'),call('tool: read_file\npath: ../../etc/passwd'),`${F}gps-tool\ntool: write_file\npath: src/c.ts\n---\ncut off`].join('\n');
    return call('tool: finish\n---\nok');
  });
  env.runner.setPolicy({autoEdits:true});
  env.runner.start('x');await until(env.runner,s=>s.status==='done');
  assert(!fs.existsSync(path.join(env.root,'src','c.ts')));
  assert.match(env.turns[1].prompt,/Tool "delete_everything" không tồn tại/);
  assert.match(env.turns[1].prompt,/outside project/);
  assert.match(env.turns[1].prompt,/bị cắt giữa chừng/);
});

test('cancel while waiting for approval rejects pending actions and stops cleanly',async()=>{
  const env=setup(async()=>call('tool: write_file\npath: src/n.ts\n---\nx'));
  env.runner.start('x');
  await until(env.runner,s=>s.status==='waiting_approval');
  env.runner.cancel();
  const s=await until(env.runner,s=>s.status==='cancelled');
  assert.equal(s.pending.length,0);assert(!fs.existsSync(path.join(env.root,'src','n.ts')));
  await new Promise(r=>setTimeout(r,50));
  assert.equal(env.turns.length,1,'no further turn after cancel');
});

test('cancel while Gemini is still working cancels the bridge job',async()=>{
  const env=setup(async()=>null);
  env.runner.start('x');await until(env.runner,s=>s.status==='running'&&s.jobId);
  const jobId=env.runner.snapshot().jobId;
  env.runner.cancel();
  await until(env.runner,s=>s.status==='cancelled');
  assert.equal(env.bridge.getJob(jobId).status,'cancelled');
  // có thể bắt đầu lại ngay sau khi huỷ
  await new Promise(r=>setTimeout(r,30));
  assert.doesNotThrow(()=>env.runner.start('lại'));env.runner.cancel();
});

test('conversation mismatch: reopens a new chat with a progress recap instead of losing context',async()=>{
  const env=setup(async(t,i)=>{
    if(i===0)return call('tool: read_file\npath: src/a.ts');
    if(i===1)return {answer:'Tab đang ở chat khác',status:'error',code:'conversation_mismatch'};
    return call('tool: finish\n---\nxong');
  });
  env.runner.start('Mục tiêu ABC');await until(env.runner,s=>s.status==='done');
  assert.equal(env.turns.length,3);
  assert.equal(env.turns[2].newChat,true);
  assert.match(env.turns[2].prompt,/TIẾN ĐỘ ĐÃ LÀM/);assert.match(env.turns[2].prompt,/read_file src\/a\.ts → ok/);assert.match(env.turns[2].prompt,/Mục tiêu ABC/);
});

test('malformed tool attempt triggers up to two format-retry nudges, then asks the user',async()=>{
  const env=setup(async(t,i)=>{
    if(i<2)return 'Mình sẽ làm.\ntool: read_file\npath: src/a.ts';        // không có rào chắn → không parse được
    return `${F}gps-tool\ntool: finish\n---\nok\n${F}`;
  });
  env.runner.start('x');await until(env.runner,s=>s.status==='done');
  assert.match(env.turns[1].prompt,/không đọc được khối tool hợp lệ/);assert.equal(env.turns.length,3);
  // luôn sai định dạng → dừng và chờ người dùng (không lặp vô hạn)
  const env2=setup(async()=>'tool: read_file\npath: src/a.ts');
  env2.runner.start('x');await until(env2.runner,s=>s.status==='waiting_user');
  assert.equal(env2.turns.length,3);
});

test('prose-only reply waits for the user; reply() continues in the same conversation',async()=>{
  const env=setup(async(t,i)=>i===0?'Bạn muốn mình làm gì tiếp?':call('tool: finish\n---\nxong'));
  env.runner.start('x');
  const w=await until(env.runner,s=>s.status==='waiting_user');
  assert(w.steps.some(s=>s.type==='assistant'&&/muốn mình làm gì/.test(s.text)));
  env.runner.reply('Hãy kết thúc');
  await until(env.runner,s=>s.status==='done');
  assert.match(env.turns[1].prompt,/Hãy kết thúc/);assert.equal(env.turns[1].newChat,false);
  assert.throws(()=>env.runner.reply(''),/trống/);
});

test('ask_user pauses with the question; timeout errors can be retried',async()=>{
  const env=setup(async(t,i)=>i===0?call('tool: ask_user\nquestion: Dùng TypeScript hay JavaScript?'):i===1?{answer:'Gemini không trả lời',status:'error',code:'timeout'}:call('tool: finish\n---\nxong'));
  env.runner.start('x');
  const q=await until(env.runner,s=>s.status==='waiting_user');
  assert.equal(q.question,'Dùng TypeScript hay JavaScript?');
  env.runner.reply('TypeScript');
  const err=await until(env.runner,s=>s.status==='error');
  assert.match(err.error,/không trả lời/);
  await new Promise(r=>setTimeout(r,20));
  env.runner.retry();
  await until(env.runner,s=>s.status==='done');
  assert.equal(env.turns[2].prompt,env.turns[1].prompt,'retry resends the same prompt');
});

test('turn limit stops runaway loops',async()=>{
  const env=setup(async()=>call('tool: list_dir'),{maxTurns:3});
  env.runner.start('x');
  const s=await until(env.runner,s=>s.status==='waiting_user');
  assert.match(s.question,/giới hạn/);assert.equal(env.turns.length,3);
});

test('offline use: a pasted reply (completeManually) drives the loop and the prompt can be copied',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'gps-agent-'));cleanup.push(base);
  const root=path.join(base,'p');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'a.txt'),'hi\n');
  const bridge=new Bridge();
  const runner=new AgentRunner({bridge,workspace,tools,checkpoints:new CheckpointStore(path.join(base,'cp')),getRoot:()=>root});
  runner.start('đọc a.txt');
  const s1=await until(runner,s=>s.status==='running'&&s.jobId);
  assert.match(runner.getJobPrompt(s1.jobId),/đọc a\.txt/);
  bridge.completeManually(s1.jobId,call('tool: read_file\npath: a.txt'));
  const s2=await until(runner,s=>s.jobId&&s.jobId!==s1.jobId);
  assert.match(runner.getJobPrompt(s2.jobId),/1 \| hi/);
  bridge.completeManually(s2.jobId,call('tool: finish\n---\nxong'));
  await until(runner,s=>s.status==='done');
});

test('Gemini-page "write to project" proposals need approval, show a diff, are blocked for unsafe paths, and are undoable',async()=>{
  const env=setup(async()=>null);
  const r=await env.runner.proposeExternalWrite('src/a.ts','export const a = 5;\n');
  assert.equal(env.file('src/a.ts'),'export const a = 1;\n','proposal must not write');
  let s=env.runner.snapshot();assert.equal(s.pending[0].source,'vibe');assert.match(s.pending[0].diff,/\+export const a = 5;/);
  await env.runner.approve(r.id,'reject');assert.equal(env.file('src/a.ts'),'export const a = 1;\n');
  const r2=await env.runner.proposeExternalWrite('src/a.ts','export const a = 5;\n');
  const written=new Promise(res=>env.runner.once('file-written',res));
  await env.runner.approve(r2.id,'approve');await written;
  assert.equal(env.file('src/a.ts'),'export const a = 5;\n');
  const cp=env.runner.listCheckpoints()[0];assert.equal(cp.source,'vibe');
  env.runner.undo(cp.id);assert.equal(env.file('src/a.ts'),'export const a = 1;\n');
  await assert.rejects(()=>env.runner.proposeExternalWrite('../../evil.ts','x'),/outside project/);
  await assert.rejects(()=>env.runner.proposeExternalWrite('.env','X=1'),/excluded/);
  await assert.rejects(()=>env.runner.approve('act_missing','approve'),/không còn tồn tại/);
});

test('start() validates input and refuses overlapping runs',async()=>{
  const env=setup(async()=>null);
  assert.throws(()=>env.runner.start('   '),/mục tiêu/);
  env.runner.start('a');
  assert.throws(()=>env.runner.start('b'),/đang chạy/);
  assert.throws(()=>env.runner.reply('x'),/đang xử lý/);
  env.runner.cancel();
});
