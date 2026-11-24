// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/hashenc.c (md5, hash, streamhash) and crcenc.c (crc) (pinned FFmpeg 946fcce0). See ../../NOTICE-HASH.
import type {WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {containerRefusal,defineContainer} from '../registry-descriptor.js';
import type {ContainerMuxer,ContainerOption} from '../registry-descriptor.js';
import {adler32Update,createDigest,digestHex} from './digests.js';
class HashMuxError extends Error {constructor(readonly code:'invalid-data'|'resource-limit',message:string){super(message);}}
export type HashMuxerName='md5'|'hash'|'crc'|'streamhash';
export interface HashMuxOptions {readonly maxWriteBytes:number;readonly signal?:AbortSignal}
/** Default algorithm per muxer (HASH_OPT defaults; crc is a bare adler32 seeded with 1). */
const defaults:Readonly<Record<HashMuxerName,string>>={md5:'md5',hash:'sha256',crc:'adler32',streamhash:'sha256'};
const labels:Readonly<Record<HashMuxerName,string>>={md5:'md5',hash:'hash',crc:'crc',streamhash:'streamhash'};
/** -hash is parsed by native's AVOption table, but only the default algorithm is implemented; the CLI parser refuses -hash first today. */
export function validateHashOutput(muxer:HashMuxerName,options:readonly ContainerOption[]):void{
  if(options.length)throw containerRefusal(`The ${labels[muxer]} muxer -hash option is not implemented`);
}
/** Whole-stream digest of the concatenated packet payloads; boundaries and timestamps are not hashed. */
export async function muxHash(output:WriteHandle,muxer:HashMuxerName,packets:AsyncIterable<MediaPacket>,options:HashMuxOptions):Promise<void>{
  try{
    const {maxWriteBytes,signal}=options;signal?.throwIfAborted();
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new HashMuxError('resource-limit','Invalid hash muxer write budget');
    const digest=muxer==='crc'?null:createDigest(defaults[muxer]);let crc=1;
    for await(const packet of packets){
      signal?.throwIfAborted();
      if(packet.streamIndex!==0)throw new HashMuxError('invalid-data','Invalid hash muxer packet');
      if(digest)digest.update(packet.data,signal);else crc=adler32Update(crc,packet.data,signal);
    }
    signal?.throwIfAborted();
    const line=digest?`${muxer==='streamhash'?'0,a,':''}${digest.name}=${digestHex(digest)}\n`:`CRC=0x${crc.toString(16).padStart(8,'0')}\n`,bytes=new TextEncoder().encode(line);
    for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(bytes.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await output.commit();
  }catch(error){
    try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'Hash muxer output and abort failed');}
    throw error;
  }
}
/** Digest state (64-byte block, 32-byte state) plus the longest text line. */
const scratchBytes=256;
function hashMuxer(name:HashMuxerName,options:boolean):ContainerMuxer{
  return {label:labels[name],defaultCodec:'pcm_s16le',supports:()=>true,scratchBytes,dropsMetadata:true,...(options?{options:['-hash']}:{}),
    validate:stream=>validateHashOutput(name,stream.options),
    write:(output,_stream,packets,{maxWriteBytes,signal})=>muxHash(output,name,packets,{maxWriteBytes,signal})};
}
/** Registered by `export {md5} from './hash/hash-mux.js';` (and hash, crc, streamhash) in registry.ts. */
export const md5=defineContainer({name:'md5',mux:hashMuxer('md5',true)});
export const hash=defineContainer({name:'hash',mux:hashMuxer('hash',true)});
export const crc=defineContainer({name:'crc',mux:hashMuxer('crc',false)});
export const streamhash=defineContainer({name:'streamhash',mux:hashMuxer('streamhash',true)});
