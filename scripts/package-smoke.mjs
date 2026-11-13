import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const exec=promisify(execFile);const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hw-package-'));
let daemon;
try{
 const cache=path.join(temp,'cache');const packed=JSON.parse((await exec('npm',['pack','--ignore-scripts','--json','--cache',cache,'--pack-destination',temp])).stdout)[0];
 assert(!packed.files.some(file=>file.path.startsWith('node_modules/')));
 const installation=path.join(temp,'installation');fs.mkdirSync(installation);
 await exec('npm',['install','--offline','--ignore-scripts','--omit=dev','--cache',cache,path.join(temp,packed.filename)],{cwd:installation});
 const bin=path.join(installation,'node_modules','.bin','hyperweave');const archive=path.join(temp,'archive'),root=path.join(temp,'workspace');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'hello'),'packaged runtime');
 daemon=spawn(bin,['daemon','--archive',archive],{stdio:['ignore','pipe','pipe']});
 let stderr='';daemon.stderr.on('data',b=>stderr+=b);
 await new Promise((resolve,reject)=>{let data='';const timeout=setTimeout(()=>reject(new Error('Packaged daemon startup timed out')),10_000);daemon.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timeout);try{assert.equal(JSON.parse(data.trim()).ready,true);resolve();}catch(e){reject(e);}}});daemon.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Packaged daemon exited ${code}: ${stderr}`));});});
 const cli=async(...args)=>JSON.parse((await exec(bin,[...args,'--archive',archive,'--json'])).stdout).result;
 assert.equal((await cli('status')).runtime.worker_state,'ready');
 const project=await cli('init','--name','Package check','--root',root);const workspace=await cli('workspace','add','--project',project.id,'--root',root);
 const cp=await cli('checkpoint','create','--workspace',workspace.id,'--mode','strict','--operation','packaged-capture');
 const target=path.join(temp,'restored');await cli('materialize','--checkpoint',cp.id,'--target',target);assert.equal(fs.readFileSync(path.join(target,'hello'),'utf8'),'packaged runtime');assert.equal((await cli('verify')).ok,true);
 daemon.kill('SIGTERM');const [code]=await once(daemon,'exit');assert.equal(code,0);daemon=undefined;
 console.log(JSON.stringify({ok:true,package:packed.filename,bytes:packed.size,offline_install:true,daemon_worker:true,checkpoint_and_materialization:true},null,2));
}finally{if(daemon && daemon.exitCode===null && daemon.signalCode===null){daemon.kill('SIGTERM');await once(daemon,'exit').catch(()=>{});}fs.rmSync(temp,{recursive:true,force:true});}
