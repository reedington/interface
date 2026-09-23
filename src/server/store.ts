import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, CapabilityRecord } from '../shared/contracts.js';
import { authoredCapabilities } from './capabilities.js';
import { ensureStateKey, openPrivate, sealPrivate, redactRun, migrateLegacyFrames } from './privacy.js';

interface StateRow{id:string;body:string;private_state:string|null}
export class Store {
  db:DatabaseSync;
  private key:Buffer;
  constructor(public dataPath:string) {
    mkdirSync(dataPath,{recursive:true,mode:0o700});
    // Never silently replace a missing key for an encrypted database.
    this.db=new DatabaseSync(join(dataPath,'workbench.sqlite'));
    const encrypted=this.db.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name='private_state'").get();
    if(encrypted&&!existsSync(join(dataPath,'state.key'))){this.db.close();throw new Error('The local state key is missing. Restore it before opening this history.');}
    this.key=ensureStateKey(dataPath);
    migrateLegacyFrames(dataPath,this.key);
    chmodSync(join(dataPath,'workbench.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, private_state TEXT);
      CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, body TEXT NOT NULL, private_state TEXT);
      CREATE TABLE IF NOT EXISTS privacy_meta (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, body_hash TEXT NOT NULL);`);
    // Keep a durable pending marker until old free pages and WAL have been
    // scrubbed. A crash after the last row rewrite must still resume cleanup.
    this.db.prepare("INSERT OR IGNORE INTO privacy_meta VALUES ('encrypted-state-v1','pending')").run();
    let migrated=(this.db.prepare("SELECT state FROM privacy_meta WHERE id='encrypted-state-v1'").get() as {state:string}).state!=='complete';
    for(const table of ['runs','capabilities']){
      if(!this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='private_state'`).get())this.db.exec(`ALTER TABLE ${table} ADD COLUMN private_state TEXT`);
      const legacy=this.db.prepare(`SELECT body FROM ${table} WHERE private_state IS NULL`).all() as {body:string}[];
      if(legacy.length)this.db.prepare("UPDATE privacy_meta SET state='pending' WHERE id='encrypted-state-v1'").run();
      for(const row of legacy){const value=JSON.parse(row.body);if(table==='runs')this.saveRun(value);else this.saveCapability(value);migrated=true;}
    }
    if(migrated){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');this.db.prepare("UPDATE privacy_meta SET state='complete' WHERE id='encrypted-state-v1'").run();}
    for(const c of authoredCapabilities()) if(!this.capability(c.id)) this.saveCapability(c);
    // Preserve historical digests and runs, but never replay old locale-specific selectors.
    for(const c of this.capabilities()) if(c.version==='1.0.0'&&c.status!=='quarantined'){c.status='quarantined';this.saveCapability(c);}
    for(const run of this.unfinishedRuns()) {
      run.status='completed';run.result='failed';run.owner='none';run.epoch++;
      run.outcomeCode=run.effect==='unknown'?'OUTCOME_UNKNOWN':'SESSION_LOST';
      run.error='The local worker restarted. Its browser session cannot be resumed.';
      run.finishedAt=run.updatedAt=new Date().toISOString();
      for(const step of run.steps)if(step.state==='running'||step.state==='waiting')step.state='failed';
      run.events.push({id:run.events.length+1,timestamp:run.updatedAt,kind:'recovery',message:run.error,actor:'system'});
      this.saveRun(run);
    }
  }
  private decode<T>(table:string,row:{id:string;body:string;private_state:string|null}):T{return JSON.parse(row.private_state?openPrivate(row.private_state,this.key,`${table}:${row.id}`):row.body);}
  private unfinishedRuns():Run[] {return (this.db.prepare("SELECT * FROM runs WHERE json_extract(body,'$.status') != 'completed'").all() as unknown as StateRow[]).map(row=>this.decode<Run>('runs',row));}
  runs():Run[] { return (this.db.prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT 100').all() as unknown as StateRow[]).map(r=>this.decode<Run>('runs',r)); }
  run(id:string):Run|undefined {const row=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as StateRow|undefined;return row?this.decode<Run>('runs',row):undefined;}
  capabilityRuns(id:string):Run[] {return (this.db.prepare("SELECT * FROM runs WHERE json_extract(body,'$.capabilityId')=? ORDER BY rowid DESC").all(id) as unknown as StateRow[]).map(row=>this.decode<Run>('runs',row));}
  saveRun(run:Run) {this.db.prepare('INSERT INTO runs(id,body,private_state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,private_state=excluded.private_state').run(run.id,JSON.stringify(redactRun(run)),sealPrivate(JSON.stringify(run),this.key,`runs:${run.id}`));}
  capabilities():CapabilityRecord[] {return (this.db.prepare('SELECT * FROM capabilities ORDER BY rowid').all() as unknown as StateRow[]).map(c=>this.decode<CapabilityRecord>('capabilities',c));}
  capability(id:string):CapabilityRecord|undefined {const c=this.db.prepare('SELECT * FROM capabilities WHERE id=?').get(id) as StateRow|undefined;return c?this.decode<CapabilityRecord>('capabilities',c):undefined;}
  saveCapability(c:CapabilityRecord) {this.db.prepare('INSERT INTO capabilities(id,body,private_state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,private_state=excluded.private_state').run(c.id,JSON.stringify({id:c.id,task:c.task,target:c.target,status:c.status,digest:c.digest}),sealPrivate(JSON.stringify(c),this.key,`capabilities:${c.id}`));}
  request(key:string):{run_id:string;body_hash:string}|undefined {return this.db.prepare('SELECT run_id,body_hash FROM requests WHERE key=?').get(key) as {run_id:string;body_hash:string}|undefined;}
  saveRequest(key:string,id:string,hash:string) {this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(key,id,hash);}
  close() {this.db.close();}
}
