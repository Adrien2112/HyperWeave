import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ArchiveError, assert, capabilities, id, LIMITS, now, object, str } from '../../protocol/src/index.js';
export { dispatch } from './dispatch.js';
export { Store } from '../../storage-sqlite/src/index.js';
export function socketPath(directory: string) { return path.join(path.resolve(directory), 'daemon.sock'); }
interface Job { id: string; method: string; params: Record<string, unknown>; reply: (response: unknown) => void; enqueued_at: string; }
interface Snapshot { value: Record<string, unknown>; observed_at: string; }
export async function serve(directory: string, options: { maxPending?: number; maxQueueBytes?: number; maxConnections?: number } = {}) {
  assert(process.platform === 'linux', 'Unix daemon currently supports Linux');
  const maxPending = options.maxPending ?? 128;
  const maxQueueBytes = options.maxQueueBytes ?? 32 * 1024 * 1024;
  const maxConnections = options.maxConnections ?? 256;
  for (const limit of [maxPending,maxQueueBytes,maxConnections]) assert(Number.isSafeInteger(limit) && limit > 0, 'Invalid server limit');
  const endpoint = socketPath(directory);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { directory } });
  const jobs: (Job & { bytes: number })[] = [];
  let active: Job | undefined; let queuedBytes = 0; let snapshot: Snapshot; let snapshotValid = true;
  let closing = false; let closedWorker = false; let closeSent = false; let lastError: { code: string; at: string } | null = null;
  let fatal: ArchiveError | undefined;
  let wakeDrained: (() => void) | undefined;
  const sockets = new Set<net.Socket>();
  const failure = (error: ArchiveError) => ({ ok: false, error: error.toJSON() });
  const pump = () => {
    if (fatal || active) return;
    const next = jobs.shift();
    if (next) { queuedBytes -= next.bytes; active = next; worker.postMessage({ type:'execute',id:next.id,method:next.method,params:next.params }); }
    else if (closing && !closeSent) { closeSent = true; worker.postMessage({ type:'close' }); }
  };
  const abort = () => {
    fatal = new ArchiveError('ADAPTER_UNAVAILABLE', 'Archive worker stopped; operation outcome may be unknown. Stop daemon and inspect recovery state.', false);
    if (active) active.reply(failure(fatal)); active = undefined;
    for (const job of jobs.splice(0)) job.reply(failure(fatal)); queuedBytes = 0;
    wakeDrained?.();
  };
  worker.on('error', abort);
  worker.on('exit', () => { if (!closedWorker) abort(); });
  await new Promise<void>((resolve,reject) => {
    const onError = (e: Error) => reject(e);
    worker.once('error', onError);
    worker.on('message', message => {
      if (message.type === 'ready') { snapshot = message.snapshot; worker.off('error', onError); resolve(); }
      else if (message.type === 'result') {
        if (!active || message.id !== active.id) return;
        snapshotValid = !!message.snapshot;
        if (message.snapshot) snapshot = message.snapshot;
        if (!message.response.ok) lastError = {code:message.response.error.code,at:now()};
        active.reply(message.response); active = undefined; pump();
      } else if (message.type === 'closed') { closedWorker = true; wakeDrained?.(); }
    });
  }).catch(async error => { await worker.terminate(); throw error; });
  // Only the worker that acquired the archive lock may replace an old socket.
  try { const stat = fs.lstatSync(endpoint); assert(stat.isSocket(), 'Socket path occupied'); fs.unlinkSync(endpoint); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { closing = true; await new Promise<void>(resolve=>{wakeDrained=resolve;pump();}); throw e; } }
  const server = net.createServer(socket => {
    if (sockets.size >= maxConnections) { socket.end(JSON.stringify(failure(new ArchiveError('WORKSPACE_BUSY','Connection limit',true)))+'\n'); return; }
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{}); socket.setTimeout(30_000,()=>socket.destroy());
    let buffer = Buffer.alloc(0); let submitted = false;
    const reply = (response: unknown) => {
      if (socket.destroyed) return;
      let bytes = JSON.stringify(response)+'\n';
      if (Buffer.byteLength(bytes) > 64*1024*1024) bytes = JSON.stringify(failure(new ArchiveError('LIMIT_EXCEEDED','Response exceeds 64 MiB; paginate the query')))+'\n';
      socket.end(bytes);
    };
    socket.on('data', chunk => {
      if (submitted) return;
      if (buffer.length + chunk.length > LIMITS.request) { submitted=true; reply(failure(new ArchiveError('LIMIT_EXCEEDED','Request too large'))); return; }
      buffer=Buffer.concat([buffer,chunk]); if (!buffer.includes(10)) return; submitted=true;
      try {
        const envelope=object(JSON.parse(buffer.toString('utf8'))); assert(envelope.version===1,'Unsupported request version','UNSUPPORTED_SCHEMA');
        const method=str(envelope.method,'method'); const params=object(envelope.params);
        if (method === 'capabilities') { reply({ok:true,result:capabilities()}); return; }
        if (method === 'status') {
          reply({ok:true,result:{...snapshot!.value,runtime:{worker_state:fatal?'failed':closing?'stopping':'ready',active:active?{request_id:active.id,method:active.method,enqueued_at:active.enqueued_at}:null,queued:jobs.length,queued_bytes:queuedBytes,capture_active:active?.method==='createCheckpoint',snapshot_at:snapshot!.observed_at,snapshot_may_be_stale:!!active || !!fatal || !snapshotValid,last_error:lastError}}}); return;
        }
        if (fatal) { reply(failure(fatal)); return; }
        if (closing || jobs.length+(active?1:0)>=maxPending || queuedBytes+buffer.length>maxQueueBytes) { reply(failure(new ArchiveError('WORKSPACE_BUSY','Operation queue full or stopping',true))); return; }
        jobs.push({id:id(),method,params,reply,enqueued_at:now(),bytes:buffer.length}); queuedBytes+=buffer.length; buffer=Buffer.alloc(0); pump();
      } catch(error) { reply(failure(error instanceof ArchiveError?error:new ArchiveError('INVALID_REQUEST','Invalid request envelope'))); }
    });
  });
  try { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{fs.chmodSync(endpoint,0o600);resolve();});}); }
  catch(error) { closing=true; await new Promise<void>(resolve=>{wakeDrained=resolve;pump();}); throw error; }
  let closePromise: Promise<void> | undefined;
  return { endpoint, close() {
    return closePromise ??= (async()=>{
      closing=true;
      // Stop accepting connections, but let accepted operations reach a durable outcome.
      const stopped = new Promise<void>(resolve=>server.close(()=>resolve()));
      if (!closedWorker && !fatal) await new Promise<void>(resolve=>{wakeDrained=resolve;pump();});
      for(const socket of sockets) socket.destroy(); await stopped;
      await worker.terminate();
    })();
  } };
}
export function request(directory: string, method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve,reject)=>{
    const timeout=options.timeoutMs ?? 30_000;
    assert(Number.isSafeInteger(timeout) && timeout>0,'Invalid timeout');
    const outgoing=JSON.stringify({version:1,method,params})+'\n';
    assert(Buffer.byteLength(outgoing)<=LIMITS.request,'Request too large','LIMIT_EXCEEDED');
    const socket=net.createConnection(socketPath(directory)); let data=Buffer.alloc(0); let settled=false;
    const failure=(error: Error)=>{if(!settled){settled=true;reject(error);}socket.destroy();};
    socket.setTimeout(timeout,()=>failure(new ArchiveError('ADAPTER_UNAVAILABLE','Daemon timeout; operation may still complete. Check durable outcome before retrying.',true)));
    socket.on('error',()=>failure(new ArchiveError('ADAPTER_UNAVAILABLE','Daemon unavailable; start it or use explicit --offline mode',true)));
    socket.on('close',()=>{if(!settled)failure(new ArchiveError('ADAPTER_UNAVAILABLE','Connection closed before receipt; operation outcome unknown',true));});
    socket.on('connect',()=>socket.write(outgoing));
    socket.on('data',chunk=>{if(data.length+chunk.length>64*1024*1024){failure(new ArchiveError('LIMIT_EXCEEDED','Response too large'));return;}data=Buffer.concat([data,chunk]);});
    socket.on('end',()=>{if(settled)return;settled=true;try{const r=JSON.parse(data.toString('utf8'));if(r.ok)resolve(r.result);else reject(new ArchiveError(r.error.code,r.error.message,r.error.retryable));}catch(e){reject(e);}});
  });
}
