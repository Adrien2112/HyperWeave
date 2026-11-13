import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { assert, ArchiveError, fail, id, canonical, type EventInput } from '../../protocol/src/index.js';
import { publishFile } from './files.js';
import { projectActions } from '../../protocol/src/actions.js';
export class Store {
  readonly db!: DatabaseSync;
  readonly directory: string;
  readonly migratedFrom: number;
  private lock: string;
  private token = id();
  constructor(directory: string) {
    this.directory = path.resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assert(!lstatSync(this.directory).isSymbolicLink(), 'Archive directory must not be a symlink');
    chmodSync(this.directory, 0o700); this.lock = path.join(this.directory, 'writer.lock');
    const acquire = () => { const fd = openSync(this.lock, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); } finally { closeSync(fd); } };
    try { acquire(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Fail closed: stale locks require explicit recovery after checking process ownership.
      throw new ArchiveError('WORKSPACE_BUSY', 'Archive locked. Stop its owner or run recover-lock after a confirmed crash.', true);
    }
    try {
      this.db = new DatabaseSync(path.join(this.directory, 'archive.sqlite'));
      chmodSync(path.join(this.directory, 'archive.sqlite'), 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
      this.migratedFrom = version;
      assert(version <= 2, 'Database schema is newer than this executable', 'UNSUPPORTED_SCHEMA');
      if (version === 0) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL);
          CREATE TABLE workspaces(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), root TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, epoch TEXT NOT NULL);
          CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), producer TEXT NOT NULL, capabilities TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE events(ingest_order INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, producer_id TEXT NOT NULL, producer_epoch TEXT NOT NULL, sequence INTEGER NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), type TEXT NOT NULL, normalized TEXT NOT NULL, ingested_at TEXT NOT NULL, UNIQUE(producer_id,producer_epoch,sequence));
          CREATE INDEX events_session_order ON events(session_id,ingest_order);
          CREATE TABLE causal(child TEXT NOT NULL REFERENCES events(id), parent TEXT NOT NULL, PRIMARY KEY(child,parent));
          CREATE INDEX causal_parent ON causal(parent);
          CREATE TABLE blobs(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL CHECK(size>=0));
          CREATE TABLE manifests(hash TEXT PRIMARY KEY, normalized TEXT NOT NULL);
          CREATE TABLE manifest_entries(manifest_hash TEXT NOT NULL REFERENCES manifests(hash), path TEXT NOT NULL, blob_hash TEXT NOT NULL REFERENCES blobs(hash), PRIMARY KEY(manifest_hash,path));
          CREATE TABLE timelines(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), workspace_id TEXT REFERENCES workspaces(id), head TEXT REFERENCES checkpoints(id));
          CREATE TABLE checkpoints(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), timeline_id TEXT NOT NULL REFERENCES timelines(id), parent TEXT REFERENCES checkpoints(id), manifest_hash TEXT NOT NULL REFERENCES manifests(hash), event_cut INTEGER NOT NULL, metadata TEXT NOT NULL);
          CREATE INDEX checkpoint_workspace ON checkpoints(workspace_id);
          PRAGMA user_version=1;
        `);
        for (const table of ['events','causal','blobs','manifests','manifest_entries','checkpoints']) for (const op of ['UPDATE','DELETE']) this.db.exec(`CREATE TRIGGER immutable_${table}_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable archive record'); END;`);
      });
      if (version < 2) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE attachments(hash TEXT PRIMARY KEY REFERENCES blobs(hash), media_type TEXT NOT NULL);
          CREATE TABLE event_attachments(event_id TEXT NOT NULL REFERENCES events(id), attachment_hash TEXT NOT NULL REFERENCES attachments(hash), PRIMARY KEY(event_id,attachment_hash));
          CREATE TABLE actions(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, external_tool_id TEXT, normalized TEXT NOT NULL, PRIMARY KEY(session_id,id));
          CREATE INDEX actions_external_tool ON actions(external_tool_id);
          CREATE TABLE provenance(id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL REFERENCES events(id), checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id), path TEXT, relation TEXT NOT NULL, method TEXT NOT NULL, certainty TEXT NOT NULL CHECK(certainty IN ('explicit','correlated','unknown')));
          CREATE TABLE operations(id TEXT PRIMARY KEY, method TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
          PRAGMA user_version=2;
        `);
        const legacyEvents=this.db.prepare('SELECT normalized FROM events ORDER BY ingest_order').all().map(r=>JSON.parse(String(r.normalized)) as EventInput);
        for(const action of projectActions(legacyEvents).values()) this.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(action.session_id,action.id,action.external_tool_id,canonical(action));
        for (const table of ['attachments','event_attachments','provenance','operations']) for (const op of ['UPDATE','DELETE']) this.db.exec(`CREATE TRIGGER immutable_${table}_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable archive record'); END;`);
      });
      assert(this.db.prepare('PRAGMA journal_mode').get()!['journal_mode'] === 'wal' && this.db.prepare('PRAGMA synchronous').get()!['synchronous'] === 2 && this.db.prepare('PRAGMA foreign_keys').get()!['foreign_keys'] === 1, 'SQLite durability settings unavailable', 'INTEGRITY_ERROR');
    } catch (e) { try { this.db?.close(); } catch {} this.release(); throw e; }
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private release() { try { if (JSON.parse(readFileSync(this.lock, 'utf8')).token === this.token) unlinkSync(this.lock); } catch { /* Keep uncertain locks. */ } }
  close() { try { this.db.close(); } finally { this.release(); } }
  async backup(target: string) { return publishFile(target,async staged=>{await sqliteBackup(this.db,staged);}); }
  static recoverLock(directory: string) {
    const lock = path.join(path.resolve(directory), 'writer.lock');
    const value = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    assert(Number.isSafeInteger(value.pid) && value.pid > 0, 'Unreadable lock; manual inspection required');
    try { process.kill(value.pid, 0); fail('WORKSPACE_BUSY', 'Lock owner PID is still present'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    unlinkSync(lock); return { recovered: true };
  }
}
