// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/rsd.c (pinned FFmpeg 946fcce0). See NOTICE-RSD.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class RsdError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type RsdCodec='pcm_s16le'|'pcm_s16be';
export interface RsdInfo extends RawPcmInfo {readonly container:'rsd';readonly version:number;readonly tag:string;readonly start:number;readonly packetSamples:number;readonly copyRefusal?:string}
export interface RsdInput extends Omit<RawPcmInput,'info'> {readonly info:RsdInfo}
export interface RsdOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** "RSD" + version digit, tag, channels, bit depth, rate, unknown, then the RL32 data start (absent for version 4, which starts at 0x800). */
const headerBytes=28,probeBytes=20,packetBytes=1024,version4Start=0x800,invalidData=183,patchWelcome=176,intMax=2147483647;
/** INT_MAX/2: from 2^30 Hz the CLI's audio_samplerate_update (fftools/ffmpeg_dec.c) finds 1 >= INT_MAX/rate and moves decoded
 * timestamps to a 1/28224000 time base, so decoded pts leave the sample clock; these rates (reachable with -f rsd) are refused. */
const maxExactRate=1073741823;
/** rsd_tags: the PCM tags are ported; the ADPCM and XMA tags are native codecs left unported. rsd_unsupported_tags: OGG (AVERROR_PATCHWELCOME). */
const tags:Readonly<Record<string,RsdCodec|null>>={'PCM ':'pcm_s16le','PCMB':'pcm_s16be','VAG ':null,'GADP':null,'WADP':null,'RADP':null,'XADP':null,'XMA ':null};
const fourcc=(bytes:Uint8Array)=>String.fromCharCode(...bytes);
/** rsd_probe's head: "RSD" then a version digit 2..6. */
export function rsdHead(bytes:Uint8Array):boolean{return bytes.length>=4&&bytes[0]===0x52&&bytes[1]===0x53&&bytes[2]===0x44&&bytes[3]!>=0x32&&bytes[3]!<=0x36;}
async function readExact(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new RsdError('invalid-data','Unexpected RSD read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** rsd_probe at AVPROBE_SCORE_MAX only: channels RL32@8 in 1..256 and rate RL32@16 in 1..384000. The score-12 case is refused (not detected); reads exactly the 20 bytes native inspects. */
export async function probeRsd(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new RsdError('resource-limit','Invalid RSD read budget');
  if(input.size<BigInt(probeBytes))return false;
  const head=await readExact(input,0n,probeBytes,maxReadBytes,signal),view=new DataView(head.buffer),channels=view.getUint32(8,true),rate=view.getUint32(16,true);
  return rsdHead(head)&&channels>=1&&channels<=256&&rate>=1&&rate<=384000;
}
/** Finite range-backed RSD PCM/PCMB: 1024-byte native packets from the data start to EOF. */
export async function openRsd(input:ReadHandle,options:RsdOptions):Promise<RsdInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new RsdError('resource-limit','Invalid RSD read budget');
  if(input.size<24n)throw new RsdError('invalid-data','Truncated RSD header');
  const prefix=await readExact(input,0n,24,maxReadBytes,signal),view=new DataView(prefix.buffer);
  // rsd_read_header skips "RSD" unchecked and takes version = byte 3 - '0'; only the probe tests them.
  const version=prefix[3]!-0x30,tag=fourcc(prefix.subarray(4,8));
  if(!Object.hasOwn(tags,tag)){if(tag==='OGG ')throw containerRefusal('RSD codec tag OGG is not implemented',patchWelcome);throw containerRefusal(`Unknown RSD codec tag: ${JSON.stringify(tag)}`,invalidData);}
  const codec=tags[tag];
  if(!codec)throw new RsdError('unsupported',`RSD codec tag ${JSON.stringify(tag)} is not implemented`);
  const channels=view.getInt32(8,true),sampleRate=view.getInt32(16,true);
  if(channels<=0||channels>Math.floor(intMax/36))throw containerRefusal(`Invalid RSD number of channels: ${channels}`,invalidData);
  if(!sampleRate)throw containerRefusal('Invalid RSD sample rate: 0',invalidData);
  if(sampleRate<0)throw new RsdError('unsupported',`RSD sample rate ${sampleRate} is not implemented`);
  // Native packets are a fixed 1024 bytes; a channel count that does not divide 512 splits sample frames across packets.
  if(512%channels)throw new RsdError('unsupported',`RSD ${channels}-channel packets that split sample frames are not implemented`);
  let start=version4Start;
  if(version!==4){if(input.size<BigInt(headerBytes))throw new RsdError('invalid-data','Truncated RSD header');start=new DataView((await readExact(input,24n,4,maxReadBytes,signal)).buffer).getInt32(0,true);}
  if(start<0)throw containerRefusal(`Invalid RSD data start: ${start}`,invalidData);
  if(sampleRate>maxExactRate)throw new RsdError('unsupported',`RSD sample rates above ${maxExactRate} are not implemented`);
  // avio_skip(pb, start - avio_tell(pb)) seeks to the absolute start, which may lie inside the header.
  const offset=BigInt(start);
  if(offset>input.size)throw new RsdError('unsupported','RSD data start beyond the end of the input is not implemented');
  const dataBytes=input.size-offset,blockAlign=2*channels;
  if(dataBytes%BigInt(blockAlign))throw new RsdError('unsupported','RSD partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet flags a short final packet AV_PKT_FLAG_CORRUPT (framecrc F=0x3), which copy output does not mirror.
  const short=dataBytes%BigInt(packetBytes)!==0n;
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'rsd' as const,version,tag,start,packetSamples:packetBytes/blockAlign,...(short?{copyRefusal:'RSD stream copy of a short final packet is not implemented'}:{})}),packets:raw.packets});
}
/** Registered by `export {rsd} from './rsd.js';` in registry.ts. Demux only, as native. */
export const rsd=defineContainer({
  name:'rsd',
  // Exact head "RSD" + '2'..'6'; the confirm reads the 20 bytes rsd_probe inspects and accepts only its score-100 case.
  demux:{probe:{precedence:100,head:rsdHead,confirm:probeRsd},headerBytes,
    // Native input -ss goes through the generic index; it is not mirrored.
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('RSD input seeking is not implemented');return openRsd(source,{maxReadBytes,signal});},
    packetSpan:(info:RsdInfo)=>BigInt(info.packetSamples)}
});
