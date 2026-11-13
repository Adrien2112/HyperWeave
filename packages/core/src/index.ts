import fs from 'node:fs';
import path from 'node:path';
import { readBounded, writeExclusive } from '../../storage-sqlite/src/files.js';
import { Store } from '../../storage-sqlite/src/index.js';
import { capture, scan, materialize, validateManifest } from '../../workspace-fs/src/index.js';
import { assert, fail, id, now, canonical, hash, eventInput, DEFAULT_POLICY, LIMITS, TYPES, relative, attachmentHashes, str, type EventInput, type Manifest, type Policy } from '../../protocol/src/index.js';
import { projectActions } from '../../protocol/src/actions.js';
type Row = Record<string, any>;
export class Archive {
  readonly store: Store;
  constructor(directory: string) {
    this.store = new Store(directory);
  }
  close() { this.store.close(); }
  private get(table: 'projects'|'workspaces'|'sessions'|'checkpoints'|'timelines', key: string): Row { const row = this.store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key); assert(row, `${table} record not found`, 'NOT_FOUND'); return row; }
  registerProject(name: string, origin: string) {
    assert(typeof name === 'string' && name.length > 0, 'Project name required');
    const project = { id: id(), name, origin: path.resolve(origin) };
    this.store.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id, project.name, project.origin); return project;
  }
  registerWorkspace(project_id: string, rootInput: string, policy: Policy = DEFAULT_POLICY) {
    this.get('projects', project_id); const root = fs.realpathSync(rootInput); assert(fs.statSync(root).isDirectory(), 'Workspace must be a directory');
    assert(Array.isArray(policy.exclude), 'Exclusions required'); policy.exclude.forEach(relative);
    assert(Number.isSafeInteger(policy.max_file) && policy.max_file > 0 && policy.max_file <= LIMITS.file && Number.isSafeInteger(policy.max_total) && policy.max_total > 0 && policy.max_total <= LIMITS.capture, 'Invalid capture limits');
    const workspace = { id: id(), project_id, root, policy, epoch: id(), timeline_id: id() };
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?)').run(workspace.id, project_id, root, canonical(policy), workspace.epoch);
      this.store.db.prepare('INSERT INTO timelines VALUES(?,?,?,NULL)').run(workspace.timeline_id, project_id, workspace.id);
    }); return workspace;
  }
  startSession(workspace_id: string, producer: string, capabilities: Record<string, unknown> = {}) {
    this.get('workspaces', workspace_id); assert(typeof producer === 'string' && producer.length > 0, 'Producer required');
    const session = { id: id(), workspace_id, producer, capabilities, created_at: now() };
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(session.id, workspace_id, producer, canonical(capabilities), session.created_at); return session;
  }
  appendEvents(inputs: unknown[]) {
    assert(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= LIMITS.batch, 'Invalid batch size', 'LIMIT_EXCEEDED');
    assert(Buffer.byteLength(canonical(inputs)) <= LIMITS.request, 'Batch too large', 'LIMIT_EXCEEDED');
    const events = inputs.map(eventInput);
    return this.store.transaction(() => {
      const accepted: string[] = []; const duplicates: string[] = [];
      for (const e of events) {
        const text = canonical(e);
        const old = this.store.db.prepare('SELECT id,normalized FROM events WHERE producer_id=? AND producer_epoch=? AND sequence=?').get(e.producer_id, e.producer_epoch, e.sequence);
        if (old) { assert(old.normalized === text, 'Producer sequence reused with different content', 'IDEMPOTENCY_CONFLICT'); duplicates.push(e.id); continue; }
        assert(!this.store.db.prepare('SELECT 1 FROM events WHERE id=?').get(e.id), 'Event ID reused', 'IDEMPOTENCY_CONFLICT'); this.get('sessions', e.session_id);
        this.store.db.prepare('INSERT INTO events(id,producer_id,producer_epoch,sequence,session_id,type,normalized,ingested_at) VALUES(?,?,?,?,?,?,?,?)').run(e.id,e.producer_id,e.producer_epoch,e.sequence,e.session_id,e.type,text,now());
        for (const digest of this.eventAttachmentHashes(e)) {
          assert(this.store.db.prepare('SELECT 1 FROM attachments WHERE hash=?').get(digest), 'Missing attachment', 'NOT_FOUND');
          this.store.db.prepare('INSERT INTO event_attachments VALUES(?,?)').run(e.id,digest);
        }
        if(e.schema_version===2 && /^(action|tool)\./.test(e.type)) for(const field of ['before_checkpoint_id','after_checkpoint_id']) if(typeof e.payload[field]==='string') {
          const c=this.get('checkpoints',e.payload[field]); const session=this.get('sessions',e.session_id);
          assert(c.workspace_id===session.workspace_id,'Action checkpoint belongs to another workspace');
        }
        for (const parent of e.causal_parents) this.store.db.prepare('INSERT INTO causal VALUES(?,?)').run(e.id,parent);
        accepted.push(e.id);
      }
      this.checkCycles(); this.rebuildActions(); return { accepted, duplicates, durable: true };
    });
  }
  private checkCycles() {
    const rows = this.store.db.prepare('SELECT c.child,c.parent FROM causal c JOIN events e ON e.id=c.parent').all() as { child: string; parent: string }[];
    const edges = new Map<string,string[]>(); const incoming = new Map<string,number>();
    for (const { child, parent } of rows) { edges.set(child, [...(edges.get(child) ?? []), parent]); incoming.set(parent,(incoming.get(parent) ?? 0)+1); if (!incoming.has(child)) incoming.set(child,0); }
    const queue = [...incoming].filter(([,n]) => n === 0).map(([key]) => key); let count = 0;
    for (let i=0;i<queue.length;i++) { count++; for (const p of edges.get(queue[i]!) ?? []) { const n = incoming.get(p)!-1; incoming.set(p,n); if (n===0) queue.push(p); } }
    assert(count === incoming.size, 'Causal cycle detected', 'INVALID_REQUEST');
  }
  listSessions(options:{after?:number;limit?:number}={}) { const {after,limit}=this.pagination(options);return this.store.db.prepare('SELECT rowid AS cursor,* FROM sessions WHERE rowid>? ORDER BY rowid LIMIT ?').all(after,limit).map(r=>({...r,capabilities:JSON.parse(String(r.capabilities))})); }
  listEvents(options: { session_id?: string; after?: number; limit?: number; cut?: number; query?: string } = {}) {
    const limit = options.limit ?? 100; const after = options.after ?? 0; assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 && Number.isSafeInteger(after) && after >= 0, 'Invalid pagination');
    const rows = this.store.db.prepare(`SELECT * FROM events WHERE ingest_order>? AND ingest_order<=? AND (? IS NULL OR session_id=?) AND (? IS NULL OR instr(normalized,?)>0 OR EXISTS (SELECT 1 FROM event_attachments ea JOIN attachments a ON a.hash=ea.attachment_hash JOIN blobs b ON b.hash=a.hash WHERE ea.event_id=events.id AND a.media_type LIKE 'text/%' AND instr(CAST(b.bytes AS TEXT),?)>0)) ORDER BY ingest_order LIMIT ?`).all(after, options.cut ?? Number.MAX_SAFE_INTEGER, options.session_id ?? null, options.session_id ?? null, options.query ?? null, options.query ?? null, options.query ?? null, limit);
    return rows.map(r => { const e = JSON.parse(String(r.normalized)) as EventInput; return { ...e, ingest_order: Number(r.ingest_order), ingested_at: r.ingested_at, opaque: !(TYPES as readonly string[]).includes(e.type), pending_parents: e.causal_parents.filter(p => !this.store.db.prepare('SELECT 1 FROM events WHERE id=?').get(p)) }; });
  }
  coverage(workspace_id: string) { const w = this.get('workspaces',workspace_id); const result = scan(w.root,JSON.parse(w.policy),this.store.directory,'partial'); return { ...result.manifest, bytes: result.manifest.entries.reduce((n,e)=>n+e.size,0) }; }
  createCheckpoint(workspace_id: string, options: { mode: 'strict'|'partial'; quality?: 'observed'|'quiescent'; cooperating?: boolean; timeline_id?: string; operation_id?: string }) {
    const request=canonical({workspace_id,mode:options.mode,quality:options.quality??'observed',cooperating:options.cooperating??false,timeline_id:options.timeline_id??null});
    if(options.operation_id!==undefined){str(options.operation_id,'operation_id');const prior=this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(options.operation_id);if(prior){assert(prior.method==='createCheckpoint' && prior.request===request,'Operation ID reused with different request','IDEMPOTENCY_CONFLICT');return JSON.parse(String(prior.result));}}
    assert(['strict','partial'].includes(options.mode), 'Capture mode must be explicit');
    const quality = options.quality ?? 'observed'; assert(['observed','quiescent'].includes(quality), 'Invalid capture quality');
    const w = this.get('workspaces',workspace_id);
    const t = options.timeline_id ? this.get('timelines', options.timeline_id) : this.store.db.prepare('SELECT * FROM timelines WHERE workspace_id=? ORDER BY rowid LIMIT 1').get(workspace_id);
    assert(t && t.workspace_id === workspace_id, 'Timeline must be bound to this workspace');
    const cut = Number(this.store.db.prepare('SELECT coalesce(max(ingest_order),0) n FROM events').get()!.n);
    const result = capture(w.root,JSON.parse(w.policy),this.store.directory,options.mode,quality,options.cooperating ?? false);
    validateManifest(result.manifest);
    const normalized = canonical(result.manifest); const manifest_hash = hash(normalized);
    const checkpoint = { id: id(), workspace_id, timeline_id: String(t.id), parent: t.head ?? null, manifest_hash, event_cut: cut, metadata: { started_at: result.started_at, finished_at: result.finished_at, quality: result.quality, assumption: result.assumption, partial: result.manifest.exclusions.some(e=>e.reason!=='policy'), open_actions: this.openActions(workspace_id), policy: JSON.parse(w.policy) } };
    this.store.transaction(() => {
      for (const [digest,bytes] of result.blobs) this.store.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?)').run(digest,bytes,bytes.length);
      this.store.db.prepare('INSERT OR IGNORE INTO manifests VALUES(?,?)').run(manifest_hash,normalized);
      for (const e of result.manifest.entries) this.store.db.prepare('INSERT OR IGNORE INTO manifest_entries VALUES(?,?,?)').run(manifest_hash,e.path,e.hash);
      this.store.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?)').run(checkpoint.id,workspace_id,checkpoint.timeline_id,checkpoint.parent,manifest_hash,cut,canonical(checkpoint.metadata));
      this.store.db.prepare('UPDATE timelines SET head=? WHERE id=?').run(checkpoint.id,checkpoint.timeline_id);
      if(options.operation_id)this.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(options.operation_id,'createCheckpoint',request,canonical(checkpoint));
    }); return checkpoint;
  }
  private sourceEvents() { return this.store.db.prepare('SELECT normalized FROM events ORDER BY ingest_order').all().map(r=>JSON.parse(String(r.normalized)) as EventInput); }
  private eventAttachmentHashes(e: EventInput) { return e.schema_version===2 && (TYPES as readonly string[]).includes(e.type) ? attachmentHashes(e.payload) : []; }
  private rebuildActions() {
    const actions=projectActions(this.sourceEvents());
    for(const a of actions.values()) this.store.db.prepare('INSERT INTO actions VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET external_tool_id=excluded.external_tool_id,normalized=excluded.normalized').run(a.session_id,a.id,a.external_tool_id,canonical(a));
  }
  getAction(session_id: string,action_id: string) {
    const row=this.store.db.prepare('SELECT normalized FROM actions WHERE session_id=? AND id=?').get(session_id,action_id);
    assert(row,'Action not found','NOT_FOUND');
    const a=JSON.parse(String(row.normalized));
    return {...a,parent_pending:!!a.parent_action_id && !this.store.db.prepare('SELECT 1 FROM actions WHERE session_id=? AND id=?').get(session_id,a.parent_action_id)};
  }
  listActions(options: { session_id?: string; after?: number; limit?: number } = {}) {
    const {after,limit}=this.pagination(options);
    return this.store.db.prepare('SELECT rowid,normalized FROM actions WHERE rowid>? AND (? IS NULL OR session_id=?) ORDER BY rowid LIMIT ?').all(after,options.session_id??null,options.session_id??null,limit).map(r=>({...JSON.parse(String(r.normalized)),cursor:r.rowid}));
  }
  openActions(workspace_id?: string) {
    return this.store.db.prepare('SELECT a.normalized FROM actions a JOIN sessions s ON s.id=a.session_id WHERE (? IS NULL OR s.workspace_id=?) ORDER BY a.session_id,a.id').all(workspace_id??null,workspace_id??null).map(r=>JSON.parse(String(r.normalized))).filter(a=>['unknown','open-or-interrupted','conflicted'].includes(a.status));
  }
  putAttachment(bytes: Uint8Array,media_type: string) {
    assert(bytes instanceof Uint8Array && bytes.byteLength<=LIMITS.attachment,'Attachment exceeds 2 MiB','LIMIT_EXCEEDED');
    assert(typeof media_type==='string' && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(media_type),'Expected media type without parameters');
    const digest=hash(bytes);
    this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT media_type FROM attachments WHERE hash=?').get(digest);
      assert(!old || old.media_type===media_type,'Attachment media type conflict','IDEMPOTENCY_CONFLICT');
      this.store.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?)').run(digest,bytes,bytes.byteLength);
      this.store.db.prepare('INSERT OR IGNORE INTO attachments VALUES(?,?)').run(digest,media_type);
    });
    return {hash:digest,media_type,size:bytes.byteLength};
  }
  getAttachment(digest: string) {
    const row=this.store.db.prepare('SELECT * FROM attachments WHERE hash=?').get(digest);assert(row,'Attachment not found','NOT_FOUND');const bytes=this.blob(digest);
    return {hash:digest,media_type:row.media_type,size:bytes.length,base64:bytes.toString('base64')};
  }
  recordProvenance(input: {source_event_id:string;checkpoint_id:string;path?:string;relation:string;method:string;certainty:'explicit'|'correlated'|'unknown'}) {
    const source=this.store.db.prepare('SELECT session_id FROM events WHERE id=?').get(str(input.source_event_id,'source_event_id'));assert(source,'Source event not found','NOT_FOUND');
    const c=this.get('checkpoints',str(input.checkpoint_id,'checkpoint_id'));assert(c.workspace_id===this.get('sessions',String(source.session_id)).workspace_id,'Provenance links must remain in the source workspace');
    str(input.relation,'relation');str(input.method,'method');assert(['explicit','correlated','unknown'].includes(input.certainty),'Invalid certainty');
    if(input.path!==undefined){relative(input.path);assert(this.manifest(c.id).entries.some(e=>e.path===input.path),'File not included in destination checkpoint','NOT_FOUND');}
    const link={id:id(),source_event_id:input.source_event_id,checkpoint_id:c.id,path:input.path??null,relation:input.relation,method:input.method,certainty:input.certainty};
    this.store.db.prepare('INSERT INTO provenance VALUES(?,?,?,?,?,?,?)').run(link.id,link.source_event_id,link.checkpoint_id,link.path,link.relation,link.method,link.certainty);return link;
  }
  listProvenance(checkpoint_id:string) { this.get('checkpoints',checkpoint_id);return this.store.db.prepare('SELECT * FROM provenance WHERE checkpoint_id=? ORDER BY rowid').all(checkpoint_id).map(r=>({...r})); }
  private pagination(options:{after?:number;limit?:number}) { const after=options.after??0,limit=options.limit??100;assert(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=1000,'Invalid pagination');return {after,limit}; }
  getOperation(operation_id:string) {const r=this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(operation_id);assert(r,'No committed receipt for this operation','NOT_FOUND');return {id:r.id,method:r.method,result:JSON.parse(String(r.result)),durable:true};}
  getCheckpoint(checkpoint_id: string) { const row = this.get('checkpoints',checkpoint_id); return { ...row, metadata: JSON.parse(row.metadata) }; }
  history(workspace_id?:string,options:{after?:number;limit?:number}={}) {const {after,limit}=this.pagination(options);return this.store.db.prepare('SELECT rowid AS cursor,* FROM checkpoints WHERE rowid>? AND (? IS NULL OR workspace_id=?) ORDER BY rowid LIMIT ?').all(after,workspace_id??null,workspace_id??null,limit).map(r=>({...r,metadata:JSON.parse(String(r.metadata))}));}
  manifest(checkpoint_id: string): Manifest { const c = this.get('checkpoints',checkpoint_id); const row = this.store.db.prepare('SELECT normalized FROM manifests WHERE hash=?').get(c.manifest_hash); assert(row && hash(String(row.normalized)) === c.manifest_hash, 'Manifest integrity failure','INTEGRITY_ERROR'); return JSON.parse(String(row.normalized)); }
  blob(digest: string) { const r = this.store.db.prepare('SELECT bytes,size FROM blobs WHERE hash=?').get(digest); assert(r && r.bytes instanceof Uint8Array, 'Missing blob','INTEGRITY_ERROR'); const bytes = Buffer.from(r.bytes); assert(hash(bytes) === digest && bytes.length === r.size, 'Blob checksum failure','INTEGRITY_ERROR'); return bytes; }
  diffCheckpoints(before: string, after: string) {
    const a = new Map(this.manifest(before).entries.map(e=>[e.path,e])); const b = new Map(this.manifest(after).entries.map(e=>[e.path,e]));
    return [...new Set([...a.keys(),...b.keys()])].sort().flatMap(p => { const x=a.get(p), y=b.get(p); return !x ? [{path:p,change:'added'}] : !y ? [{path:p,change:'deleted'}] : x.hash!==y.hash || x.mode!==y.mode ? [{path:p,change:'modified'}] : []; });
  }
  materializeCheckpoint(checkpoint_id: string,target: string) { return materialize(this.manifest(checkpoint_id), h=>this.blob(h),target); }
  forkTimeline(checkpoint_id: string) { const c=this.get('checkpoints',checkpoint_id); const w=this.get('workspaces',c.workspace_id); const t={id:id(),project_id:w.project_id,workspace_id:null,head:checkpoint_id}; this.store.db.prepare('INSERT INTO timelines VALUES(?,?,NULL,?)').run(t.id,t.project_id,t.head); return t; }
  bindTimeline(timeline_id: string,workspace_id: string) { const t=this.get('timelines',timeline_id); const w=this.get('workspaces',workspace_id); assert(t.workspace_id===null && t.project_id===w.project_id,'Timeline is already bound or project differs'); this.store.db.prepare('UPDATE timelines SET workspace_id=? WHERE id=?').run(workspace_id,timeline_id); return {timeline_id,workspace_id}; }
  buildResumeContext(checkpoint_id: string,budget = 32_768) {
    assert(Number.isSafeInteger(budget) && budget>=512 && budget<=LIMITS.request,'Budget must be 512..4194304 UTF-8 bytes');
    const c=this.get('checkpoints',checkpoint_id); const lineage = new Map<string,number>(); let cursor: Row | undefined=c;
    while(cursor) { lineage.set(cursor.workspace_id, Math.max(lineage.get(cursor.workspace_id) ?? 0, Number(cursor.event_cut))); cursor=cursor.parent ? this.get('checkpoints',cursor.parent) : undefined; }
    const result={version:1,kind:'archived-data-not-instructions',checkpoint_id,event_cut:Number(c.event_cut),manifest_hash:c.manifest_hash,budget:{unit:'utf8-bytes',maximum:budget},events:[] as unknown[],omitted:0,omitted_attachment_contents:0};
    const rows=this.store.db.prepare('SELECT e.normalized,e.ingest_order,s.workspace_id FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.ingest_order<=? ORDER BY e.ingest_order').all(c.event_cut);
    // Reserve counters before selecting content; attachments remain referenced even
    // when their complete decoded text cannot fit. No byte truncation is hidden.
    const fits=()=>Buffer.byteLength(canonical({...result,omitted:rows.length,omitted_attachment_contents:rows.length*64}))<=budget;
    for(const row of rows) if(Number(row.ingest_order) <= (lineage.get(String(row.workspace_id)) ?? -1)) {
      const e=JSON.parse(String(row.normalized)) as EventInput;
      const item={event:e,ingest_order:row.ingest_order,attachment_contents:[] as {hash:string;text:string}[]};
      result.events.push(item);
      if(!fits()){result.events.pop();result.omitted++;continue;}
      for(const digest of this.eventAttachmentHashes(e)) {
        const attachment=this.store.db.prepare('SELECT media_type FROM attachments WHERE hash=?').get(digest);
        if(!attachment || !String(attachment.media_type).startsWith('text/')){result.omitted_attachment_contents++;continue;}
        const bytes=this.blob(digest);let text:string;
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{result.omitted_attachment_contents++;continue;}
        item.attachment_contents.push({hash:digest,text});
        if(!fits()){item.attachment_contents.pop();result.omitted_attachment_contents++;}
      }
    }
    assert(Buffer.byteLength(canonical(result))<=budget,'Context budget too small','LIMIT_EXCEEDED'); return result;
  }
  status() { const counts: Record<string,number>={}; for(const table of ['projects','workspaces','sessions','events','checkpoints','blobs','attachments','actions','provenance','operations']) counts[table]=Number(this.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n); return {counts,last_durable_ingest:Number(this.store.db.prepare('SELECT coalesce(max(ingest_order),0) n FROM events').get()!.n),blob_bytes:Number(this.store.db.prepare('SELECT coalesce(sum(size),0) n FROM blobs').get()!.n),open_actions:this.openActions()}; }
  verify() {
    assert(this.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok','SQLite integrity failure','INTEGRITY_ERROR'); assert(this.store.db.prepare('PRAGMA foreign_key_check').all().length===0,'Foreign key failure','INTEGRITY_ERROR');
    for(const row of this.store.db.prepare('SELECT hash FROM blobs').all()) this.blob(String(row.hash));
    for(const row of this.store.db.prepare('SELECT * FROM manifests').all()) {
      assert(hash(String(row.normalized))===row.hash,'Manifest checksum failure','INTEGRITY_ERROR'); const m=JSON.parse(String(row.normalized)) as Manifest; validateManifest(m);
      const refs=this.store.db.prepare('SELECT path,blob_hash FROM manifest_entries WHERE manifest_hash=? ORDER BY path').all(row.hash!);
      assert(refs.length===m.entries.length,'Manifest references missing','INTEGRITY_ERROR');
      for(const e of m.entries) { assert(this.blob(e.hash).length===e.size,'Blob size mismatch','INTEGRITY_ERROR'); assert(refs.some(r=>r.path===e.path && r.blob_hash===e.hash),'Manifest reference mismatch','INTEGRITY_ERROR'); }
    }
    for(const r of this.store.db.prepare('SELECT * FROM events').all()) {
      const e=eventInput(JSON.parse(String(r.normalized)));
      assert(canonical(e)===r.normalized && e.id===r.id && e.session_id===r.session_id && e.sequence===r.sequence && e.producer_id===r.producer_id && e.producer_epoch===r.producer_epoch && e.type===r.type, 'Event envelope/index mismatch', 'INTEGRITY_ERROR');
      const refs=this.store.db.prepare('SELECT attachment_hash FROM event_attachments WHERE event_id=? ORDER BY attachment_hash').all(e.id).map(r=>String(r.attachment_hash));
      assert(canonical(refs)===canonical(this.eventAttachmentHashes(e)),'Event attachment references mismatch','INTEGRITY_ERROR');
      if(e.schema_version===2 && /^(action|tool)\./.test(e.type)) for(const field of ['before_checkpoint_id','after_checkpoint_id']) if(typeof e.payload[field]==='string') assert(this.get('checkpoints',e.payload[field]).workspace_id===this.get('sessions',e.session_id).workspace_id,'Action checkpoint mismatch','INTEGRITY_ERROR');
      const parents=this.store.db.prepare('SELECT parent FROM causal WHERE child=? ORDER BY parent').all(e.id).map(row=>String(row.parent));
      assert(canonical(parents)===canonical(e.causal_parents.toSorted()), 'Causal reference mismatch', 'INTEGRITY_ERROR');
    }
    for(const r of this.store.db.prepare('SELECT * FROM attachments').all()) {
      assert(typeof r.media_type==='string' && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(r.media_type),'Invalid attachment media type','INTEGRITY_ERROR');
      assert(this.blob(String(r.hash)).length<=LIMITS.attachment,'Attachment size limit','INTEGRITY_ERROR');
    }
    const projected=projectActions(this.sourceEvents());
    const storedActions=this.store.db.prepare('SELECT * FROM actions').all();
    assert(projected.size===storedActions.length,'Action projection count mismatch','INTEGRITY_ERROR');
    for(const r of storedActions){const a=projected.get(canonical([r.session_id,r.id]));assert(a && canonical(a)===r.normalized && a.external_tool_id===r.external_tool_id,'Action projection mismatch','INTEGRITY_ERROR');}
    for(const r of this.store.db.prepare('SELECT * FROM provenance').all()) {
      const source=this.store.db.prepare('SELECT session_id FROM events WHERE id=?').get(r.source_event_id!);assert(source,'Missing provenance source','INTEGRITY_ERROR');
      const c=this.get('checkpoints',String(r.checkpoint_id));assert(c.workspace_id===this.get('sessions',String(source.session_id)).workspace_id,'Provenance workspace mismatch','INTEGRITY_ERROR');
      str(r.relation,'relation');str(r.method,'method');
      if(r.path!==null){relative(String(r.path));assert(this.manifest(c.id).entries.some(e=>e.path===r.path),'Provenance file missing','INTEGRITY_ERROR');}
    }
    for(const r of this.store.db.prepare('SELECT * FROM operations').all()) {
      assert(r.method==='createCheckpoint','Unsupported operation receipt','INTEGRITY_ERROR');
      const receipt=JSON.parse(String(r.result));const request=JSON.parse(String(r.request));
      assert(canonical(receipt)===r.result && canonical(this.getCheckpoint(receipt.id))===r.result && canonical(request)===r.request && request.workspace_id===receipt.workspace_id,'Invalid operation receipt','INTEGRITY_ERROR');
    }
    const visited=new Set<string>();
    for(const r of this.store.db.prepare('SELECT id FROM checkpoints').all()) {
      const chain=new Set<string>(); let c:Row|undefined=this.get('checkpoints',String(r.id));
      while(c && !visited.has(c.id)){assert(!chain.has(c.id),'Checkpoint ancestry cycle','INTEGRITY_ERROR');chain.add(c.id);assert(Number.isSafeInteger(c.event_cut)&&c.event_cut>=0,'Invalid event cut','INTEGRITY_ERROR');const w=this.get('workspaces',c.workspace_id);const t=this.get('timelines',c.timeline_id);assert(t.project_id===w.project_id,'Checkpoint project mismatch','INTEGRITY_ERROR');c=c.parent?this.get('checkpoints',c.parent):undefined;}
      for(const key of chain)visited.add(key);
    }
    this.checkCycles(); return {ok:true,...this.status()};
  }
  exportArchive(target: string) {
    this.verify(); const tables: Record<string,unknown[]>={};
    for(const table of ['projects','workspaces','sessions','events','causal','manifests','manifest_entries','timelines','checkpoints','attachments','event_attachments','actions','provenance','operations']) tables[table]=this.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(r=>({...r}));
    tables.blobs=this.store.db.prepare('SELECT * FROM blobs ORDER BY hash').all().map(r=>({...r,bytes:Buffer.from(r.bytes as Uint8Array).toString('base64')}));
    const payload={version:2,tables}; const body=canonical(payload); assert(Buffer.byteLength(body)<=128*1024*1024,'JSON export exceeds 128 MiB limit','LIMIT_EXCEEDED');
    writeExclusive(target,canonical({payload,sha256:hash(body),bytes:Buffer.byteLength(body)})); return {path:path.resolve(target),bytes:Buffer.byteLength(body)};
  }
  importArchive(source: string) {
    assert(Object.values(this.status().counts).every(n=>n===0),'Import requires an empty archive','MATERIALIZATION_CONFLICT');
    const envelope=JSON.parse(readBounded(source,130*1024*1024).toString('utf8')); const body=canonical(envelope.payload); assert(hash(body)===envelope.sha256 && Buffer.byteLength(body)===envelope.bytes,'Export checksum failure','INTEGRITY_ERROR'); assert([1,2].includes(envelope.payload.version),'Unsupported export version','UNSUPPORTED_SCHEMA');
    const tables=envelope.payload.tables as Record<string,Row[]>;
    const order=['projects','workspaces','sessions','events','causal','blobs','manifests','manifest_entries','timelines','checkpoints',...(envelope.payload.version===2?['attachments','event_attachments','actions','provenance','operations']:[])];
    assert(Object.keys(tables).sort().join()===order.toSorted().join(),'Invalid table inventory','INTEGRITY_ERROR');
    return this.store.transaction(()=>{
      this.store.db.exec('PRAGMA defer_foreign_keys=ON');
      for(const table of order) {
        assert(Array.isArray(tables[table]) && tables[table]!.length<=200_000,'Table row limit','LIMIT_EXCEEDED');
        const columns=this.store.db.prepare(`PRAGMA table_info(${table})`).all().map(r=>String(r.name)); const insert=this.store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const row of tables[table]!) { assert(Object.keys(row).sort().join()===columns.toSorted().join(),'Unexpected export columns','INTEGRITY_ERROR');
          if(table==='blobs') { assert(typeof row.bytes==='string' && /^[A-Za-z0-9+/]*={0,2}$/.test(row.bytes),'Invalid base64','INTEGRITY_ERROR'); row.bytes=Buffer.from(row.bytes,'base64'); }
          insert.run(...columns.map(k=>row[k]));
        }
      }
      if(envelope.payload.version===1)this.rebuildActions();
      return this.verify();
    });
  }
}
