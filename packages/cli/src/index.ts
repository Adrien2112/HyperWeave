#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Archive } from '../../core/src/index.js';
import { dispatch, request, serve, Store } from '../../daemon/src/index.js';
import { ArchiveError, assert, LIMITS } from '../../protocol/src/index.js';
const help=`HyperWeave — local context archive (Node 24, Linux)
Usage: hyperweave <command> [--archive PATH] [--offline] [--json] [options]
Default transport: local daemon. --offline acquires the same exclusive archive lock.
Commands:
  daemon                         Start owner process (foreground)
  init --name NAME --root PATH    Register project
  workspace add --project ID --root PATH [--policy FILE]
  session start --workspace ID --producer NAME
  ingest --input FILE            {version:1,events:[...]}
  coverage --workspace ID        Preview covered files and exclusions
  checkpoint create --workspace ID --mode strict|partial [--quality observed|quiescent] [--cooperating] [--timeline ID] [--operation ID]
  sessions list | events list [--session ID] [--after N] [--limit N]
  history [--workspace ID]
  diff --before ID --after ID
  materialize --checkpoint ID --target PATH (target must be absent)
  timeline fork --checkpoint ID
  timeline bind --timeline ID --workspace ID
  context build --checkpoint ID [--budget N] (exact UTF-8 JSON byte budget)
  search --query TEXT [--after N] [--limit N]
  attachment add --input FILE --type MIME | attachment get --hash SHA256
  actions list [--session ID] [--after N] [--limit N]
  action get --session ID --action ID
  provenance add --event ID --checkpoint ID --relation TEXT --method TEXT --certainty explicit|correlated|unknown [--path RELATIVE]
  provenance list --checkpoint ID
  operation get --operation ID
  status | doctor | verify | capabilities
  export --target FILE | import --source FILE | backup --target FILE
  recover-lock                   Remove lock only when recorded owner PID is absent
Exit: 0 success, 2 invalid/conflict/integrity error, 3 busy/unavailable.
No command executes archived text. Capture excludes .git, archive storage, .env and .env.local by default.
`;
async function main(){
 const args=process.argv.slice(2);if(!args.length||args.includes('--help')){console.log(help);return;}
 const options:Record<string,string|boolean>={};const words:string[]=[];
 for(let i=0;i<args.length;i++){const arg=args[i]!;if(arg.startsWith('--')){const key=arg.slice(2);if(['offline','json','cooperating'].includes(key))options[key]=true;else{assert(args[i+1]&&!args[i+1]!.startsWith('--'),'Missing option value');options[key]=args[++i]!;}}else words.push(arg);}
 const text=(key:string)=>{assert(typeof options[key]==='string',`Missing --${key}`);return options[key] as string;};
 const directory=path.resolve(typeof options.archive==='string'?options.archive:'.hyperweave'); const cmd=words.join(' ');let method='';let params:Record<string,unknown>={};
 if(cmd==='daemon'){const daemon=await serve(directory);console.log(JSON.stringify({ready:true,endpoint:daemon.endpoint}));let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(!stopping){stopping=true;void daemon.close().then(()=>process.exit(0));}});return;}
 if(cmd==='recover-lock'){console.log(JSON.stringify(Store.recoverLock(directory)));return;}
 switch(cmd){
 case 'init':method='registerProject';params={name:text('name'),origin:text('root')};break;
 case 'workspace add':method='registerWorkspace';params={project_id:text('project'),root:text('root')};if(options.policy)params.policy=JSON.parse(fs.readFileSync(text('policy'),'utf8'));break;
 case 'session start':method='startSession';params={workspace_id:text('workspace'),producer:text('producer'),capabilities:{}};break;
 case 'ingest':{const file=text('input');assert(fs.statSync(file).size<=4*1024*1024,'Input too large','LIMIT_EXCEEDED');const batch=JSON.parse(fs.readFileSync(file,'utf8'));assert(batch.version===1,'Unsupported batch version','UNSUPPORTED_SCHEMA');method='appendEvents';params={events:batch.events};break;}
 case 'coverage':method='coverage';params={workspace_id:text('workspace')};break;
 case 'checkpoint create':method='createCheckpoint';params={workspace_id:text('workspace'),mode:text('mode'),quality:options.quality??'observed',cooperating:options.cooperating===true};if(options.timeline)params.timeline_id=text('timeline');if(options.operation)params.operation_id=text('operation');break;
 case 'sessions list':method='listSessions';break;
 case 'events list':method='listEvents';break;
 case 'history':method='history';if(options.workspace)params.workspace_id=text('workspace');break;
 case 'diff':method='diffCheckpoints';params={before:text('before'),after:text('after')};break;
 case 'materialize':method='materializeCheckpoint';params={checkpoint_id:text('checkpoint'),target:text('target')};break;
 case 'timeline fork':method='forkTimeline';params={checkpoint_id:text('checkpoint')};break;
 case 'timeline bind':method='bindTimeline';params={timeline_id:text('timeline'),workspace_id:text('workspace')};break;
 case 'context build':method='buildResumeContext';params={checkpoint_id:text('checkpoint'),budget:Number(options.budget??32768)};break;
 case 'search':method='search';params={query:text('query')};break;
 case 'export':method='exportArchive';params={target:text('target')};break;
 case 'import':method='importArchive';params={source:text('source')};break;
 case 'backup':method='backup';params={target:text('target')};break;
 case 'attachment add':{const file=text('input');assert(fs.statSync(file).isFile() && fs.statSync(file).size<=LIMITS.attachment,'Attachment exceeds 2 MiB','LIMIT_EXCEEDED');method='putAttachment';params={base64:fs.readFileSync(file).toString('base64'),media_type:text('type')};break;}
 case 'attachment get':method='getAttachment';params={hash:text('hash')};break;
 case 'actions list':method='listActions';break;
 case 'action get':method='getAction';params={session_id:text('session'),action_id:text('action')};break;
 case 'provenance add':method='recordProvenance';params={source_event_id:text('event'),checkpoint_id:text('checkpoint'),relation:text('relation'),method:text('method'),certainty:text('certainty')};if(options.path)params.path=text('path');break;
 case 'provenance list':method='listProvenance';params={checkpoint_id:text('checkpoint')};break;
 case 'operation get':method='getOperation';params={operation_id:text('operation')};break;
 case 'status':case 'verify':case 'doctor':case 'capabilities':method=cmd;break;
 default:throw new ArchiveError('INVALID_REQUEST','Unknown command; see --help');
 }
 if(['events list','search','sessions list','history','actions list'].includes(cmd)){if(options.session)params.session_id=text('session');if(options.after)params.after=Number(options.after);if(options.limit)params.limit=Number(options.limit);}
 let result:unknown;
 if(options.offline){const a=new Archive(directory);try{result=await dispatch(a,method,params);}finally{a.close();}}else result=await request(directory,method,params);
 console.log(options.json?JSON.stringify({version:1,ok:true,result}):JSON.stringify(result,null,2));
}
main().catch(e=>{const error=e instanceof ArchiveError?e:new ArchiveError('INVALID_REQUEST',e instanceof Error?e.message:'Operation failed');console.error(JSON.stringify({version:1,ok:false,error}));process.exitCode=['WORKSPACE_BUSY','ADAPTER_UNAVAILABLE'].includes(error.code)?3:2;});
