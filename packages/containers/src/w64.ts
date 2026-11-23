import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {WavError} from './wav.js';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {checkWavPacketTiming,supportsWavCodec,wavHeader,wavLayout} from './wav-mux.js';
import type {WavOutputFormat,WavPcmCodec} from './wav-mux.js';
/* Sony Wave64: RIFF/WAVE fields in 16-byte GUID chunks whose 64-bit sizes include the 24-byte chunk header.
 * Native implements it inside wavdec/wavenc, so failures reuse WavError. GUID values: NOTICE-W64. */
const tail=[0xf3,0xac,0xd3,0x11,0x8c,0xd1,0x00,0xc0,0x4f,0x8e,0xdb,0x8a];
const guid=(id:string,rest:readonly number[]=tail)=>Uint8Array.from([...[...id].map(c=>c.charCodeAt(0)),...rest]);
const riffGuid=guid('riff',[0x2e,0x91,0xcf,0x11,0xa5,0xd6,0x28,0xdb,0x04,0xc1,0x00,0x00]),waveGuid=guid('wave'),fmtGuid=guid('fmt '),factGuid=guid('fact'),dataGuid=guid('data');
const summaryGuid=Uint8Array.from([0xbc,0x94,0x5f,0x92,0x5a,0x52,0xd2,0x11,0x86,0xdc,0x00,0xc0,0x4f,0x8e,0xdb,0x8a]);
const maxSize=0x7fffffffffffffffn,align=(value:bigint)=>(value+7n)&~7n,same=(data:Uint8Array,offset:number,id:Uint8Array)=>id.every((byte,i)=>data[offset+i]===byte);
export type W64PcmCodec=WavPcmCodec;
export type W64OutputFormat=WavOutputFormat;
export interface W64Options {readonly maxReadBytes:number;readonly maxChunks?:number;readonly signal?:AbortSignal}
/** `durationSamples` counts every frame native reads, including the zero bytes its muxer pads data with to an
 * 8-byte boundary (the data size covers them); `factSamples` is the declared positive fact count, if any. */
export interface W64Info extends RawPcmInfo {readonly container:'w64';readonly factSamples:bigint|null}
export interface W64Input extends Omit<RawPcmInput,'info'> {readonly info:W64Info}
export interface W64MuxOptions {readonly sampleCount:bigint;readonly maxWriteBytes:number;readonly signal?:AbortSignal}
export function supportsW64Codec(codec:string):codec is W64PcmCodec{return supportsWavCodec(codec);}
async function readExact(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  signal?.throwIfAborted();if(offset<0n||offset+BigInt(length)>input.size)throw new WavError('invalid-data','Read exceeds W64 input bounds');
  const result=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new WavError('invalid-data','Unexpected W64 read length');result.set(chunk,filled);filled+=chunk.length;}
  return result;
}
/** Native w64_probe: more than 40 bytes that begin with the riff GUID and carry the wave GUID at 24. */
export async function probeW64(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new WavError('resource-limit','Invalid W64 probe budget');
  if(input.size<=40n)return false;const bytes=await readExact(input,0n,40,maxReadBytes,signal);return same(bytes,0,riffGuid)&&same(bytes,24,waveGuid);
}
/** Finite range-backed Wave64 PCM. Walks chunk headers to EOF as native does, reading at most 40 payload bytes per fmt
 * chunk and 8 per fact chunk; data and unknown chunks are skipped without reads. Metadata and partial frames fail explicitly. */
export async function openW64(input:ReadHandle,options:W64Options):Promise<W64Input>{
  const {maxReadBytes,signal}=options,maxChunks=options.maxChunks??4096;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||!Number.isSafeInteger(maxChunks)||maxChunks<1)throw new WavError('resource-limit','Invalid W64 read limits');
  if(input.size<40n)throw new WavError('invalid-data','Truncated W64 header');
  const read=(offset:bigint,length:number)=>readExact(input,offset,length,maxReadBytes,signal),header=await read(0n,40);
  if(!same(header,0,riffGuid))throw new WavError('invalid-data','Expected W64 riff GUID');
  // Native only requires room for riff + wave + fmt headers; the declared file size is otherwise unused.
  if(new DataView(header.buffer).getBigUint64(16,true)<72n)throw new WavError('invalid-data','Invalid W64 riff size');
  if(!same(header,24,waveGuid))throw new WavError('invalid-data','Expected W64 wave GUID');
  let format:{codec:W64PcmCodec;channels:number;sampleRate:number;blockAlign:number;channelMask:number|null}|undefined,data:{offset:bigint;bytes:bigint}|undefined,factSamples:bigint|null=null,offset=40n,chunks=0;
  // Fewer than 24 trailing bytes end the walk, as a short GUID or size read does natively.
  while(input.size-offset>=24n){
    if(++chunks>maxChunks)throw new WavError('resource-limit','W64 chunk count exceeds limit');
    const chunk=await read(offset,24),size=new DataView(chunk.buffer).getBigUint64(16,true),payload=offset+24n,length=size-24n;
    if(size<=24n||size>maxSize-7n-payload){if(data)break;throw new WavError('invalid-data','Invalid W64 chunk size');}
    let next=offset+align(size);
    if(same(chunk,0,fmtGuid)){
      if(format)throw new WavError('unsupported','Multiple W64 format chunks');
      if(length<16n)throw new WavError('invalid-data','Truncated W64 format');
      const bytes=await read(payload,Number(length<40n?length:40n)),view=new DataView(bytes.buffer);
      let tag=view.getUint16(0,true);let channelMask:number|null=null;
      const channels=view.getUint16(2,true),sampleRate=view.getUint32(4,true),byteRate=view.getUint32(8,true),blockAlign=view.getUint16(12,true),bits=view.getUint16(14,true);
      if(tag===0xfffe){
        if(length<40n||view.getUint16(16,true)<22||BigInt(view.getUint16(16,true))+18n>length)throw new WavError('invalid-data','Truncated extensible W64 format');
        if(![0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71].every((value,i)=>bytes[28+i]===value))throw new WavError('unsupported','Unsupported W64 subtype GUID');
        tag=view.getUint32(24,true);const valid=view.getUint16(18,true),mask=view.getUint32(20,true);
        if(valid!==0&&valid!==bits)throw new WavError('unsupported','Packed valid-bit W64 samples are not yet supported');
        channelMask=mask.toString(2).replaceAll('0','').length===channels?mask:null;
      }
      const supported=tag===1?[8,16,24,32]:tag===3?[32,64]:tag===6||tag===7?[8]:[];
      if(!supported.includes(bits))throw new WavError('unsupported',`Unsupported W64 encoding: ${tag}/${bits}`);
      if(!channels||!sampleRate||sampleRate>2147483647||blockAlign!==channels*bits/8||byteRate!==sampleRate*blockAlign)throw new WavError('invalid-data','Invalid W64 PCM alignment or sample rate');
      const codec=(tag===6?'pcm_alaw':tag===7?'pcm_mulaw':tag===3?`pcm_f${bits}le`:bits===8?'pcm_u8':`pcm_s${bits}le`) as W64PcmCodec;
      format={codec,channels,sampleRate,blockAlign,channelMask};
    }else if(same(chunk,0,factGuid)){
      if(size<32n)throw new WavError('invalid-data','Truncated W64 fact chunk');
      const count=new DataView((await read(payload,8)).buffer).getBigInt64(0,true);factSamples=count>0n?count:null;
    }else if(same(chunk,0,dataGuid)){
      if(data)throw new WavError('unsupported','Multiple W64 data chunks');
      if(!format)throw new WavError('unsupported','W64 data before format');
      if(length>input.size-payload)throw new WavError('unsupported','Truncated W64 data is not yet supported');
      // Native skips the data payload without realignment.
      data={offset:payload,bytes:length};next=payload+length;
    }else if(same(chunk,0,summaryGuid))throw new WavError('unsupported','W64 summary metadata is not yet supported');
    offset=next;
  }
  if(!format||!data)throw new WavError('invalid-data','Missing W64 format or data');
  if(format.blockAlign>maxReadBytes)throw new WavError('resource-limit','A sample frame exceeds the read budget');
  // Native emits the remainder as a short packet; copy and decode paths for it are not modelled.
  if(data.bytes%BigInt(format.blockAlign)!==0n)throw new WavError('unsupported','W64 data ending in a partial sample frame is not yet supported');
  const {offset:dataOffset,bytes:dataBytes}=data,{codec,channels,sampleRate,channelMask}=format;
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(dataOffset+position,length,abort)},{codec,channels,sampleRate,channelMask,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset,container:'w64' as const,factSamples}),packets:raw.packets});
}
/** w64 carries no metadata, so the fmt payload is always native ff_put_wav_header at default compliance. */
function layout(format:W64OutputFormat,samples:bigint){
  const wav=wavLayout(format,0n,'ffmpeg-9.0.2',true);
  if(typeof samples!=='bigint'||samples<0n)throw new WavError('invalid-data','Invalid W64 output duration');
  const fmtChunk=align(24n+BigInt(wav.fmtSize)),factBytes=wav.tag!==1?32:0,headerBytes=40+Number(fmtChunk)+factBytes+24,dataBytes=samples*BigInt(wav.blockAlign),paddedBytes=align(dataBytes),fileBytes=BigInt(headerBytes)+paddedBytes;
  if(fileBytes>maxSize)throw new WavError('unsupported','W64 output exceeds the 64-bit size fields');
  return {fmtSize:wav.fmtSize,blockAlign:wav.blockAlign,fmtChunk,factBytes,headerBytes,dataBytes,paddedBytes,fileBytes};
}
/** Validate the exact finite header without allocating bytes or opening a writer. */
export function validateW64Output(format:W64OutputFormat,samples:bigint):void{layout({...format},samples);}
/** Final sizes as native's seekable trailer rewrites them: file size, data size including alignment padding, and
 * maxpts-minpts+last_duration as the fact count (minpts starts at 0 in w64, so no packets give 0). */
function header(format:W64OutputFormat,samples:bigint){
  const {fmtSize,blockAlign,fmtChunk,factBytes,headerBytes,dataBytes,paddedBytes,fileBytes}=layout(format,samples);
  const bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);let offset=40+Number(fmtChunk);
  bytes.set(riffGuid,0);view.setBigUint64(16,fileBytes,true);bytes.set(waveGuid,24);bytes.set(fmtGuid,40);view.setBigUint64(56,fmtChunk,true);
  bytes.set(wavHeader(format,0n,'ffmpeg-9.0.2',true).bytes.subarray(20,20+fmtSize),64);
  if(factBytes){bytes.set(factGuid,offset);view.setBigUint64(offset+16,32n,true);view.setBigUint64(offset+24,samples,true);offset+=32;}
  bytes.set(dataGuid,offset);view.setBigUint64(offset+16,24n+paddedBytes,true);
  return {bytes,blockAlign,dataBytes,paddedBytes};
}
/** Finite PCM Wave64 mux. Owns the supplied output transaction and aborts it on any failure.
 * Input must be a single contiguous stream starting at sample zero. No input packets are retained.
 */
export async function muxW64(output:WriteHandle,format:W64OutputFormat,packets:AsyncIterable<MediaPacket>,options:W64MuxOptions):Promise<void>{
  try{
    const {signal,maxWriteBytes,sampleCount}=options;signal?.throwIfAborted();
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<=0)throw new WavError('resource-limit','Invalid W64 write limit');
    // Snapshot caller metadata before the first await.
    const stable={...format},{bytes,blockAlign,dataBytes,paddedBytes}=header(stable,sampleCount);
    const write=async(data:Uint8Array)=>{for(let at=0;at<data.length;at+=maxWriteBytes){signal?.throwIfAborted();await output.write(data.subarray(at,at+maxWriteBytes));signal?.throwIfAborted();}};
    await write(bytes);let written=0n;
    for await(const packet of packets){
      signal?.throwIfAborted();const length=packet.data.byteLength;
      if(!length||length%blockAlign!==0||written+BigInt(length)>dataBytes)throw new WavError('invalid-data','Invalid PCM packet length');
      checkWavPacketTiming(packet,written,blockAlign,stable.sampleRate);await write(packet.data);written+=BigInt(length);
    }
    if(written!==dataBytes)throw new WavError('invalid-data','PCM byte count does not match declared duration');
    if(paddedBytes>dataBytes)await write(new Uint8Array(Number(paddedBytes-dataBytes)));
    signal?.throwIfAborted();await output.commit();
  }catch(error){
    try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'W64 mux failed and output abort failed');}
    throw error;
  }
}
