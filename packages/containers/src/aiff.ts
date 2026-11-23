import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo} from './raw-pcm.js';
export type AiffCodec=Extract<PcmCodec,'pcm_s8'|'pcm_s16be'|'pcm_s24be'|'pcm_s32be'|'pcm_s16le'|'pcm_f32be'|'pcm_f64be'|'pcm_alaw'|'pcm_mulaw'>;
export class AiffError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface AiffOptions {readonly maxReadBytes:number;readonly maxChunks?:number;readonly signal?:AbortSignal}
export interface AiffInfo extends RawPcmInfo {readonly container:'aiff'|'aifc';readonly defaultPacketSamples:bigint}
export interface AiffInput {readonly info:AiffInfo;packets(startSample?:bigint,maxPacketBytes?:number):AsyncIterable<MediaPacket>}
export interface AiffOutputFormat {readonly codec:AiffCodec;readonly sampleRate:number;readonly channels:number;readonly channelMask?:number|null}
export interface AiffMuxOptions {readonly sampleCount:bigint;readonly maxWriteBytes:number;readonly signal?:AbortSignal}
const encodings:Record<AiffCodec,{bits:number;tag:string}>={pcm_s8:{bits:8,tag:'NONE'},pcm_s16be:{bits:16,tag:'NONE'},pcm_s24be:{bits:24,tag:'NONE'},pcm_s32be:{bits:32,tag:'NONE'},pcm_s16le:{bits:16,tag:'sowt'},pcm_f32be:{bits:32,tag:'fl32'},pcm_f64be:{bits:64,tag:'fl64'},pcm_alaw:{bits:8,tag:'alaw'},pcm_mulaw:{bits:8,tag:'ulaw'}};
export function supportsAiffCodec(codec:string):codec is AiffCodec{return Object.hasOwn(encodings,codec);}
const fourcc=(data:Uint8Array,offset=0)=>String.fromCharCode(...data.subarray(offset,offset+4));
function rate80(data:Uint8Array,offset:number):number{
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),word=view.getUint16(offset,false),exponent=word-16383,mantissa=view.getBigUint64(offset+2,false);
  if(word&0x8000||exponent<0||exponent>30||!(mantissa&(1n<<63n)))throw new AiffError('unsupported','Unsupported AIFF sample rate');
  const shift=BigInt(63-exponent),rate=mantissa>>shift;
  if((rate<<shift)!==mantissa||rate<1n||rate>2147483647n)throw new AiffError('unsupported','AIFF currently requires an exact positive integer sample rate');
  return Number(rate);
}
function codecFor(tag:string,bits:number):AiffCodec{
  if(tag==='NONE'||tag==='twos'){
    const names:Record<number,AiffCodec>={8:'pcm_s8',16:'pcm_s16be',24:'pcm_s24be',32:'pcm_s32be'};
    if(Object.hasOwn(names,bits))return names[bits]!;
  }
  for(const [codec,spec]of Object.entries(encodings))if(spec.tag===tag&&spec.bits===bits)return codec as AiffCodec;
  throw new AiffError('unsupported',`Unsupported AIFF encoding: ${tag}/${bits}`);
}
function bitCount(mask:number){let count=0;for(let bits=mask>>>0;bits;bits=(bits&(bits-1))>>>0)count++;return count;}
/** Finite AIFF/AIFC parser. Unknown chunks are skipped by range, never loaded. */
export async function openAiff(input:ReadHandle,options:AiffOptions):Promise<AiffInput>{
  const {maxReadBytes,signal}=options,maxChunks=options.maxChunks??4096;
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||!Number.isSafeInteger(maxChunks)||maxChunks<1)throw new AiffError('resource-limit','Invalid AIFF read limits');
  const read=async(offset:bigint,length:number)=>{
    signal?.throwIfAborted();if(offset<0n||offset+BigInt(length)>input.size)throw new AiffError('invalid-data','AIFF read outside input');
    const data=new Uint8Array(length);let filled=0;
    while(filled<length){const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new AiffError('invalid-data','Unexpected AIFF read length');data.set(chunk,filled);filled+=chunk.length;}
    return data;
  };
  const header=await read(0n,12),kind=fourcc(header,8),size=new DataView(header.buffer).getUint32(4,false);
  if(fourcc(header)!=='FORM')throw new AiffError('invalid-data','Expected AIFF FORM');
  if(kind!=='AIFF'&&kind!=='AIFC')throw new AiffError('unsupported','Unsupported IFF FORM type');
  if(size===0xffffffff)throw new AiffError('unsupported','Unknown AIFF FORM size');
  const end=BigInt(size)+8n;if(end<12n||end>input.size)throw new AiffError('invalid-data','Invalid AIFF FORM size');
  let common:{codec:AiffCodec;channels:number;sampleRate:number;samples:bigint}|undefined,sound:{offset:bigint;bytes:bigint}|undefined,mask:number|null=null,layoutSeen=false,versionSeen=false,position=12n,chunks=0;
  while(position<end){
    if(++chunks>maxChunks)throw new AiffError('resource-limit','AIFF chunk count exceeds limit');
    if(end-position<8n)throw new AiffError('invalid-data','Truncated AIFF chunk header');
    const chunk=await read(position,8),length=new DataView(chunk.buffer).getUint32(4,false),payload=position+8n,next=payload+BigInt(length)+BigInt(length&1),tag=fourcc(chunk);
    if(next>end)throw new AiffError('invalid-data','AIFF chunk exceeds FORM bounds');
    if(tag==='COMM'){
      if(common||length<(kind==='AIFF'?18:22))throw new AiffError('invalid-data','Invalid or duplicate AIFF COMM');
      const data=await read(payload,kind==='AIFF'?18:22),view=new DataView(data.buffer),channels=view.getUint16(0,false),samples=BigInt(view.getUint32(2,false)),bits=view.getUint16(6,false),codec=codecFor(kind==='AIFF'?'NONE':fourcc(data,18),bits);
      if(channels<1)throw new AiffError('invalid-data','Invalid AIFF channel count');
      common={codec,channels,samples,sampleRate:rate80(data,8)};
    }else if(tag==='SSND'){
      if(sound||!common||length<8)throw new AiffError('invalid-data','Invalid AIFF sound chunk/order');
      const data=await read(payload,8),view=new DataView(data.buffer),offset=view.getUint32(0,false),block=view.getUint32(4,false);
      if(block!==0)throw new AiffError('unsupported','Blocked AIFF sound data is not implemented');
      if(offset>length-8)throw new AiffError('invalid-data','AIFF sound offset exceeds chunk');
      sound={offset:payload+8n+BigInt(offset),bytes:BigInt(length-8-offset)};
    }else if(tag==='FVER'&&kind==='AIFC'){
      if(versionSeen||length!==4)throw new AiffError('invalid-data','Invalid AIFF version chunk');
      const version=await read(payload,4);if(new DataView(version.buffer).getUint32(0,false)!==0xa2805140)throw new AiffError('unsupported','Unsupported AIFC version');versionSeen=true;
    }else if(tag==='CHAN'){
      if(layoutSeen||length<12)throw new AiffError('invalid-data','Invalid AIFF channel layout');layoutSeen=true;
      const data=await read(payload,12),view=new DataView(data.buffer),layout=view.getUint32(0,false),bitmap=view.getUint32(4,false),descriptions=view.getUint32(8,false);
      const named:Record<number,number>={0x850003:0xb,0x730004:0x107,0x750005:0x607,0x790006:0x60f};
      if(descriptions!==0)throw new AiffError('unsupported','AIFF channel descriptions are not implemented');
      mask=layout===0x10000?bitmap:named[layout]??null;
      if(mask===null||mask===0)throw new AiffError('unsupported','Unsupported AIFF channel ordering');
    }
    position=next;
  }
  if(!common||!sound)throw new AiffError('invalid-data','Missing AIFF COMM or SSND');
  if(kind==='AIFC'&&!versionSeen)throw new AiffError('unsupported','AIFC version chunk is required by this profile');
  const blockAlign=common.channels*(encodings[common.codec].bits/8),expected=common.samples*BigInt(blockAlign);
  if(sound.bytes!==expected)throw new AiffError('invalid-data','AIFF sample count does not match sound bytes');
  if(mask!==null&&bitCount(mask)!==common.channels)throw new AiffError('unsupported','AIFF channel layout/count mismatch');
  if(blockAlign>4096)throw new AiffError('unsupported','AIFF sample frame exceeds native packet profile');
  const offset=sound.offset,raw=await openRawPcm({size:expected,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:common.codec,channels:common.channels,sampleRate:common.sampleRate,channelMask:mask,maxReadBytes,...(signal?{signal}:{})});
  const info:AiffInfo=Object.freeze({...raw.info,dataOffset:offset,container:kind==='AIFF'?'aiff':'aifc',defaultPacketSamples:BigInt(Math.floor(4096/blockAlign))});
  return Object.freeze({info,packets:raw.packets});
}
function outputHeader(format:AiffOutputFormat,samples:bigint){
  if(!supportsAiffCodec(format.codec))throw new AiffError('unsupported','Unsupported AIFF output codec');
  const {channels,sampleRate}=format,spec=encodings[format.codec],mask=format.channelMask??0;
  if(!Number.isInteger(channels)||channels<1||channels>65535||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||samples<0n||samples>0xffffffffn||!Number.isInteger(mask)||mask<0||mask>0xffffffff)throw new AiffError('invalid-data','Invalid AIFF output parameters');
  if(channels*spec.bits/8>4096)throw new AiffError('unsupported','AIFF output sample frame exceeds native packet profile');
  if(mask&&bitCount(mask)!==channels)throw new AiffError('unsupported','AIFF output layout/count mismatch');
  const layout=mask!==0&&!((channels===1&&mask===4)||(channels===2&&mask===3)),compressed=spec.tag!=='NONE',fmtSize=compressed?24:18,headerSize=12+(compressed?12:0)+8+fmtSize+(layout?20:0)+16;
  const dataBytes=samples*BigInt(channels*spec.bits/8),formSize=BigInt(headerSize-8)+dataBytes+(dataBytes&1n);
  if(formSize>=0xffffffffn||dataBytes+8n>=0xffffffffn)throw new AiffError('unsupported','AIFF output exceeds 32-bit FORM size');
  const bytes=new Uint8Array(headerSize),view=new DataView(bytes.buffer),text=(value:string,offset:number)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
  text('FORM',0);view.setUint32(4,Number(formSize),false);text(compressed?'AIFC':'AIFF',8);let offset=12;
  if(compressed){text('FVER',offset);view.setUint32(offset+4,4,false);view.setUint32(offset+8,0xa2805140,false);offset+=12;}
  text('COMM',offset);view.setUint32(offset+4,fmtSize,false);view.setUint16(offset+8,channels,false);view.setUint32(offset+10,Number(samples),false);view.setUint16(offset+14,spec.bits,false);
  const exponent=BigInt(sampleRate).toString(2).length-1;view.setUint16(offset+16,16383+exponent,false);view.setBigUint64(offset+18,BigInt(sampleRate)<<BigInt(63-exponent),false);
  if(compressed)text(spec.tag,offset+26);offset+=8+fmtSize;
  if(layout){text('CHAN',offset);view.setUint32(offset+4,12,false);view.setUint32(offset+8,0x10000,false);view.setUint32(offset+12,mask,false);offset+=20;}
  text('SSND',offset);view.setUint32(offset+4,Number(dataBytes+8n),false);
  return {bytes,dataBytes};
}
/** Validation available before opening an output transaction. */
export function validateAiffOutput(format:AiffOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential AIFF/AIFC output; raw packet validation owns the transaction. */
export async function muxAiff(output:WriteHandle,format:AiffOutputFormat,packets:AsyncIterable<MediaPacket>,options:AiffMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},{bytes,dataBytes}=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new AiffError('resource-limit','Invalid AIFF write budget');
    for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(bytes.subarray(offset,offset+maxWriteBytes));}
    await muxRawPcm({write:chunk=>output.write(chunk),async commit(){signal?.throwIfAborted();if(dataBytes&1n){await output.write(new Uint8Array(1));signal?.throwIfAborted();}await output.commit();},async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'AIFF output and abort failed');}throw error;}
}
