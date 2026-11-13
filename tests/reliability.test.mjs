import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Archive} from '../dist/packages/core/src/index.js';
import {Store} from '../dist/packages/storage-sqlite/src/index.js';
import {Outbox} from '../dist/packages/adapter-sdk/src/index.js';
import {serve,request} from '../dist/packages/daemon/src/index.js';
import {canonical,hash,id} from '../dist/packages/protocol/src/index.js';
const v2Tables=['attachments','event_attachments','actions','provenance','operations'];
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hw-v2-'));const root=path.join(dir,'source');fs.mkdirSync(root);const a=new Archive(path.join(dir,'archive'));const p=a.registerProject('v2',root);const w=a.registerWorkspace(p.id,root);const s=a.startSession(w.id,'test');t.after(()=>{try{a.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});return {dir,root,a,p,w,s};}
function event(f,sequence,type,payload){return {schema_version:2,id:id(),type,producer_id:'test',producer_epoch:'e',sequence,session_id:f.s.id,causal_parents:[],payload};}
const cp=f=>f.a.createCheckpoint(f.w.id,{mode:'strict'});
const code=(fn,expected)=>assert.throws(fn,e=>e.code===expected);

test('attachment transaction, idempotence, schema v2 references and export roundtrip',t=>{
 const f=fixture(t);const bytes=Buffer.alloc(300_000,65);const attachment=f.a.putAttachment(bytes,'text/plain');assert.equal(f.a.putAttachment(bytes,'text/plain').hash,attachment.hash);code(()=>f.a.putAttachment(bytes,'image/png'),'IDEMPOTENCY_CONFLICT');
 f.a.appendEvents([event(f,0,'message.recorded',{role:'assistant',attachment_hash:attachment.hash})]);
 assert.deepEqual(Buffer.from(f.a.getAttachment(attachment.hash).base64,'base64'),bytes);
 code(()=>f.a.appendEvents([event(f,1,'message.recorded',{role:'user',attachment_hash:'0'.repeat(64)})]),'NOT_FOUND');assert.equal(f.a.status().counts.events,1);
 code(()=>f.a.appendEvents([event(f,1,'message.recorded',{role:'user',content:'both',attachment_hash:attachment.hash})]),'INVALID_REQUEST');
 const file=path.join(f.dir,'export.json');f.a.exportArchive(file);const other=new Archive(path.join(f.dir,'other'));try{other.importArchive(file);assert.equal(other.verify().ok,true);assert.equal(other.getAttachment(attachment.hash).size,bytes.length);}finally{other.close();}
});
test('unknown external schema v2 payload has no attachment side effects',t=>{const f=fixture(t);f.a.appendEvents([event(f,0,'vendor.opaque',{attachments:'vendor-specific'})]);assert.equal(f.a.listEvents()[0].opaque,true);assert.equal(f.a.verify().ok,true);});
test('actions correlate explicitly, preserve parallelism, and late starts do not reopen completion',t=>{
 const f=fixture(t);const before=cp(f);const a='a',b='b';
 f.a.appendEvents([event(f,0,'tool.completed',{action_id:a,external_tool_id:'t',after_checkpoint_id:before.id}),event(f,1,'tool.started',{action_id:b})]);
 f.a.appendEvents([event(f,2,'tool.started',{action_id:a,before_checkpoint_id:before.id})]);
 assert.equal(f.a.getAction(f.s.id,a).status,'completed');assert.equal(f.a.getAction(f.s.id,a).events.length,2);assert.equal(f.a.getAction(f.s.id,b).attribution,'unknown');assert.equal(f.a.openActions().length,1);
 f.a.appendEvents([event(f,3,'tool.failed',{action_id:a})]);assert.equal(f.a.getAction(f.s.id,a).status,'conflicted');assert.equal(f.a.verify().ok,true);
});
test('action parents may be pending; resolving cycle rolls back source and projection',t=>{const f=fixture(t);f.a.appendEvents([event(f,0,'action.started',{action_id:'child',parent_action_id:'parent'})]);assert.equal(f.a.getAction(f.s.id,'child').parent_pending,true);code(()=>f.a.appendEvents([event(f,1,'action.started',{action_id:'parent',parent_action_id:'child'})]),'INVALID_REQUEST');assert.equal(f.a.status().counts.events,1);assert.equal(f.a.status().counts.actions,1);f.a.appendEvents([event(f,1,'action.started',{action_id:'parent'})]);assert.equal(f.a.getAction(f.s.id,'child').parent_pending,false);});
test('provenance refinement appends evidence without rewriting unknown source',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'file'),'x');const original=event(f,0,'workspace.change_observed',{attribution:'unknown'});f.a.appendEvents([original]);const checkpoint=cp(f);const link=f.a.recordProvenance({source_event_id:original.id,checkpoint_id:checkpoint.id,path:'file',relation:'observed-change',method:'explicit user association',certainty:'correlated'});assert.equal(f.a.listProvenance(checkpoint.id)[0].id,link.id);assert.equal(f.a.listEvents()[0].payload.attribution,'unknown');assert.throws(()=>f.a.store.db.exec("UPDATE provenance SET certainty='explicit'"),/immutable/);assert.equal(f.a.verify().ok,true);});
test('checkpoint durable operation ID survives restart and never captures changed files on retry',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'file'),'before');const options={mode:'strict',operation_id:'retry-me'};const c=f.a.createCheckpoint(f.w.id,options);fs.writeFileSync(path.join(f.root,'file'),'after');f.a.close();const a=new Archive(path.join(f.dir,'archive'));try{assert.deepEqual(a.createCheckpoint(f.w.id,options),c);assert.equal(a.getOperation('retry-me').result.id,c.id);assert.equal(a.history().length,1);code(()=>a.createCheckpoint(f.w.id,{...options,mode:'partial'}),'IDEMPOTENCY_CONFLICT');assert.equal(a.verify().ok,true);}finally{a.close();}});
test('v1 archive migration and v1 export retain source events and rebuild action projection',t=>{
 const f=fixture(t);f.a.appendEvents([{...event(f,0,'tool.started',{action_id:'legacy'}),schema_version:1}]);const filename=path.join(f.dir,'export.json');f.a.exportArchive(filename);
 const envelope=JSON.parse(fs.readFileSync(filename));envelope.payload.version=1;for(const name of v2Tables)delete envelope.payload.tables[name];const body=canonical(envelope.payload);envelope.bytes=Buffer.byteLength(body);envelope.sha256=hash(body);fs.writeFileSync(filename,JSON.stringify(envelope));
 const other=new Archive(path.join(f.dir,'imported'));try{other.importArchive(filename);assert.equal(other.getAction(f.s.id,'legacy').status,'open-or-interrupted');}finally{other.close();}
 // Recreate an actual schema 1 database by removing only v2 additions.
 for(const table of ['event_attachments','attachments','actions','provenance','operations'])f.a.store.db.exec(`DROP TABLE ${table}`);f.a.store.db.exec('PRAGMA user_version=1');f.a.close();
 const reopened=new Archive(path.join(f.dir,'archive'));try{assert.equal(reopened.store.db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(reopened.getAction(f.s.id,'legacy').events.length,1);assert.equal(reopened.verify().ok,true);}finally{reopened.close();}
});
test('corrupt action projection or missing attachment refs reject import atomically',t=>{const f=fixture(t);const attachment=f.a.putAttachment(Buffer.from('text'),'text/plain');f.a.appendEvents([event(f,0,'tool.started',{action_id:'x',attachments:[attachment.hash]})]);const file=path.join(f.dir,'e.json');f.a.exportArchive(file);const saved=fs.readFileSync(file,'utf8');for(const table of ['actions','event_attachments']){const envelope=JSON.parse(saved);envelope.payload.tables[table]=[];const body=canonical(envelope.payload);envelope.sha256=hash(body);envelope.bytes=Buffer.byteLength(body);fs.writeFileSync(file,JSON.stringify(envelope));const other=new Archive(path.join(f.dir,table));try{code(()=>other.importArchive(file),'INTEGRITY_ERROR');assert.equal(other.status().counts.events,0);}finally{other.close();}}});
test('pagination cursors remain stable after action updates',t=>{const f=fixture(t);f.a.appendEvents([event(f,0,'tool.started',{action_id:'a'}),event(f,1,'tool.started',{action_id:'b'})]);const first=f.a.listActions({limit:1});f.a.appendEvents([event(f,2,'tool.completed',{action_id:'a'})]);const second=f.a.listActions({after:first[0].cursor,limit:1});assert.equal(second[0].id,'b');f.a.startSession(f.w.id,'second');const page=f.a.listSessions({limit:1});assert.equal(f.a.listSessions({after:page[0].cursor}).length,1);});
test('daemon status and backpressure remain responsive during a real large capture',async t=>{
 const f=fixture(t);for(let i=0;i<8;i++)fs.writeFileSync(path.join(f.root,`large-${i}`),Buffer.alloc(16*1024*1024,i));f.a.close();
 const directory=path.join(f.dir,'archive');const daemon=await serve(directory,{maxPending:1});t.after(()=>daemon.close());
 let finished=false;const capture=request(directory,'createCheckpoint',{workspace_id:f.w.id,mode:'strict',operation_id:'load-test'}).finally(()=>{finished=true;});
 let state;for(let i=0;i<100&&!finished;i++){state=await request(directory,'status',{}, {timeoutMs:2000});if(state.runtime.capture_active)break;}
 assert.equal(state.runtime.capture_active,true);assert.equal(state.runtime.snapshot_may_be_stale,true);assert.equal(finished,false);
 await assert.rejects(request(directory,'listSessions',{}),e=>e.code==='WORKSPACE_BUSY');
 const checkpoint=await capture;const committed=await request(directory,'status',{});assert.equal(committed.runtime.capture_active,false);assert.equal(committed.counts.checkpoints,1);assert.equal((await request(directory,'getOperation',{operation_id:'load-test'})).result.id,checkpoint.id);
 await daemon.close();const a=new Archive(directory);a.close();
});
test('shared outbox reserves unique sequences across real concurrent producers',async t=>{
 const f=fixture(t);const file=path.join(f.dir,'outbox.sqlite');const first=new Outbox(file,'parallel');first.close();
 const moduleUrl=new URL('../dist/packages/adapter-sdk/src/index.js',import.meta.url).href;
 const children=Array.from({length:4},()=>spawn(process.execPath,['--input-type=module','-e',`import {Outbox} from ${JSON.stringify(moduleUrl)};const box=new Outbox(${JSON.stringify(file)},'parallel');for(let i=0;i<20;i++)box.enqueue({session_id:${JSON.stringify(f.s.id)},type:'message.recorded',causal_parents:[],payload:{role:'user',content:'same text'}});box.close();`],{stdio:['ignore','ignore','pipe']}));
 await Promise.all(children.map(async child=>{let stderr='';child.stderr.on('data',b=>stderr+=b);const [code]=await once(child,'exit');assert.equal(code,0,stderr);}));
 const box=new Outbox(file,'parallel');try{assert.equal(box.pending(),80);await box.flush(async events=>f.a.appendEvents(events));const events=f.a.listEvents();assert.equal(new Set(events.map(e=>e.sequence)).size,80);assert.equal(new Set(events.map(e=>e.producer_epoch)).size,1);}finally{box.close();}
});
async function killAtBoundary(source) {
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 const boundary=new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',(code,signal)=>reject(new Error(`Exited before boundary: ${code}/${signal} ${stderr}`)));});
 try{await boundary;child.kill('SIGKILL');await once(child,'exit');}finally{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');}
}
test('real SIGKILL during outbox reservation preserves epoch and next sequence atomically',async t=>{
 const f=fixture(t);const moduleUrl=new URL('../dist/packages/adapter-sdk/src/index.js',import.meta.url).href;
 for(const when of ['before','after']){
  const file=path.join(f.dir,`reserve-${when}.sqlite`);
  await killAtBoundary(`import {Outbox} from ${JSON.stringify(moduleUrl)};const box=new Outbox(${JSON.stringify(file)},'crash');const exec=box.db.exec.bind(box.db);box.db.exec=function(sql){if(sql.includes('COMMIT')){if(${JSON.stringify(when)}==='after')exec(sql);console.log('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return;}return exec(sql);};box.enqueue({session_id:${JSON.stringify(f.s.id)},type:'message.recorded',causal_parents:[],payload:{role:'user',content:'crash'}});`);
  const box=new Outbox(file,'crash');try{assert.equal(box.pending(),when==='before'?0:1);const e=box.enqueue({session_id:f.s.id,type:'message.recorded',causal_parents:[],payload:{role:'user',content:'next'}});assert.equal(e.sequence,when==='before'?0:1);}finally{box.close();}
 }
});
test('outbox killed after archive commit but before dequeue retransmits without duplication',async t=>{
 const f=fixture(t);const directory=path.join(f.dir,'archive');const file=path.join(f.dir,'delivery.sqlite');const box=new Outbox(file,'delivery');box.enqueue({session_id:f.s.id,type:'message.recorded',causal_parents:[],payload:{role:'user',content:'durable'}});box.close();f.a.close();
 const sdk=new URL('../dist/packages/adapter-sdk/src/index.js',import.meta.url).href,core=new URL('../dist/packages/core/src/index.js',import.meta.url).href;
 await killAtBoundary(`import {Outbox} from ${JSON.stringify(sdk)};import {Archive} from ${JSON.stringify(core)};const box=new Outbox(${JSON.stringify(file)},'delivery');const a=new Archive(${JSON.stringify(directory)});const exec=box.db.exec.bind(box.db);box.db.exec=function(sql){if(sql==='COMMIT'){console.log('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return;}return exec(sql);};await box.flush(async events=>a.appendEvents(events));`);
 Store.recoverLock(directory);const a=new Archive(directory);const retried=new Outbox(file,'delivery');try{assert.equal(a.status().counts.events,1);assert.equal(retried.pending(),1);await retried.flush(async events=>a.appendEvents(events));assert.equal(retried.pending(),0);assert.equal(a.status().counts.events,1);}finally{retried.close();a.close();}
});
test('SIGKILL before and after schema migration commit leaves a recoverable schema',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const core=new URL('../dist/packages/core/src/index.js',import.meta.url).href;
 for(const when of ['before','after']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hw-migrate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Archive(dir);
  for(const table of ['event_attachments','attachments','actions','provenance','operations'])a.store.db.exec(`DROP TABLE ${table}`);a.store.db.exec('PRAGMA user_version=1');a.close();
  await killAtBoundary(`import {DatabaseSync} from 'node:sqlite';import {Archive} from ${JSON.stringify(core)};const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'){if(${JSON.stringify(when)}==='after')exec.call(this,sql);console.log('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return;}return exec.call(this,sql);};new Archive(${JSON.stringify(dir)});`);
  const db=new DatabaseSync(path.join(dir,'archive.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,when==='before'?1:2);db.close();Store.recoverLock(dir);const recovered=new Archive(dir);try{assert.equal(recovered.verify().ok,true);}finally{recovered.close();}
 }
});
test('backup and export never replace existing files; staging failures publish nothing',async t=>{
 const f=fixture(t);const target=path.join(f.dir,'existing');fs.writeFileSync(target,'keep');assert.throws(()=>f.a.exportArchive(target),e=>e.code==='EEXIST');await assert.rejects(f.a.store.backup(target),e=>e.code==='EEXIST');assert.equal(fs.readFileSync(target,'utf8'),'keep');assert.equal(fs.readdirSync(f.dir).some(n=>n.startsWith('.hyperweave-file-')),false);
 const {publishFile}=await import('../dist/packages/storage-sqlite/src/files.js');const absent=path.join(f.dir,'absent');await assert.rejects(publishFile(absent,async staged=>{fs.writeFileSync(staged,'incomplete');throw new Error('interrupted');}));assert.equal(fs.existsSync(absent),false);
});
test('text attachments are searchable while binary attachment bytes are not indexed as text',t=>{const f=fixture(t);const text=f.a.putAttachment(Buffer.from('specific phrase'),'text/plain'),binary=f.a.putAttachment(Buffer.from('binary phrase'),'application/octet-stream');f.a.appendEvents([event(f,0,'message.recorded',{role:'assistant',attachment_hash:text.hash}),event(f,1,'message.recorded',{role:'assistant',attachment_hash:binary.hash})]);assert.equal(f.a.listEvents({query:'specific phrase'}).length,1);assert.equal(f.a.listEvents({query:'binary phrase'}).length,0);});
test('daemon returns protocol errors without occupying operation queue',async t=>{const net=await import('node:net');const f=fixture(t);f.a.close();const daemon=await serve(path.join(f.dir,'archive'));try{const received=await new Promise((resolve,reject)=>{const socket=net.createConnection(daemon.endpoint);let data='';socket.on('connect',()=>socket.end(JSON.stringify({version:99,method:'status',params:{}})+'\n'));socket.on('data',chunk=>data+=chunk);socket.on('error',reject);socket.on('end',()=>resolve(JSON.parse(data)));});assert.equal(received.error.code,'UNSUPPORTED_SCHEMA');assert.equal((await request(path.join(f.dir,'archive'),'status',{})).runtime.queued,0);}finally{await daemon.close();}});
test('resume context includes whole textual attachments only when the exact budget permits',t=>{const f=fixture(t);const attachment=f.a.putAttachment(Buffer.from('remember this result'),'text/plain');f.a.appendEvents([event(f,0,'message.recorded',{role:'assistant',attachment_hash:attachment.hash})]);const checkpoint=cp(f);const full=f.a.buildResumeContext(checkpoint.id);assert.equal(full.events[0].attachment_contents[0].text,'remember this result');assert.equal(full.omitted_attachment_contents,0);const bounded=f.a.buildResumeContext(checkpoint.id,512);assert(Buffer.byteLength(canonical(bounded))<=512);assert(bounded.omitted>0 || bounded.omitted_attachment_contents>0);});
