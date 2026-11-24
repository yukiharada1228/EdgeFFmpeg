// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/pvfdec.c, aviobuf.c ff_get_line and utils.c ff_get_pcm_codec_id (pinned FFmpeg 946fcce0). See NOTICE-PVF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
class PvfError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type PvfCodec='pcm_s8'|'pcm_s16be'|'pcm_s24be'|'pcm_s32be';
export interface PvfInfo extends RawPcmInfo {readonly container:'pvf';readonly codec:PvfCodec;readonly headerLine:string}
export interface PvfInput extends Omit<RawPcmInput,'info'> {readonly info:PvfInfo}
export interface PvfOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** Header bytes held while open: the 5-byte magic plus the longest mirrored header line, its terminator and one CR lookahead byte. */
const headerBytes=128,magicBytes=5,lineScanBytes=headerBytes-magicBytes,lineBuffer=32,saneChannels=512,intMax=2147483647n,intMin=-2147483648n;
/** ff_get_pcm_codec_id(bps,0,1,0xFFFF) restricted to the byte widths the PCM path implements; s64be and partial-byte depths are refused. */
const codecs:Readonly<Record<number,PvfCodec>>={8:'pcm_s8',16:'pcm_s16be',24:'pcm_s24be',32:'pcm_s32be'};
const invalid=():never=>{throw containerRefusal('Invalid data found when processing input: PVF header',183);};
/** ff_get_line over an in-memory window: NUL, LF, CR or EOF ends the line, at most maxlen-1 bytes are kept, CR consumes a following LF and otherwise un-reads the byte after it. `consumed` is null when the window ends before the line does. */
export function pvfGetLine(bytes:Uint8Array,eof:boolean,maxlen=lineBuffer):{readonly line:string;readonly consumed:number|null}{
  let i=0,line='',c:number;
  for(;;){if(i>=bytes.length){if(!eof)return {line,consumed:null};c=0;break;}c=bytes[i++]!;if(c&&line.length<maxlen-1)line+=String.fromCharCode(c);if(c===10||c===13||c===0)break;}
  if(c===13){if(i>=bytes.length){if(!eof)return {line,consumed:null};}else if(bytes[i]===10)i++;}
  return {line,consumed:i};
}
const space=(c:string|undefined)=>c===' '||c==='\t'||c==='\n'||c==='\v'||c==='\f'||c==='\r';
/** sscanf(line,"%d %d %d") over C-locale whitespace: returns the conversion count (-1 for input failure before the first) and each value as a bigint, so out-of-int values are visible instead of truncated. */
export function pvfScanInts(line:string,fields=3):{readonly count:number;readonly values:readonly bigint[]}{
  const values:bigint[]=[];let p=0;
  for(let k=0;k<fields;k++){
    while(space(line[p]))p++;
    if(p>=line.length)return {count:values.length||-1,values};
    let q=p;if(line[q]==='+'||line[q]==='-')q++;const start=q;while(q<line.length&&line[q]!>='0'&&line[q]!<='9')q++;
    if(q===start)return {count:values.length,values};
    values.push(BigInt(line.slice(p,q)));p=q;
  }
  return {count:values.length,values};
}
/** Finite range-backed PVF: 'PVF1\n', one ASCII line "channels rate bps", then signed big-endian PCM to EOF. */
export async function openPvf(input:ReadHandle,options:PvfOptions):Promise<PvfInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new PvfError('resource-limit','Invalid PVF read budget');
  const window=new Uint8Array(lineScanBytes),available=input.size>BigInt(magicBytes)?input.size-BigInt(magicBytes):0n;let filled=0,parsed:{line:string;consumed:number|null}={line:'',consumed:null};
  for(;;){
    const eof=BigInt(filled)>=available;parsed=pvfGetLine(window.subarray(0,filled),eof);if(parsed.consumed!==null)break;
    if(filled>=lineScanBytes)throw new PvfError('unsupported',`PVF header line extending past byte ${headerBytes} is not implemented`);
    signal?.throwIfAborted();const requested=Math.min(lineScanBytes-filled,maxReadBytes,Number(available-BigInt(filled))),chunk=await input.readAt(BigInt(magicBytes+filled),requested,signal);signal?.throwIfAborted();
    if(!chunk.length||chunk.length>requested)throw new PvfError('invalid-data','Unexpected PVF header read length');window.set(chunk,filled);filled+=chunk.length;
  }
  const {count,values}=pvfScanInts(parsed.line);if(count!==3)invalid();
  if(values.some(value=>value>intMax||value<intMin))throw new PvfError('unsupported','PVF header field outside the 32-bit int range is not implemented');
  const [channels,sampleRate,bps]=values.map(Number) as [number,number,number];
  if(channels<=0||channels>saneChannels||bps<=0||bps>Math.floor(2147483647/saneChannels)||sampleRate<=0)invalid();
  const codec=codecs[bps];
  if(!codec)throw new PvfError('unsupported',bps===64?'PVF pcm_s64be (64 bits per sample) is not implemented':`PVF ${bps} bits per sample is not implemented`);
  const offset=BigInt(magicBytes+parsed.consumed!),dataBytes=input.size>offset?input.size-offset:0n,blockAlign=bps/8*channels;
  if(dataBytes%BigInt(blockAlign)!==0n)throw new PvfError('unsupported','Partial trailing PVF sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,codec,dataOffset:offset,container:'pvf' as const,headerLine:parsed.line}),packets:raw.packets});
}
async function confirmPvf(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(input.size<BigInt(magicBytes)||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)return false;
  const bytes=new Uint8Array(magicBytes);let filled=0;
  while(filled<magicBytes){signal?.throwIfAborted();const requested=Math.min(magicBytes-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new PvfError('invalid-data','Unexpected PVF probe read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return String.fromCharCode(...bytes)==='PVF1\n';
}
/** Registered by `export {pvf} from './pvf.js';` in registry.ts. Demux only, as native has no pvf muxer. */
export const pvf=defineContainer({
  name:'pvf',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='PVF1',confirm:confirmPvf},headerBytes,open:(source,{maxReadBytes,signal})=>openPvf(source,{maxReadBytes,signal})}
});
