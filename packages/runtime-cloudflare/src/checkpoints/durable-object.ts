import {DurableObject} from 'cloudflare:workers';
import type {DurableObjectNamespace,DurableObjectState} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {MediaCheckpointClaim,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from './types.js';
import type {StoredMediaCheckpoint} from './state.js';
import {cancelMediaCheckpoint,claimMediaCheckpoint,commitMediaCheckpoint,expireMediaCheckpoint,heartbeatMediaCheckpoint,initializeMediaCheckpoint,mediaCheckpointCoordinatorName,snapshotMediaCheckpointIdentity,validMediaCheckpointLease} from './state.js';
export interface MediaCheckpointCoordinatorEnvironment {readonly CHECKPOINTS:Pick<DurableObjectNamespace,'idFromName'>}
/** SQLite journal publishes immutable prepared state/output pointers together.
 * It does not write media, renew leases automatically, or execute a pipeline.
 */
export class MediaCheckpointCoordinator extends DurableObject<MediaCheckpointCoordinatorEnvironment> {
 constructor(ctx:DurableObjectState,env:MediaCheckpointCoordinatorEnvironment){super(ctx,env);this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS media_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');}
 private transition<T>(action:(previous:StoredMediaCheckpoint|null,now:number)=>{journal:StoredMediaCheckpoint|null;result:T}):T {
  return this.ctx.storage.transactionSync(()=>{
   const row=this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM media_checkpoint WHERE id=1').toArray()[0],previous=row?JSON.parse(row.payload) as StoredMediaCheckpoint:null;
   const {journal,result}=action(previous,Date.now());
   if(journal)this.ctx.storage.sql.exec('INSERT INTO media_checkpoint (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',JSON.stringify(journal));
   return result;
  });
 }
 async initialize(identity:ExecutionCheckpointIdentity):Promise<MediaCheckpointStatus>{
  const snapshot=snapshotMediaCheckpointIdentity(identity),namespaceName=await mediaCheckpointCoordinatorName(snapshot);
  if(!this.ctx.id.equals(this.env.CHECKPOINTS.idFromName(namespaceName)))throw new Error('Checkpoint namespace identity mismatch');
  return this.transition(previous=>{const journal=initializeMediaCheckpoint(previous,snapshot,namespaceName);return {journal,result:journal.status};});
 }
 async claim(leaseMs:number):Promise<MediaCheckpointClaim|null>{
  return this.transition((previous,now)=>{if(!previous)throw new Error('Unknown checkpoint journal');const {journal,claim}=claimMediaCheckpoint(previous,leaseMs,now,crypto.randomUUID());return {journal,result:claim};});
 }
 async heartbeat(lease:MediaCheckpointLease):Promise<MediaCheckpointLease|null>{
  return this.transition((previous,now)=>{if(!previous)return {journal:null,result:null};const result=heartbeatMediaCheckpoint(previous,lease,now);return {journal:result.journal,result:result.lease};});
 }
 async check(lease:MediaCheckpointLease):Promise<boolean>{
  return this.transition((previous,now)=>{if(!previous)return {journal:null,result:false};const journal=expireMediaCheckpoint(previous,now);return {journal,result:validMediaCheckpointLease(journal,lease,now)};});
 }
 async cancel():Promise<MediaCheckpointStatus>{
  return this.transition(previous=>{if(!previous)throw new Error('Unknown checkpoint journal');const journal=cancelMediaCheckpoint(previous);return {journal,result:journal.status};});
 }
 async status():Promise<MediaCheckpointStatus|null>{
  return this.transition((previous,now)=>{const journal=previous?expireMediaCheckpoint(previous,now):null;return {journal,result:journal?.status??null};});
 }
 async commit(lease:MediaCheckpointLease,descriptor:MediaCheckpointDescriptor):Promise<MediaCheckpointStatus>{
  return this.transition((previous,now)=>{if(!previous)throw new Error('Unknown checkpoint journal');const journal=commitMediaCheckpoint(previous,lease,descriptor,now);return {journal,result:journal.status};});
 }
}
