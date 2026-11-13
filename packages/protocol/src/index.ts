import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
export const VERSION = 2;
export const LIMITS = { batch: 256, request: 4 * 1024 * 1024, event: 256 * 1024, attachment: 2 * 1024 * 1024, file: 32 * 1024 * 1024, capture: 512 * 1024 * 1024, entries: 100_000 } as const;
export type Code = 'INVALID_REQUEST' | 'UNSUPPORTED_SCHEMA' | 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND' | 'WORKSPACE_BUSY' | 'CAPTURE_UNSTABLE' | 'UNSUPPORTED_FILE_TYPE' | 'LIMIT_EXCEEDED' | 'INTEGRITY_ERROR' | 'MATERIALIZATION_CONFLICT' | 'ADAPTER_UNAVAILABLE';
export class ArchiveError extends Error {
  constructor(public code: Code, message: string, public retryable = false) { super(message); }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export function fail(code: Code, message: string): never { throw new ArchiveError(code, message); }
export function assert(ok: unknown, message: string, code: Code = 'INVALID_REQUEST'): asserts ok { if (!ok) fail(code, message); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { assert(Number.isFinite(value), 'Non-finite number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  assert(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype, 'Expected JSON value');
  const v = value as Record<string, unknown>;
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function object(v: unknown): Record<string, unknown> { assert(v !== null && typeof v === 'object' && !Array.isArray(v), 'Expected object'); return v as Record<string, unknown>; }
export function str(v: unknown, name: string): string { assert(typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0'), `Invalid ${name}`); return v; }
export function relative(p: string) {
  assert(p.length > 0 && !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p) && !p.includes('\\') && !p.includes('\0') && !p.includes(':') && p.split('/').every(x => x !== '' && x !== '.' && x !== '..'), 'Unsafe relative path');
  return p;
}
export const TYPES = ['session.started','session.ended','message.recorded','action.started','action.completed','action.failed','tool.started','tool.completed','tool.failed','workspace.change_observed','checkpoint.created','timeline.forked','context.compacted','diagnostic.recorded'] as const;
export interface EventInput {
  id: string; schema_version: number; type: string; producer_id: string; producer_epoch: string;
  sequence: number; session_id: string; causal_parents: string[]; payload: Record<string, unknown>;
  occurred_at?: string; external_id?: string;
}
export function eventInput(value: unknown): EventInput {
  const v = object(value);
  assert(v.schema_version === 1 || v.schema_version === VERSION, 'Unsupported event schema', 'UNSUPPORTED_SCHEMA');
  const fields = ['id','schema_version','type','producer_id','producer_epoch','sequence','session_id','causal_parents','payload','occurred_at','external_id'];
  assert(Object.keys(v).every(k => fields.includes(k)), 'Unknown envelope field; place producer metadata in payload');
  for (const k of ['id','type','producer_id','producer_epoch','session_id']) str(v[k], k);
  assert(Number.isSafeInteger(v.sequence) && Number(v.sequence) >= 0, 'Invalid sequence');
  assert(Array.isArray(v.causal_parents) && v.causal_parents.length <= 256, 'Invalid causal parents');
  v.causal_parents.forEach(x => str(x, 'causal parent'));
  assert(new Set(v.causal_parents).size === v.causal_parents.length, 'Repeated causal parent');
  object(v.payload);
  if (v.external_id !== undefined) str(v.external_id, 'external_id');
  if (v.occurred_at !== undefined) assert(typeof v.occurred_at === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v.occurred_at) && Number.isFinite(Date.parse(v.occurred_at)), 'Expected UTC timestamp');
  if (v.type === 'message.recorded') {
    const p = object(v.payload); assert(['user','assistant','system','tool','unknown'].includes(String(p.role)), 'Invalid message role');
    if (v.schema_version === 1) assert(typeof p.content === 'string', 'Schema 1 requires inline content');
    else assert((typeof p.content === 'string') !== (typeof p.attachment_hash === 'string'), 'Message requires exactly one of content or attachment_hash');
  }
  const payload = object(v.payload);
  if (v.schema_version === 2 && (TYPES as readonly string[]).includes(String(v.type))) attachmentHashes(payload);
  if (v.schema_version === 2 && /^(action|tool)\.(started|completed|failed)$/.test(String(v.type))) {
    str(payload.action_id, 'action_id');
    for (const key of ['parent_action_id','external_tool_id','before_checkpoint_id','after_checkpoint_id']) if (payload[key] !== undefined) str(payload[key], key);
    if (payload.attribution !== undefined) assert(['explicit','correlated','unknown'].includes(String(payload.attribution)), 'Invalid attribution');
  }
  assert(Buffer.byteLength(canonical(v)) <= LIMITS.event, 'Event too large', 'LIMIT_EXCEEDED');
  return JSON.parse(canonical(v)) as EventInput;
}
export interface Policy { exclude: string[]; max_file: number; max_total: number }
export const DEFAULT_POLICY: Policy = { exclude: ['.env','.env.local','.hyperweave'], max_file: LIMITS.file, max_total: LIMITS.capture };
export interface Entry { path: string; type: 'file'; mode: number; hash: string; size: number }
export interface Manifest { version: 1; entries: Entry[]; exclusions: { path: string; reason: string }[]; policy_hash: string; coverage: 'git-tracked-and-unignored' | 'directory'; }
export interface Capture { manifest: Manifest; blobs: Map<string, Buffer>; started_at: string; finished_at: string; quality: 'observed' | 'quiescent'; assumption: string; }
export const capabilities = () => ({ schema_versions: [1,VERSION], event_types: TYPES, limits: LIMITS, transport: 'unix-socket', platforms_tested: ['linux'], attachments: true, attachment_limit_bytes: LIMITS.attachment, database_schema: 2, export_versions: [1,2], checkpoint_operation_receipts: true });

export function attachmentHashes(payload: Record<string, unknown>): string[] {
  const hashes: unknown[] = [];
  if (payload.attachment_hash !== undefined) hashes.push(payload.attachment_hash);
  if (payload.attachments !== undefined) { assert(Array.isArray(payload.attachments), 'attachments must be an array of hashes'); hashes.push(...payload.attachments); }
  assert(hashes.length <= 64, 'Too many attachments', 'LIMIT_EXCEEDED');
  for (const digest of hashes) assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Invalid attachment hash');
  return [...new Set(hashes as string[])].sort();
}
