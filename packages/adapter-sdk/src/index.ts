import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { assert, canonical, eventInput, id, type EventInput, LIMITS, VERSION } from '../../protocol/src/index.js';
export class Outbox {
  private db: DatabaseSync;
  constructor(filename: string, producer: string) {
    fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(filename);fs.chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),producer TEXT NOT NULL,epoch TEXT NOT NULL,next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue(sequence INTEGER PRIMARY KEY,event TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO state VALUES(1,?,?,0)').run(producer,id());
    assert(this.db.prepare('SELECT producer FROM state').get()!.producer===producer,'Outbox belongs to another producer');
  }
  enqueue(event: Omit<EventInput,'id'|'producer_id'|'producer_epoch'|'sequence'|'schema_version'>): EventInput {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assert(Number(this.db.prepare('SELECT count(*) n FROM queue').get()!.n)<10_000,'Outbox full','LIMIT_EXCEEDED');
      const state=this.db.prepare('SELECT * FROM state').get()!;
      const e=eventInput({...event,id:id(),schema_version:VERSION,producer_id:state.producer,producer_epoch:state.epoch,sequence:state.next});
      this.db.prepare('INSERT INTO queue VALUES(?,?)').run(e.sequence,canonical(e)); this.db.exec('UPDATE state SET next=next+1; COMMIT');return e;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async flush(send: (events: EventInput[])=>Promise<{accepted:string[];duplicates:string[];durable:boolean}>) {
    const pending=this.db.prepare('SELECT event FROM queue ORDER BY sequence LIMIT ?').all(LIMITS.batch).map(r=>JSON.parse(String(r.event)) as EventInput);
    if(!pending.length)return {sent:0};
    // Keep protocol requests below the request limit even with many large events.
    const batch: EventInput[]=[]; for(const e of pending){batch.push(e);if(Buffer.byteLength(canonical(batch))>LIMITS.request-1024){batch.pop();break;}}
    const receipt=await send(batch); assert(receipt.durable===true,'Non-durable receipt');
    const acknowledged=new Set([...receipt.accepted,...receipt.duplicates]); assert(batch.every(e=>acknowledged.has(e.id)),'Incomplete receipt');
    this.db.exec('BEGIN IMMEDIATE');try{for(const e of batch)this.db.prepare('DELETE FROM queue WHERE sequence=? AND event=?').run(e.sequence,canonical(e));this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    return {sent:batch.length};
  }
  pending() {return Number(this.db.prepare('SELECT count(*) n FROM queue').get()!.n);}
  close(){this.db.close();}
}
