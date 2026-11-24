// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/nistspheredec.c, aviobuf.c (ff_get_line) and utils.c (ff_get_pcm_codec_id) (pinned FFmpeg 946fcce0). See NOTICE-NISTSPHERE.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class NistSphereError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type NistSphereCodec=Extract<PcmCodec,'pcm_s8'|'pcm_s16le'|'pcm_s16be'|'pcm_s24le'|'pcm_s24be'|'pcm_s32le'|'pcm_s32be'|'pcm_alaw'|'pcm_mulaw'>;
export interface NistSphereInfo extends RawPcmInfo {readonly container:'nistsphere';readonly headerSize:bigint;readonly sampleCount:bigint|null;readonly bitsPerCodedSample:number;readonly metadata:boolean}
export interface NistSphereInput extends Omit<RawPcmInput,'info'> {readonly info:NistSphereInfo}
export interface NistSphereOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;readonly seek?:bigint}
/** Parsed header fields, exactly as nist_read_header leaves them at end_head. */
export interface NistSphereHeader {readonly headerSize:number;readonly channels:number;readonly sampleRate:number;readonly bps:number;readonly sigBits:number;readonly be:boolean;readonly mulawFormat:boolean;readonly coding:string;readonly sampleCount:bigint|null;readonly metadata:boolean;readonly end:number}
/** ff_get_line's 256-byte buffer: 255 bytes plus the terminator. */
export const nistLineBytes=255;
/** Header bytes scanned before end_head; native has no limit, EdgeFFmpeg refuses longer headers explicitly. */
export const nistMaxHeaderScan=65536;
const magic='NIST_1A\n',chunkBytes=256,ws=(c:number)=>c===32||(c>=9&&c<=13);
const lower=(text:string)=>text.replace(/[A-Z]/g,c=>c.toLowerCase());
/** Sequential avio-like byte reader: r8 returns 0 and sets eof past the end, as avio_r8 does. */
class LineReader {
  pos=0;eof=false;private buf:Uint8Array=new Uint8Array(0);private start=0;
  constructor(private readonly input:ReadHandle,private readonly maxReadBytes:number,private readonly signal?:AbortSignal){}
  private async r8():Promise<number>{
    if(BigInt(this.pos)>=this.input.size){this.eof=true;return 0;}
    if(this.pos<this.start||this.pos>=this.start+this.buf.length){
      const requested=Number(BigInt(Math.min(chunkBytes,this.maxReadBytes))<this.input.size-BigInt(this.pos)?BigInt(Math.min(chunkBytes,this.maxReadBytes)):this.input.size-BigInt(this.pos));
      this.signal?.throwIfAborted();const chunk=await this.input.readAt(BigInt(this.pos),requested,this.signal);this.signal?.throwIfAborted();
      if(!chunk.length||chunk.length>requested)throw new NistSphereError('invalid-data','Unexpected NIST SPHERE header read length');
      this.buf=chunk;this.start=this.pos;
    }
    return this.buf[this.pos++-this.start]!;
  }
  /** ff_get_line: stops at LF, CR (and swallows a following LF) or NUL/EOF; lines longer than 255 bytes are refused instead of truncated. */
  async line():Promise<string>{
    let text='',c:number;
    do{c=await this.r8();if(c&&c!==10&&c!==13){if(text.length>=nistLineBytes)throw new NistSphereError('unsupported','NIST SPHERE header lines longer than 255 bytes are not implemented');text+=String.fromCharCode(c);}}while(c!==10&&c!==13&&c);
    if(c===13){const next=await this.r8();if(next!==10&&!this.eof)this.pos--;}
    return text;
  }
}
/** sscanf tokens: %s (width-limited) and %*s skip whitespace and read non-whitespace. */
function scanToken(line:string,at:number,width:number):[string,number]|null{
  let i=at;while(i<line.length&&ws(line.charCodeAt(i)))i++;
  const start=i;while(i<line.length&&!ws(line.charCodeAt(i))&&i-start<width)i++;
  return i>start?[line.slice(start,i),i]:null;
}
/** The value after `%*s %*s`, or null when sscanf would stop early. */
function third(line:string):[string,number]|null{let at=0;for(let k=0;k<2;k++){const t=scanToken(line,at,Infinity);if(!t)return null;at=t[1];}return [line,at];}
/** sscanf %d/%u after two skipped tokens: null when nothing converts; long digit runs are refused rather than emulating overflow. */
export function scanNistInteger(line:string,digitsMax=9):number|bigint|null{
  const rest=third(line);if(!rest)return null;
  const match=/^[\t\n\v\f\r ]*([+-]?)(\d+)/.exec(line.slice(rest[1]));if(!match)return null;
  const digits=match[2]!.replace(/^0+(?=\d)/,'');
  if(digits.length>digitsMax)throw new NistSphereError('unsupported','NIST SPHERE integers this long are not implemented');
  const value=BigInt(digits)*(match[1]==='-'?-1n:1n);return digitsMax>9?value:Number(value);
}
/** sscanf "%*s %*s %31s". */
export function scanNistWord(line:string):string|null{const rest=third(line);return rest?scanToken(line,rest[1],31)?.[0]??null:null;}
/** sscanf "%31s %*s %31s" == 2: whether native stores the line as global metadata. */
export function isNistMetadata(line:string):boolean{const key=scanToken(line,0,31);if(!key)return false;const skip=scanToken(line,key[1],Infinity);return !!skip&&!!scanToken(line,skip[1],31);}
/** Port of nist_read_header up to end_head; returns the parsed fields and the end position. Native AVERROR statuses are kept (183, 176, 187). */
export async function readNistSphereHeader(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<NistSphereHeader>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new NistSphereError('resource-limit','Invalid NIST SPHERE read budget');
  const reader=new LineReader(input,maxReadBytes,signal),invalid=()=>containerRefusal('Invalid NIST SPHERE header',183);
  await reader.line();const sizeLine=await reader.line(),sizeMatch=/^[\t\n\v\f\r ]*([+-]?)(\d+)/.exec(sizeLine);
  if(sizeMatch&&sizeMatch[2]!.replace(/^0+(?=\d)/,'').length>9)throw new NistSphereError('unsupported','NIST SPHERE header sizes this long are not implemented');
  const headerSize=sizeMatch?Number(sizeMatch[2])*(sizeMatch[1]==='-'?-1:1):-1;
  if(headerSize<=0)throw invalid();
  let channels=0,sampleRate=0,bps=0,sigBits=0,be=false,mulawFormat=false,coding='pcm',format='01',sampleCount:bigint|null=null,metadata=false;
  while(!reader.eof){
    if(reader.pos>nistMaxHeaderScan)throw new NistSphereError('unsupported',`NIST SPHERE headers longer than ${nistMaxHeaderScan} bytes are not implemented`);
    const line=await reader.line();
    if(reader.pos>=headerSize)throw invalid();
    if(line.startsWith('end_head'))return Object.freeze({headerSize,channels,sampleRate,bps,sigBits,be,mulawFormat,coding,sampleCount,metadata,end:reader.pos});
    if(line.startsWith('channel_count')){const v=scanNistInteger(line);if(v!==null)channels=v as number;if(channels<=0||channels>32767)throw invalid();}
    else if(line.startsWith('sample_byte_format')){
      format=scanNistWord(line)??format;const f=lower(format);
      if(f==='01')be=false;else if(f==='10')be=true;else if(f==='mu-law')mulawFormat=true;
      else if(f!=='1')throw containerRefusal(`NIST SPHERE sample byte format ${format} is not implemented`,176);
    }
    else if(line.startsWith('sample_coding'))coding=scanNistWord(line)??coding;
    else if(line.startsWith('sample_count')){const v=scanNistInteger(line,18);if(v!==null)sampleCount=v as bigint;}
    else if(line.startsWith('sample_n_bytes')){const v=scanNistInteger(line);if(v!==null)bps=v as number;if(bps<0||bps>4095)throw invalid();}
    else if(line.startsWith('sample_rate')){const v=scanNistInteger(line);if(v!==null)sampleRate=v as number;}
    else if(line.startsWith('sample_sig_bits')){const v=scanNistInteger(line);if(v!==null)sigBits=v as number;if(sigBits<=0||sigBits>32767)throw invalid();}
    else if(isNistMetadata(line))metadata=true;
  }
  throw containerRefusal('NIST SPHERE header ends without end_head',187);
}
/** ff_get_pcm_codec_id(bits, 0, be, 0xFFFF): signed integer PCM by byte width. */
function pcmCodecId(bits:number,be:boolean):NistSphereCodec|'pcm_s64'|null{
  if(bits<=0||bits>64)return null;
  switch((bits+7)>>3){case 1:return 'pcm_s8';case 2:return be?'pcm_s16be':'pcm_s16le';case 3:return be?'pcm_s24be':'pcm_s24le';case 4:return be?'pcm_s32be':'pcm_s32le';case 8:return 'pcm_s64';default:return null;}
}
/** The codec nist_read_header selects at end_head; anything EdgeFFmpeg does not mirror is refused. */
export function nistSphereCodec(header:NistSphereHeader):{readonly codec:NistSphereCodec;readonly bits:number}{
  const bits=header.sigBits||header.bps<<3,coding=lower(header.coding);
  let codec:NistSphereCodec|'pcm_s64'|null;
  if(coding==='pcm')codec=header.mulawFormat?'pcm_mulaw':pcmCodecId(bits,header.be);
  else if(coding==='alaw')codec='pcm_alaw';
  else if(coding==='ulaw'||coding==='mu-law')codec='pcm_mulaw';
  else if(coding.startsWith('pcm,embedded-shorten'))throw new NistSphereError('unsupported','NIST SPHERE embedded Shorten coding is not implemented');
  else throw new NistSphereError('unsupported',`NIST SPHERE sample coding ${header.coding} is not implemented`);
  if(codec===null||codec==='pcm_s64')throw new NistSphereError('unsupported',`NIST SPHERE ${bits}-bit PCM is not implemented`);
  if(bits%8)throw new NistSphereError('unsupported',`NIST SPHERE ${bits} significant bits are not implemented`);
  if((codec==='pcm_alaw'||codec==='pcm_mulaw')&&bits!==8)throw new NistSphereError('unsupported',`NIST SPHERE ${bits}-bit companded samples are not implemented`);
  return {codec,bits};
}
/** Bounded NIST_1A probe: native nist_probe compares the first eight bytes. */
export async function probeNistSphere(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(input.size<8n||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)return false;
  const bytes=new Uint8Array(8);let filled=0;
  while(filled<8){signal?.throwIfAborted();const requested=Math.min(8-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)return false;bytes.set(chunk,filled);filled+=chunk.length;}
  return String.fromCharCode(...bytes)===magic;
}
/** Finite range-backed NIST SPHERE: PCM from header_size to EOF. */
export async function openNistSphere(input:ReadHandle,options:NistSphereOptions):Promise<NistSphereInput>{
  const {maxReadBytes,signal,seek=0n}=options,header=await readNistSphereHeader(input,{maxReadBytes,...(signal?{signal}:{})}),{codec,bits}=nistSphereCodec(header);
  const {channels,sampleRate,sampleCount,metadata}=header;
  if(sampleRate<1)throw new NistSphereError('unsupported','NIST SPHERE inputs without a positive sample_rate are not implemented');
  if(channels<1)throw new NistSphereError('unsupported','NIST SPHERE inputs without channel_count are not implemented');
  const offset=BigInt(header.headerSize),blockAlign=BigInt(bits/8*channels);
  if(offset>input.size)throw new NistSphereError('unsupported','NIST SPHERE header_size past EOF is not implemented');
  if((input.size-offset)%blockAlign)throw new NistSphereError('unsupported','NIST SPHERE partial sample frame is not implemented');
  if(seek>0n&&sampleCount!==null&&sampleCount!==(input.size-offset)/blockAlign)throw new NistSphereError('unsupported','NIST SPHERE input seek with a sample_count that differs from the data is not implemented');
  const raw=await openRawPcm({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'nistsphere' as const,headerSize:offset,sampleCount,bitsPerCodedSample:bits,metadata}),packets:raw.packets});
}
/** Registered by `export {nistsphere} from './nistsphere.js';` in registry.ts. Demux only. */
export const nistsphere=defineContainer({
  name:'nistsphere',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='NIST',confirm:probeNistSphere},headerBytes:2*chunkBytes,open:(source,{maxReadBytes,signal,seek})=>openNistSphere(source,{maxReadBytes,signal,seek})}
});
