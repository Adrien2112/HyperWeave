import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Archive } from '../dist/packages/core/src/index.js';
import { id } from '../dist/packages/protocol/src/index.js';
const results=[];
for(const count of [1000,10000]){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hw-bench-'));const root=path.join(directory,'source');fs.mkdirSync(root);
 for(let i=0;i<count;i++)fs.writeFileSync(path.join(root,`file-${String(i).padStart(5,'0')}.txt`),`${i}:`+'x'.repeat(1024));
 fs.writeFileSync(path.join(root,'binary'),Buffer.alloc(1024*1024,128));
 const ms={};const time=(name,fn)=>{const start=performance.now();const result=fn();ms[name]=Math.round((performance.now()-start)*100)/100;return result;};
 const a=time('initialize',()=>new Archive(path.join(directory,'archive')));
 try{
  const p=a.registerProject('benchmark',root),w=a.registerWorkspace(p.id,root),s=a.startSession(w.id,'benchmark');
  a.appendEvents([{id:id(),schema_version:1,type:'message.recorded',producer_id:'benchmark',producer_epoch:'1',sequence:0,session_id:s.id,causal_parents:[],payload:{role:'user',content:'benchmark '+ 'context '.repeat(16000)}}]);
  const first=time('initial_checkpoint',()=>a.createCheckpoint(w.id,{mode:'strict'}));const storage0=a.status().blob_bytes;
  for(let i=0;i<10;i++)fs.writeFileSync(path.join(root,`file-${String(i).padStart(5,'0')}.txt`),'modified '+i);
  const second=time('checkpoint_ten_changes',()=>a.createCheckpoint(w.id,{mode:'strict'}));
  time('diff',()=>a.diffCheckpoints(first.id,second.id));time('materialize',()=>a.materializeCheckpoint(first.id,path.join(directory,'restored')));time('search',()=>a.listEvents({query:'benchmark'}));
  results.push({text_files:count,binary_files:1,event_content_bytes:128010,ms,initial_blob_bytes:storage0,incremental_blob_bytes:a.status().blob_bytes-storage0,archive_disk_bytes:fs.readdirSync(a.store.directory).reduce((n,f)=>n+fs.statSync(path.join(a.store.directory,f)).size,0)});
 }finally{a.close();fs.rmSync(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify({recorded_at:new Date().toISOString(),hyperweave:JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logical_cpus:os.cpus().length,memory_bytes:os.totalmem(),runs:1,results},null,2));
