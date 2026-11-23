import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {describe,expect,it} from 'vitest';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {decodeFlacAudioFrames} from '../../packages/avformat/src/flac-wave-frames.js';
import corpus from '../../compat/behavior-specs/flac-max-frames/cases.json' with {type:'json'};

const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const adler=(bytes:Uint8Array)=>{let a=0,b=0;for(const byte of bytes){a=(a+byte)%65521;b=(b+a)%65521;}return '0x'+((b*65536+a)>>>0).toString(16).padStart(8,'0');};
type Row=typeof corpus.rows[number];
interface Result {data:string;frames:{pts:string;samples:number;channels:number;sampleRate:number;channelLayout:string;sampleFormat:string;bytes:number;checksum:string}[];allocated:number;maxRead:number}
function verify(row:Row,result:Result){
 expect(result.allocated,row.id).toBe(0);expect(result.maxRead).toBeLessThanOrEqual(31);
 const selected=row.maxFrames===null?row.decodedFrames:row.decodedFrames.slice(0,row.maxFrames);
 expect(result.frames.map(frame=>({pts:Number(frame.pts),samples:frame.samples,channels:frame.channels,sampleRate:frame.sampleRate,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat})),row.id).toEqual(selected.map(frame=>({pts:frame.pts,samples:frame.samples,channels:frame.channels,sampleRate:frame.sampleRate,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat})));
 if(row.variant==='raw')expect(hash(Buffer.from(result.data,'base64')),row.id).toBe(row.outputSha256);
 else expect(result.frames.map(frame=>({streamId:0,dts:Number(frame.pts),pts:Number(frame.pts),duration:frame.samples,bytes:frame.bytes,checksum:frame.checksum})),row.id).toEqual(row.packets);
}

describe('FLAC frames against immutable pinned Native evidence',()=>{
 it('pins all 64 rows and trusted Wasm without invoking Native',()=>{
  expect(corpus.rows).toHaveLength(64);expect(new Set(corpus.rows.map(row=>row.id)).size).toBe(64);
  expect(hash(wasm)).toBe(corpus.wasmSha256);expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
  expect([...new Set(corpus.rows.map(row=>row.descriptors[0]!.bitsPerSample))].sort()).toEqual([16,24,32]);
 });
 for(const row of corpus.rows)it(`bridge PCM alignment, PTS and selected frame packets: ${row.id}`,async()=>{
  const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);expect(input.length).toBeLessThanOrEqual(corpus.limits.maxInputBytes);
  const controller=new AbortController(),resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:10000,maxPendingPackets:4},controller.signal);
  let maxRead=0;const frames=decodeFlacAudioFrames(module,{size:BigInt(input.length),async readAt(offset,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}},{resources,signal:controller.signal,maxFrameBytes:65536,maxReadBytes:31});
  const result:Result={data:'',frames:[],allocated:0,maxRead:0},chunks:Uint8Array[]=[];
  try{
   const metadata=await frames.prepare(),descriptor=row.descriptors[0]!;
   expect(metadata).toMatchObject({channels:descriptor.channels,bitsPerSample:descriptor.bitsPerSample,sampleRate:descriptor.sampleRate,totalSamples:BigInt(descriptor.totalSamples),channelLayout:descriptor.channelLayout,sampleFormat:descriptor.sampleFormat});
   while(row.maxFrames===null||result.frames.length<row.maxFrames){
    const item=await frames.next();if(item.done)break;const frame=item.value,data=frame.planes[0]!;
    expect(resources.allocatedBytes).toBe(16777216+31+data.length);
    chunks.push(data.slice());result.frames.push({pts:frame.pts!.value.toString(),samples:frame.samples,channels:frame.channels,sampleRate:frame.sampleRate,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat,bytes:data.length,checksum:adler(data)});
   }
  }finally{await frames.close();}
  result.data=Buffer.concat(chunks).toString('base64');result.allocated=resources.allocatedBytes;result.maxRead=maxRead;verify(row,result);
 });
});

// Native's ashowinfo/threads/fs are capture instrumentation, not PCM transforms.
// Remove only these pairs to exercise the public API's supported command surface.
function publicArgs(row:Row){return row.args.filter((_value,index,args)=>!['-af','-threads:a','-fs'].includes(args[index]!)&&!['-af','-threads:a','-fs'].includes(args[index-1]!));}
for(const row of corpus.rows)it(`public backend frame limit / packet framing: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let commits=0,aborts=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}};},async openWrite(){return {async write(data){chunks.push(data.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
 const result=await ffmpeg.exec(publicArgs(row));expect(result.diagnostics,row.id).toEqual([]);expect(result.exitCode).toBe(row.exitCode);expect(hash(Buffer.concat(chunks)),row.id).toBe(row.outputSha256);expect(commits).toBe(1);expect(aborts).toBe(0);
});

it('runs every Native frames row in real Workers without Node compatibility',async()=>{
 const root=resolve('.'),bundle=await build({stdin:{contents:`
 import module from './edge-flac.wasm';
 import {ResourceContext} from '@edge-ffmpeg/core';
 import {decodeFlacAudioFrames} from './packages/avformat/src/flac-wave-frames.ts';
 const adler=${adler.toString()};
 export default {async fetch(request){
  const row=await request.json(),input=Uint8Array.from(atob(row.input),c=>c.charCodeAt(0));
  const controller=new AbortController(),resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:10000,maxPendingPackets:4},controller.signal);
  let maxRead=0,data='';const stamps=[];
  const source=decodeFlacAudioFrames(module,{size:BigInt(input.length),async readAt(offset,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}},{resources,signal:controller.signal,maxReadBytes:31,maxFrameBytes:65536});
  try{await source.prepare();while(row.maxFrames===null||stamps.length<row.maxFrames){const item=await source.next();if(item.done)break;const frame=item.value,bytes=frame.planes[0];for(const byte of bytes)data+=String.fromCharCode(byte);stamps.push({pts:String(frame.pts.value),samples:frame.samples,channels:frame.channels,sampleRate:frame.sampleRate,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat,bytes:bytes.length,checksum:adler(bytes)});}}
  finally{await source.close();}
  return Response.json({data:btoa(data),frames:stamps,allocated:resources.allocatedBytes,maxRead});
 }};`,resolveDir:root,sourcefile:'flac-max-frames-worker.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name).not.toMatch(/^node:|^\.build\//);expect(name).not.toContain('runtime-node');}
 const mf=new Miniflare(convertV4MiniflareOptions({modulesRoot:root,modules:[{type:'ESModule',path:root+'/flac-max-frames-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],compatibilityDate:'2026-11-18',compatibilityFlags:[]}));
 try{await mf.ready;for(const row of corpus.rows){const response=await mf.dispatchFetch('https://frames.test/',{method:'POST',body:JSON.stringify({input:row.input,maxFrames:row.maxFrames})});expect(response.status,row.id).toBe(200);verify(row,await response.json() as Result);}}
 finally{await mf.dispose();}
},120000);
