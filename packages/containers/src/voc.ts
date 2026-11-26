// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/voc.c, vocdec.c, voc_packet.c (ff_voc_get_packet) and vocenc.c (pinned FFmpeg 946fcce0). See NOTICE-VOC.
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import type {RawPcmInfo} from './raw-pcm.js';
import {framePcmPackets,planPcmFraming} from './pcm-framing.js';
import type {PcmFraming} from './pcm-framing.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class VocError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type VocCodec='pcm_u8'|'pcm_s16le'|'pcm_alaw'|'pcm_mulaw';
export interface VocInfo extends RawPcmInfo {
  readonly container:'voc';readonly codec:VocCodec;
  /** First voice block type (1 or 9), whether a type-8 block precedes it, the block count and the payload of every block but the last. */
  readonly firstBlock:1|9;readonly extended:boolean;readonly blocks:bigint;readonly blockPayload:bigint;readonly lastPayload:bigint;
  /** Native packet span in samples: min(block payload, 2048) bytes. */
  readonly packetSamples:bigint;readonly version:number;readonly copyRefusal?:string;
}
export interface VocInput {readonly info:VocInfo;packets(startSample?:bigint,maxPacketBytes?:number):AsyncIterable<MediaPacket>}
export interface VocOutputFormat {readonly codec:VocCodec;readonly channels:number;readonly sampleRate:number}
/** ff_voc_codec_tags PCM entries with av_get_bits_per_sample; tags 1, 2, 3 and 0x200 are the ADPCM entries. */
const tags:readonly (readonly [VocCodec,number,number])[]=[['pcm_u8',0x00,8],['pcm_s16le',0x04,16],['pcm_alaw',0x06,8],['pcm_mulaw',0x07,8]];
const adpcmTags=[0x01,0x02,0x03,0x200],magic='Creative Voice File\x1A',headerBytes=26,maxPacket=2048n,maxBlock=0xffffff,intMax=2147483647,enosys=218,einval=234;
const ec=(name:VocCodec)=>tags.find(([codec])=>codec===name)!;
export function supportsVocCodec(codec:string):codec is VocCodec{return tags.some(([name])=>name===codec);}
async function readAt(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const available=input.size>offset?input.size-offset:0n,bytes=new Uint8Array(length),count=available<BigInt(length)?Number(available):length;let filled=0;
  while(filled<count){signal?.throwIfAborted();const requested=Math.min(count-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new VocError('invalid-data','Unexpected VOC read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return filled===length?bytes:bytes.subarray(0,filled);
}
/** voc_probe: the 20-byte magic, then ~version + 0x1234 == check in int arithmetic (score 100); a failed check scores 10 and is not claimed. */
export function vocProbeScore(bytes:Uint8Array):0|10|100{
  for(let i=0;i<20;i++)if((bytes[i]??0)!==magic.charCodeAt(i))return 0;
  const version=(bytes[22]??0)|(bytes[23]??0)<<8,check=(bytes[24]??0)|(bytes[25]??0)<<8;
  return ~version+0x1234===check?100:10;
}
/** Type-1 rate 1000000/(256-tc), or the preceding type-8 rate 256000000/(channels*(65536-sr)) when that is nonzero (it always is: the divisor is at most 2^24). */
export function vocBlockRate(timeConstant:number,extended?:{readonly rate:number;readonly channels:number}):number{
  if(extended){const rate=Math.floor(256000000/(extended.channels*(65536-extended.rate)));if(rate)return rate;}
  return Math.floor(1000000/(256-timeConstant));
}
/**
 * Finite range-backed VOC with one uniform packet span: [type 8] type 1 | type 9, then type-2 continuations, then a terminator or EOF.
 * Every block header is read (bounded) before any sample is returned; packets never cross blocks, as ff_voc_get_packet's never do.
 */
export async function openVoc(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<VocInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new VocError('resource-limit','Invalid VOC read budget');
  const header=await readAt(input,0n,headerBytes,maxReadBytes,signal),size16=(header[20]??0)|(header[21]??0)<<8;
  // voc_read_header: avio_rl16 - 22 must be 4, else AVERROR(ENOSYS); bytes past EOF read as zero.
  if(size16-22!==4)throw containerRefusal(`unknown header size: ${size16-22}`,enosys);
  if(header.length<headerBytes)throw new VocError('invalid-data','Truncated VOC header');
  const version=header[22]!|header[23]!<<8;
  let position=BigInt(headerBytes),extended:{rate:number;channels:number}|undefined,first:{type:1|9;codec:VocCodec;channels:number;sampleRate:number;bits:number;payload:bigint;offset:bigint}|undefined;
  let blocks=0n,blockPayload=0n,lastPayload=0n,dataBytes=0n,irregular=false;
  for(;;){
    signal?.throwIfAborted();
    const head=await readAt(input,position,4,maxReadBytes,signal);
    if(!head.length||head[0]===0)break;
    if(head.length<4)throw new VocError('invalid-data','Truncated VOC block header');
    const type=head[0]!,size=head[1]!|head[2]!<<8|head[3]!<<16;position+=4n;
    // Size 0 means "to EOF" natively (seekable input only); not mirrored.
    if(!size)throw new VocError('unsupported','VOC blocks of size 0 are not implemented');
    let payload:bigint;
    if(type===8){
      if(first||extended)throw new VocError('unsupported','VOC extended blocks other than one before the first voice block are not implemented');
      if(size!==4)throw new VocError('unsupported','VOC extended blocks other than 4 bytes are not implemented');
      const b=await readAt(input,position,4,maxReadBytes,signal);if(b.length<4)throw new VocError('invalid-data','Truncated VOC block');
      extended={rate:b[0]!|b[1]!<<8,channels:b[3]!+1};position+=4n;continue;
    }else if(type===1||type===9){
      if(first)throw new VocError('unsupported','Repeated VOC voice data blocks (mid-stream codec or rate changes) are not implemented');
      if(type===9&&extended)throw new VocError('unsupported','A VOC extended block before a type 9 block is not implemented');
      const fields=type===1?2:12;
      if(size<fields)throw new VocError('invalid-data',`Invalid VOC block ${type} size ${size}`);
      const b=await readAt(input,position,fields,maxReadBytes,signal);if(b.length<fields)throw new VocError('invalid-data','Truncated VOC block');
      const view=new DataView(b.buffer,b.byteOffset,b.byteLength),tag=type===1?b[1]!:view.getUint16(6,true),entry=tags.find(([,value])=>value===tag);
      if(!entry)throw adpcmTags.includes(tag)?new VocError('unsupported',`VOC ADPCM codec tag ${tag} is not implemented`):new VocError('invalid-data','unknown codec tag');
      let channels:number,sampleRate:number,bits:number;
      if(type===1){channels=extended?.channels??1;sampleRate=vocBlockRate(b[0]!,extended);bits=0;}
      else{const rate=view.getUint32(0,true);if(!rate||rate>intMax)throw new VocError('invalid-data',`Invalid sample rate ${rate|0}`);sampleRate=rate;bits=b[4]!;channels=b[5]!;if(!channels)throw new VocError('invalid-data','Invalid VOC channel count 0');}
      position+=BigInt(fields);payload=BigInt(size-fields);
      first={type,codec:entry[0],channels,sampleRate,bits,payload,offset:position};
    }else if(type===2){
      if(!first)throw new VocError('unsupported','A VOC continuation block before the first voice block is not implemented');
      payload=BigInt(size);
    }else throw new VocError('unsupported',`VOC block type ${type} is not implemented`);
    if(!payload)throw new VocError('unsupported','Empty VOC voice blocks are not implemented');
    if(input.size-position<payload)throw new VocError('invalid-data','Truncated VOC block');
    if(blocks===0n)blockPayload=payload;else if(lastPayload!==blockPayload)irregular=true;
    lastPayload=payload;blocks++;dataBytes+=payload;position+=payload;
  }
  if(!first)throw new VocError('invalid-data','VOC input has no voice data');
  const {codec,channels,sampleRate,bits}=first,blockAlign=channels*(codec==='pcm_s16le'?2:1);
  // Every block but the last holds the same payload P: P <= 2048 (then the last holds at most P) or P % 2048 == 0, so native packets have one span.
  if(blocks===1n)blockPayload=lastPayload;
  const span=blockPayload<maxPacket?blockPayload:maxPacket;
  if(irregular||blocks>1n&&(blockPayload>maxPacket&&blockPayload%maxPacket!==0n||blockPayload<maxPacket&&lastPayload>blockPayload))throw new VocError('unsupported','VOC block layouts without one uniform packet span are not implemented');
  if(blockPayload%BigInt(blockAlign)||lastPayload%BigInt(blockAlign)||span%BigInt(blockAlign))throw new VocError('unsupported','VOC blocks or packets that split a sample frame are not implemented');
  // A type-1 block leaves bits_per_coded_sample 0 and a type-9 block carries its own: copy into a VOC muxer would write them, so copy keeps only native widths.
  const copyRefusal=type1Width(first.type,codec,bits)?undefined:'Copying VOC input whose block bit width differs from the codec width is not implemented';
  const info:VocInfo=Object.freeze({container:'voc' as const,codec,channels,sampleRate,channelMask:null,bitsPerSample:ec(codec)[2],blockAlign,dataOffset:first.offset,dataBytes,durationSamples:dataBytes/BigInt(blockAlign),
    firstBlock:first.type,extended:!!extended,blocks,blockPayload,lastPayload,packetSamples:span/BigInt(blockAlign),version,...(copyRefusal?{copyRefusal}:{})});
  const timeBase=Object.freeze({num:1n,den:BigInt(sampleRate)}),stride=blockPayload+4n,align=BigInt(blockAlign);
  return Object.freeze({info,
    async *packets(startSample=0n,maxPacketBytes=maxReadBytes):AsyncIterable<MediaPacket>{
      signal?.throwIfAborted();
      if(startSample<0n||startSample>info.durationSamples)throw new VocError('invalid-data','VOC seek outside input');
      if(!Number.isSafeInteger(maxPacketBytes)||maxPacketBytes<blockAlign||maxPacketBytes>maxReadBytes)throw new VocError('resource-limit','Invalid VOC packet budget');
      const packetBytes=BigInt(Math.floor(maxPacketBytes/blockAlign)*blockAlign);let logical=startSample*align;
      while(logical<dataBytes){
        signal?.throwIfAborted();
        let block=logical/blockPayload;if(block>blocks-1n)block=blocks-1n;
        const within=logical-block*blockPayload,blockBytes=block===blocks-1n?lastPayload:blockPayload,left=blockBytes-within,length=left<packetBytes?left:packetBytes;
        const offset=(block?first.offset+first.payload+4n+(block-1n)*stride:first.offset)+within,data=await readAt(input,offset,Number(length),maxReadBytes,signal);
        if(BigInt(data.length)!==length)throw new VocError('invalid-data','Unexpected VOC read length');
        const pts=logical/align;yield {streamIndex:0,data,pts,dts:pts,duration:length/align,timeBase,flags:1};logical+=length;
      }
    }
  });
}
function type1Width(type:1|9,codec:VocCodec,bits:number):boolean{return type===1?codec==='pcm_u8':bits===ec(codec)[2];}
function checkOutput(format:VocOutputFormat):void{
  const {codec,channels,sampleRate}=format;
  if(!supportsVocCodec(codec))throw containerRefusal('unsupported codec',einval);
  if(!Number.isInteger(channels)||channels<1||channels>255||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>intMax)throw new VocError('invalid-data','Invalid VOC output parameters');
  // vocenc.c multiplies rate by channels in int for the type-8 word.
  if(codec==='pcm_u8'&&channels>1&&sampleRate*channels>intMax)throw new VocError('unsupported','VOC extended block rate overflows int');
}
/** voc_write_header: magic, header size 26, version 0x0114 and its check word. */
export function vocFileHeader():Uint8Array{
  const bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);
  for(let i=0;i<20;i++)bytes[i]=magic.charCodeAt(i);
  view.setUint16(20,headerBytes,true);view.setUint16(22,0x0114,true);view.setUint16(24,(~0x0114+0x1234)&0xffff,true);return bytes;
}
/** voc_write_packet's first-packet header: type 9 for codec tags above 3, else [type 8 when multichannel] and type 1. */
export function vocFirstBlockHeader(format:VocOutputFormat,size:number):Uint8Array{
  checkOutput(format);
  const {codec,channels,sampleRate}=format,[,tag,bits]=ec(codec);
  if(!Number.isSafeInteger(size)||size<1||size+(tag>3?12:2)>maxBlock)throw new VocError('unsupported','VOC packets above the 24-bit block size are not implemented');
  if(tag>3){const b=new Uint8Array(16),v=new DataView(b.buffer);b[0]=9;v.setUint32(0,9|(size+12)<<8,true);v.setUint32(4,sampleRate,true);b[8]=bits;b[9]=channels;v.setUint16(10,tag,true);return b;}
  const out:number[]=[];
  if(channels>1){const word=(65536-Math.floor((256000000+Math.floor(sampleRate*channels/2))/(sampleRate*channels)))&0xffff;out.push(8,4,0,0,word&255,word>>8,tag,channels-1);}
  const tc=(256-Math.floor((1000000+Math.floor(sampleRate/2))/sampleRate))&255;
  out.push(1,(size+2)&255,(size+2)>>8&255,(size+2)>>16,tc,tag);return Uint8Array.from(out);
}
/** Validation available before opening an output transaction. */
export function validateVocOutput(format:VocOutputFormat):void{checkOutput(format);}
export interface VocMuxOptions {readonly maxWriteBytes:number;readonly signal?:AbortSignal;readonly framing:PcmFraming}
/** One block per native packet (framing): the first carries the stream parameters, later ones are type-2 continuations; then the 0 terminator. */
export async function muxVoc(output:WriteHandle,format:VocOutputFormat,packets:AsyncIterable<MediaPacket>,options:VocMuxOptions):Promise<void>{
  try{
    const stable={...format},{maxWriteBytes,signal}=options;signal?.throwIfAborted();
    checkOutput(stable);
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new VocError('resource-limit','Invalid VOC write budget');
    const plan=planPcmFraming(options.framing,'voc',message=>new VocError('invalid-data',message)),align=(stable.codec==='pcm_s16le'?2:1)*stable.channels;
    if(plan.blockAlign!==align)throw new VocError('invalid-data','Invalid voc framing');
    const write=async(bytes:Uint8Array)=>{for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(bytes.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}};
    await write(vocFileHeader());
    let started=false,open=false;
    for await(const piece of framePcmPackets(plan,packets,signal)){
      if(!open){
        const size=Number(piece.duration)*align;
        if(!started)await write(vocFirstBlockHeader(stable,size));
        else{if(size>maxBlock)throw new VocError('unsupported','VOC packets above the 24-bit block size are not implemented');await write(Uint8Array.of(2,size&255,size>>8&255,size>>16));}
        started=open=true;
      }
      await write(piece.bytes);if(piece.end)open=false;
    }
    await write(Uint8Array.of(0));
    signal?.throwIfAborted();await output.commit();
  }catch(error){try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'VOC output and abort failed');}throw error;}
}
/** Registered by `export {voc} from './voc.js';` in registry.ts. */
export const voc=defineContainer({
  name:'voc',
  // Exact head 'Crea'; the confirm reads the 26 bytes voc_probe inspects and claims only its score-100 case.
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='Crea',async confirm(input,maxReadBytes,signal){return vocProbeScore(await readAt(input,0n,headerBytes,maxReadBytes,signal))===100;}},headerBytes:64,
    // Native input -ss goes through voc_read_seek's index and seek_frame_generic; it is not mirrored.
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('VOC input seeking is not implemented');return openVoc(source,{maxReadBytes,signal});},packetSpan:(info:VocInfo)=>info.packetSamples},
  mux:{label:'VOC',extensions:['.voc'],defaultCodec:'pcm_s16le',supports:supportsVocCodec,refuse:()=>containerRefusal('unsupported codec',einval),scratchBytes:64,dropsMetadata:true,
    validate:({codec,channels,sampleRate})=>validateVocOutput({codec:codec as VocCodec,channels,sampleRate}),
    write:(output,{codec,channels,sampleRate},packets,{maxWriteBytes,signal,framing})=>muxVoc(output,{codec:codec as VocCodec,channels,sampleRate},packets,{maxWriteBytes,signal,framing})}
});
