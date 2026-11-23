/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped packet-copy adaptation of pinned FFmpeg 946fcce07b6dcd0331c8cc609192aeff5e1924f8
 * libavformat/flacenc.c/flacenc_header.c (Justin Ruggles), vorbiscomment.c
 * (James Darnley), and mux.c. No pictures, chapters or extradata updates.
 */
import type {ResourceContext,WriteHandle,OwnedBuffer} from '@edge-ffmpeg/core';
import type {FlacDemuxPacket} from './demux.js';
import type {VorbisCommentEntry} from './comment-types.js';
import {waitForFlacAbort} from './abort-wait.js';
export type FlacMuxMetadataPolicy = Readonly<{mode:'drop'}> | Readonly<{mode:'comments';entries:readonly VorbisCommentEntry[]}>;
export interface FlacMuxOptions {
 readonly streamInfo:Uint8Array;
 /** Explicit policy: no implicit raw metadata copying. Pictures/chapters are unsupported. */
 readonly metadataPolicy:FlacMuxMetadataPolicy;
 readonly resources:Pick<ResourceContext,'allocate'|'reserveExternalMemory'>;
 readonly signal:AbortSignal;readonly maxWriteBytes:number;
 readonly bitexact?:boolean;readonly maxPackets?:bigint;readonly paddingBytes?:number;
}
const software='Lavf63.1.102';
const conversions:Readonly<Record<string,string>>={album_artist:'ALBUMARTIST',track:'TRACKNUMBER',disc:'DISCNUMBER',disc_subtitle:'DISCSUBTITLE',comment:'DESCRIPTION'};
/** No encoded allocation; matches TextEncoder replacement of unpaired surrogates. */
function utf8Bytes(text:string):number {let size=0;for(const char of text){const cp=char.codePointAt(0)!;size+=cp<128?1:cp<2048?2:cp<65536?3:4;}return size;}
/** Transactional writer: commit prepares/publishes only after all packets succeed.
 * One Core-owned staging buffer is retained until a late provider write settles.
 * Caller owns the packet iterator; each borrowed chunk is released before advancing.
 */
export async function muxFlac(output:WriteHandle,packets:AsyncIterable<FlacDemuxPacket>,options:FlacMuxOptions):Promise<void>{
 const {signal,resources,maxWriteBytes,bitexact=false,maxPackets,paddingBytes=8192}=options;
 let staging:OwnedBuffer|undefined,releaseMetadata:(()=>void)|undefined,pending:Promise<void>|undefined;
 try {
  signal.throwIfAborted();
  if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1||!Number.isSafeInteger(paddingBytes)||paddingBytes<0||paddingBytes>0xffffff||options.streamInfo.length!==34||maxPackets!==undefined&&(typeof maxPackets!=='bigint'||maxPackets<0n))throw new RangeError('Invalid FLAC mux options');
  const policy=options.metadataPolicy;
  if(!policy||!['drop','comments'].includes(policy.mode))throw new RangeError('Explicit FLAC metadata policy required');
  const input=policy.mode==='comments'?policy.entries:[];
  if(input.length>1024)throw new RangeError('FLAC mux comment count exceeded');
  let chars=0;for(const entry of input){if(typeof entry.key!=='string'||typeof entry.value!=='string'||!entry.key||/[\x00=]/.test(entry.key)||entry.value.includes('\0'))throw new RangeError('Invalid FLAC comment');chars+=entry.key.length+entry.value.length;if(chars>65536)throw new RangeError('FLAC mux comment budget exceeded');}
  // Reserve copied string/index state BEFORE creating it; provider/caller storage is borrowed.
  releaseMetadata=resources.reserveExternalMemory(chars*4+(input.length+1)*128+546);
  const streamInfo=new Uint8Array(options.streamInfo);
  const entries=input.map(entry=>({key:entry.key,value:entry.value}));
  const remove=(index:number)=>{entries[index]=entries[entries.length-1]!;entries.pop();};
  for(let i=0;i<entries.length;){const key=entries[i]!.key.toLowerCase();if(key.startsWith('encoder-')||key==='encoder'&&bitexact)remove(i);else i++;}
  if(!bitexact){const entry=entries.find(entry=>entry.key.toLowerCase()==='encoder');if(entry){entry.key='encoder';entry.value=software;}else entries.push({key:'encoder',value:software});}
  for(const entry of entries){const key=entry.key.toLowerCase();if(Object.hasOwn(conversions,key))entry.key=conversions[key]!;}
  const vendor=bitexact?'ffmpeg':software;
  let commentBytes=8+utf8Bytes(vendor);for(const entry of entries)commentBytes+=5+utf8Bytes(entry.key)+utf8Bytes(entry.value);
  if(commentBytes>=0xfffffc)throw new RangeError('FLAC comment block too large');
  staging=resources.allocate(Math.min(maxWriteBytes,65536));
  const buffer=staging.data;
  const flush=async(length:number)=>{signal.throwIfAborted();pending=Promise.resolve().then(()=>output.write(buffer.subarray(0,length)));await waitForFlacAbort(pending,signal);pending=undefined;signal.throwIfAborted();};
  const bytes=async(source:Uint8Array)=>{for(let at=0;at<source.length;at+=buffer.length){const count=Math.min(buffer.length,source.length-at);buffer.set(source.subarray(at,at+count));await flush(count);}};
  const number=async(value:number,width:number,little=false)=>{for(let i=0;i<width;i++){buffer[0]=Math.floor(value/2**(8*(little?i:width-i-1)))&255;await flush(1);}};
  // Stream UTF-8 directly into accounted staging, including budgets smaller than one codepoint.
  const text=async(value:string)=>{let used=0;for(const char of value){let cp=char.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)cp=0xfffd;const count=cp<128?1:cp<2048?2:cp<65536?3:4;for(let i=0;i<count;i++){const byte=i===0?(count===1?cp:count===2?0xc0|(cp>>6):count===3?0xe0|(cp>>12):0xf0|(cp>>18)):0x80|((cp>>(6*(count-i-1)))&63);buffer[used++]=byte;if(used===buffer.length){await flush(used);used=0;}}}if(used)await flush(used);};
  const block=async(type:number,length:number)=>{await number(type,1);await number(length,3);};
  // Preserve all original extradata, including total samples and MD5 under frame limits.
  await text('fLaC');await block(0,34);await bytes(streamInfo);
  await block(paddingBytes?4:0x84,commentBytes);await number(utf8Bytes(vendor),4,true);await text(vendor);await number(entries.length,4,true);
  for(const entry of entries){await number(1+utf8Bytes(entry.key)+utf8Bytes(entry.value),4,true);await text(entry.key);await text('=');await text(entry.value);}
  if(paddingBytes){await block(0x81,paddingBytes);let left=paddingBytes;while(left){const count=Math.min(left,buffer.length);buffer.fill(0,0,count);await flush(count);left-=count;}}
  let count=0n;
  if(maxPackets!==0n)for await(const packet of packets){signal.throwIfAborted();let written=0n;for await(const chunk of packet.chunks)try{const data=chunk.data;await bytes(data);written+=BigInt(data.length);}finally{chunk.release();}if(written!==packet.range.bytes)throw new Error('FLAC packet size mismatch');count++;if(maxPackets!==undefined&&count>=maxPackets)break;}
  signal.throwIfAborted();await waitForFlacAbort(output.commit(),signal);signal.throwIfAborted();
 }catch(error){
  // Start cleanup even on cancellation; observe late errors without holding the caller hostage.
  const cleanup=Promise.resolve().then(async()=>{if(pending)try{await pending;}catch{}await output.abort(error);});
  try{await waitForFlacAbort(cleanup,signal);}catch(cleanupError){if(!signal.aborted)throw new AggregateError([error,cleanupError],'FLAC mux cleanup failed');}throw error;
 }finally{
  const owned=staging;if(pending){void pending.then(()=>owned?.release(),()=>owned?.release());}else owned?.release();releaseMetadata?.();
 }
}
