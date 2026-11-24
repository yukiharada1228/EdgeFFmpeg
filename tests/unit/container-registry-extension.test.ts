import {describe,expect,it,vi} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,ResourceBudget,VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerFormats,containerOutputListing,containerOutputOptions,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {Option} from '@edge-ffmpeg/cli';
import {collectingOutput} from '../helpers/output.js';

// Input -ss values edgetag was opened with.
const seeks=vi.hoisted(()=>[] as bigint[]);
// Scratch formats added exactly as a new format is: one descriptor each, listed only in the registry module.
vi.mock('../../packages/containers/src/registry.js',async importOriginal=>{
 const {containerRefusal,defineContainer}=await import('../../packages/containers/src/registry-descriptor.js');
 const {openRawPcm,muxRawPcm}=await import('../../packages/containers/src/raw-pcm.js');
 async function read(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal){
  const data=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);if(!chunk.length||chunk.length>requested)throw new Error('Unexpected scratch read length');data.set(chunk,filled);filled+=chunk.length;}
  return data;
 }
 const after=(input:ReadHandle,offset:bigint):ReadHandle=>({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)});
 return {...await importOriginal<Record<string,unknown>>(),
  // 'EPCM', u16le channels, u32le rate, u16le tag (0 s16le, 1 s16be), then PCM to EOF; native-style 7-sample packets.
  edgepcm:defineContainer({name:'edgepcm',
   demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='EPCM'},headerBytes:12,packetSpan:()=>7n,
    async open(source,{maxReadBytes,signal}){
     if(source.size<12n)throw new Error('Truncated EdgePCM header');
     const view=new DataView((await read(source,0n,12,maxReadBytes,signal)).buffer),tag=view.getUint16(10,true);
     if(tag>1)throw containerRefusal(`Unsupported EdgePCM tag ${tag}`);
     return openRawPcm(after(source,12n),{codec:tag?'pcm_s16be':'pcm_s16le',channels:view.getUint16(4,true),sampleRate:view.getUint32(6,true),channelMask:null,maxReadBytes,signal});
    }},
   mux:{label:'EdgePCM',extensions:['.epcm'],defaultCodec:'pcm_s16be',supports:codec=>codec==='pcm_s16le'||codec==='pcm_s16be',refuse:codec=>containerRefusal(`EdgePCM does not support ${codec}`,234),scratchBytes:12,
    validate:({channels})=>{if(channels>4)throw containerRefusal('EdgePCM supports at most 4 channels',183);},
    async write(output,{codec,channels,sampleRate,samples},packets,{maxWriteBytes,signal}){
     let aborted=false;
     try{
      const header=new Uint8Array(12),view=new DataView(header.buffer);header.set([0x45,0x50,0x43,0x4d]);view.setUint16(4,channels,true);view.setUint32(6,sampleRate,true);view.setUint16(10,codec==='pcm_s16be'?1:0,true);
      for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));}
      await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){aborted=true;await output.abort(reason);}},{codec,channels,sampleRate,channelMask:null},packets,{sampleCount:samples,maxWriteBytes,signal});
     }catch(error){if(!aborted)await output.abort(error);throw error;}
    }}}),
  // A native demuxer without read_probe: found by its extension only (unsigned 8-bit mono 8000 Hz to EOF).
  edgeext:defineContainer({name:'edgeext',demux:{extensions:['.eext'],headerBytes:0,open:(source,{maxReadBytes,signal})=>openRawPcm(source,{codec:'pcm_u8',channels:1,sampleRate:8000,channelMask:null,maxReadBytes,signal})}}),
  // Overlaps wav's RIFF head, so it takes a precedence below wav's 40 and confirms its form type with a bounded read.
  edgeriff:defineContainer({name:'edgeriff',demux:{headerBytes:12,
   probe:{precedence:35,head:bytes=>String.fromCharCode(...bytes)==='RIFF',async confirm(input,maxReadBytes,signal){return input.size>=12n&&String.fromCharCode(...await read(input,8n,4,maxReadBytes,signal))==='EDGE';}},
   open:(source,{maxReadBytes,signal})=>openRawPcm(after(source,12n),{codec:'pcm_u8',channels:1,sampleRate:8000,channelMask:null,maxReadBytes,signal})}}),
  // 'ETAG' then stereo s16le 8000 Hz to EOF, with native global metadata (as a sox comment or extra NIST keys would export).
  edgetag:defineContainer({name:'edgetag',demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='ETAG'},headerBytes:4,
   async open(source,{maxReadBytes,signal,seek}){seeks.push(seek);const raw=await openRawPcm(after(source,4n),{codec:'pcm_s16le',channels:2,sampleRate:8000,channelMask:null,maxReadBytes,signal});return {info:{...raw.info,metadata:true},packets:raw.packets};}}}),
  // Output-only whole-stream checksum with its own option, as -hash is for the hash muxers.
  edgesum:defineContainer({name:'edgesum',mux:{label:'edgesum',defaultCodec:'pcm_s16le',supports:()=>true,options:['-sum'],scratchBytes:64,
   validate:({options})=>{const sum=options.at(-1)?.value??'adler32';if(sum!=='adler32'&&sum!=='bytes')throw containerRefusal(`Unsupported edgesum -sum: ${sum}`,234);},
   async write(output,{options},packets,{signal}){
    try{
     let a=1,b=0,bytes=0;
     for await(const packet of packets){signal.throwIfAborted();for(const byte of packet.data){a=(a+byte)%65521;b=(b+a)%65521;}bytes+=packet.data.length;}
     await output.write(new TextEncoder().encode(options.at(-1)?.value==='bytes'?`BYTES=${bytes}\n`:`ADLER32=0x${(b*65536+a).toString(16).padStart(8,'0')}\n`));await output.commit();
    }catch(error){await output.abort(error);throw error;}
   }}})
 };
});

// Stereo s16le, 8000 Hz, 20 sample frames.
const pcm=new Uint8Array(80);for(let index=0;index<40;index++)new DataView(pcm.buffer).setInt16(index*2,index*257-3000,true);
const edge=(payload:Uint8Array,channels=2,tag=0)=>{const bytes=new Uint8Array(12+payload.length),view=new DataView(bytes.buffer);bytes.set([0x45,0x50,0x43,0x4d]);view.setUint16(4,channels,true);view.setUint32(6,8000,true);view.setUint16(10,tag,true);bytes.set(payload,12);return bytes;};
const swapped=(bytes:Uint8Array)=>Uint8Array.from(bytes,(_,index)=>bytes[index^1]!);
const memory=(bytes:Uint8Array):ReadHandle=>({size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+length);}});
async function run(input:Uint8Array,args:readonly string[]){
 const sink=collectingOutput();let opens=0;
 const filesystem:VirtualFileSystem={async openRead(){return memory(input);},async openWrite(){opens++;return sink.output;}};
 const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
 return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}
// The CLI parser accepts only its own option table, so per-format options are exercised on a parsed command.
async function execute(input:Uint8Array,inputOptions:Option[],outputOptions:Option[],budget:ResourceBudget={maxResidentBytes:1<<20,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:2}){
 const sink=collectingOutput();let opens=0;
 const filesystem:VirtualFileSystem={async openRead(){return memory(input);},async openWrite(){opens++;return sink.output;}};
 const error=await createMediaBackend().execute({global:[],inputs:[{url:'/in.raw',options:inputOptions}],outputs:[{url:'/out.bin',options:outputOptions}]},{filesystem,signal:new AbortController().signal,budget}).then(()=>null,(failure:unknown)=>failure as Error&{code:string;exitCode:number});
 return {error,opens,text:new TextDecoder().decode(sink.bytes())};
}
const raw=[{name:'-f',value:'s16le'},{name:'-ar',value:'8000'},{name:'-ac',value:'2'}];

describe('a container added only through the registry',()=>{
 it('joins the lookups, probe precedence and listings without routing edits',()=>{
  expect(containerFormats.map(format=>format.name)).toEqual(expect.arrayContaining(['edgepcm','edgeext','edgeriff','edgesum','wav']));
  // Real registrations may sit between these; only the relative order is fixed.
  const probed=containerProbes.map(format=>format.name).filter(name=>['w64','au','aiff','edgeriff','wav','edgepcm'].includes(name));
  expect(probed).toEqual(['w64','au','aiff','edgeriff','wav','edgepcm']);
  const listed=containerOutputListing.split(', ');
  expect(listed.slice(0,5)).toEqual(['WAV','AIFF','AU','W64','framecrc']);expect(listed.indexOf('EdgePCM')).toBeLessThan(listed.indexOf('edgesum'));expect(listed).not.toContain('edgeext');
  expect(containerOutputOptions.has('-sum')).toBe(true);expect(containerFormat('edgeext')?.mux).toBeUndefined();
 });
 it('detects by magic, by overlapping head in precedence order, then by input extension',async()=>{
  expect(await detectAudioContainer(memory(edge(pcm)),4)).toBe('edgepcm');
  expect(await detectAudioContainer(memory(edge(pcm)),4,undefined,'/in.eext')).toBe('edgepcm');
  expect(await detectAudioContainer(memory(Uint8Array.from([...'RIFF\0\0\0\0EDGE'].map(c=>c.charCodeAt(0)))),4)).toBe('edgeriff');
  expect(await detectAudioContainer(memory(Uint8Array.from([...'RIFF\0\0\0\0WAVE'].map(c=>c.charCodeAt(0)))),4)).toBe('wav');
  expect(await detectAudioContainer(memory(pcm),4,undefined,'/IN.EEXT')).toBe('edgeext');
  await expect(detectAudioContainer(memory(pcm),4,undefined,'/in.bin')).rejects.toThrow(/^Unsupported audio container signature$/);
  const decoded=await run(pcm,['-i','/in.eext','-f','u8','/out.raw']);expect(decoded.result.exitCode,JSON.stringify(decoded.result.diagnostics)).toBe(0);expect(decoded.bytes).toEqual(pcm);
  const unknown=await run(pcm,['-i','/in.bin','-f','u8','/out.raw']);expect([unknown.last?.message,unknown.opens]).toEqual(['Unsupported audio container signature',0]);
 });
 it('demuxes through the descriptor with its own packet span and refusals',async()=>{
  const reference=await run(pcm,['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','/out.wav']);
  const detected=await run(edge(pcm),['-i','/in.bin','/out.wav']);expect(detected.result.exitCode,JSON.stringify(detected.result.diagnostics)).toBe(0);expect(detected.bytes).toEqual(reference.bytes);
  const big=await run(edge(swapped(pcm),2,1),['-f','edgepcm','-i','/in.bin','/out.wav']);expect(big.bytes).toEqual(reference.bytes);
  // packetSpan: 20 frames copy as 7, 7 and 6-sample packets (the s16le default span at 8000 Hz would be one packet).
  const crc=await run(edge(pcm),['-i','/in.bin','-c:a','copy','-f','framecrc','/out.crc']);
  expect(new TextDecoder().decode(crc.bytes).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,5).map(field=>Number(field)))).toEqual([[0,0,7,28],[7,7,7,28],[14,14,6,24]]);
  const declared=await run(edge(pcm),['-f','edgepcm','-ar','8000','-i','/in.bin','/out.wav']);expect([declared.last?.message,declared.opens]).toEqual(['Input rate/channel declarations currently require a raw PCM format',0]);
  const seek=await run(edge(pcm),['-ss','10','-i','/in.bin','/out.wav']);expect([seek.last?.code,seek.opens]).toEqual(['unsupported-seek',0]);
  const tag=await run(edge(pcm,2,7),['-i','/in.bin','/out.wav']);expect([tag.last?.message,tag.opens]).toEqual(['Unsupported EdgePCM tag 7',0]);
 });
 it('muxes by extension with its default codec and refuses with native statuses before output creation',async()=>{
  const muxed=await run(pcm,['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','/out.EPCM']);expect(muxed.result.exitCode,JSON.stringify(muxed.result.diagnostics)).toBe(0);expect(muxed.bytes).toEqual(edge(swapped(pcm),2,1));
  const back=await run(muxed.bytes,['-i','/in.bin','-c:a','copy','-f','s16be','/out.raw']);expect(back.bytes).toEqual(swapped(pcm));
  const codec=await run(pcm,['-f','s16le','-i','/in.raw','-c:a','pcm_u8','/out.epcm']);expect([codec.result.exitCode,codec.last?.message,codec.opens]).toEqual([234,'EdgePCM does not support pcm_u8',0]);
  const wide=await run(new Uint8Array(100),['-f','s16le','-ac','5','-i','/in.raw','-f','edgepcm','/out.bin']);expect([wide.result.exitCode,wide.last?.message,wide.opens]).toEqual([183,'EdgePCM supports at most 4 channels',0]);
  const demuxOnly=await run(pcm,['-f','s16le','-i','/in.raw','-f','edgeext','/out.bin']);expect([demuxOnly.last?.message,demuxOnly.opens]).toEqual([`Output requires ${containerOutputListing} or an explicit raw PCM format`,0]);
 });
 it('accepts its own output options only on its own format and validates them before output creation',async()=>{
  expect(await execute(pcm,raw,[{name:'-sum',value:'bytes'},{name:'-f',value:'edgesum'}])).toMatchObject({error:null,opens:1,text:'BYTES=80\n'});
  let a=1,b=0;for(const byte of pcm){a=(a+byte)%65521;b=(b+a)%65521;}
  expect(await execute(pcm,raw,[{name:'-f',value:'edgesum'}])).toMatchObject({error:null,text:`ADLER32=0x${(b*65536+a).toString(16).padStart(8,'0')}\n`});
  const bogus=await execute(pcm,raw,[{name:'-f',value:'edgesum'},{name:'-sum',value:'murmur3'}]);expect([bogus.error?.message,bogus.error?.exitCode,bogus.opens]).toEqual(['Unsupported edgesum -sum: murmur3',234,0]);
  const foreign=await execute(pcm,raw,[{name:'-sum',value:'bytes'},{name:'-f',value:'wav'}]);expect([foreign.error?.code,foreign.error?.message,foreign.opens]).toEqual(['unsupported-command','Unsupported output option: -sum',0]);
 });
 it('refuses input metadata for muxers that would write it and passes the input seek to open',async()=>{
  const tagged=Uint8Array.from([0x45,0x54,0x41,0x47,...pcm]);
  for(const name of ['wav','aiff','au']){const refused=await run(tagged,['-i','/in.bin','-f',name,'/out.bin']);expect([refused.result.exitCode,refused.last?.code,refused.last?.message,refused.opens],name).toEqual([1,'unsupported-command',`Input metadata for the ${containerFormat(name)!.mux!.label} muxer is not implemented`,0]);}
  const reference=await run(pcm,['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','-f','w64','/out.bin']);
  const w64=await run(tagged,['-i','/in.bin','-f','w64','/out.bin']);expect(w64.result.exitCode,JSON.stringify(w64.result.diagnostics)).toBe(0);expect(w64.bytes).toEqual(reference.bytes);
  expect((await run(tagged,['-i','/in.bin','-c:a','copy','-f','s16le','/out.raw'])).bytes).toEqual(pcm);
  expect((await run(tagged,['-i','/in.bin','-c:a','copy','-f','framecrc','/out.crc'])).result.exitCode).toBe(0);
  seeks.length=0;
  const seeked=await run(tagged,['-ss','0.001','-i','/in.bin','-f','s16le','/out.raw']);expect(seeked.bytes).toEqual(pcm.subarray(32));
  await run(tagged,['-i','/in.bin','-f','s16le','/out.raw']);expect(seeks).toEqual([1000n,0n]);
 });
 it('feeds header and scratch bytes to the PCM memory plan',async()=>{
  // Copy of one s16 frame: 3 x 4 payload bytes plus metadata-and-mux; edgesum adds 64 scratch bytes, raw output none.
  const budget={maxResidentBytes:75,maxBufferBytes:16,maxCpuTimeMs:1000,maxPendingPackets:2};
  expect((await execute(pcm,raw,[{name:'-c:a',value:'copy'},{name:'-f',value:'s16le'}],budget)).error).toBeNull();
  const refused=await execute(pcm,raw,[{name:'-c:a',value:'copy'},{name:'-f',value:'edgesum'}],budget);expect([refused.error?.code,refused.error?.message,refused.opens]).toEqual(['resource-budget','Estimated simultaneous PCM payload buffers exceed the resident-byte budget',0]);
  expect((await execute(pcm,raw,[{name:'-c:a',value:'copy'},{name:'-f',value:'edgesum'}],{...budget,maxResidentBytes:76})).error).toBeNull();
 });
});
