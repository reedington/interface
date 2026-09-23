import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface WorkerLock { release():void; }
export class WorkerAlreadyRunningError extends Error {
  readonly code='WORKER_ACTIVE';
  constructor(){super('Another Interface worker is using this data directory. Close that worker, or choose a separate WORKBENCH_DATA_DIR. Its active runs were not changed.');}
}

/**
 * Cross-process local mutex using SQLite's OS-backed exclusive file lock.
 * Holding this separate connection cannot block normal workbench transactions.
 * Process death releases the lock automatically; no PID-file deletion races or
 * process termination are needed. Never unlink the lock database while running.
 */
export function acquireWorkerLock(dataPath:string):WorkerLock {
  mkdirSync(dataPath,{recursive:true,mode:0o700});
  const path=join(dataPath,'.worker-lock.sqlite');
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(path);
    chmodSync(path,0o600);
    db.exec(`PRAGMA busy_timeout=0;
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
      BEGIN EXCLUSIVE;`);
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,acquired_at=excluded.acquired_at').run(process.pid,new Date().toISOString());
    let released=false;
    const connection=db;
    return {release(){if(released)return;released=true;try{connection.exec('ROLLBACK');}finally{connection.close();}}};
  }catch(error){
    try{db?.close();}catch{/* Preserve the acquisition failure. */}
    const sqlite=error as {errcode?:number;message?:string};
    if(sqlite.errcode===5||sqlite.errcode===6||/database (?:is )?locked|database is busy/i.test(sqlite.message||''))throw new WorkerAlreadyRunningError();
    throw error;
  }
}
