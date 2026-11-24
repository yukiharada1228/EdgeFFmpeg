import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
const formats=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'],native=resolve('.build/reference/ffmpeg'),width=5,frames=3;
/** Structured gradients per plane with LCG noise on every third byte. */
const pattern=(format:string,height:number)=>{let seed=0x2545f491;const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const i=f*layout.bytes+plane.offset+y*plane.rowBytes+x;data[i]=(x%3===2?seed>>>24:x*29+y*47+p*83+f*11)&255;}
 return data;};
type Path='linear'|'graph'|'actor'|'timed';
const budget={maxResidentBytes:1<<24,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const backendFor=(path:Path)=>path==='linear'||path==='graph'?createMediaBackend({pixelArithmetic:'scalar'}):createTimedVideoBackend({storage:()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};},limits:{numericProfile:'linux-x64',maxEvents:64,scheduler:(path==='actor'?'activation':'pull') as TimedVideoScheduler}});
async function edge(path:Path,input:Uint8Array,argv:readonly string[]){
 const sinks=new Map<string,ReturnType<typeof collectingOutput>>(),ffmpeg=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(name){const sink=collectingOutput();sinks.set(name,sink);return sink.output;}},backend:backendFor(path),budget});
 const result=await ffmpeg.exec([...argv]);return {result,sinks};
}
/** -vf on linear; one-input -filter_complex on graph, actor and timed. */
const filterArgs=(path:Path,description:string)=>path==='linear'?['-vf',description]:['-filter_complex',`[0:v]${description}[o]`,'-map','[o]'];
const timed=(path:Path)=>path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo']:[];
it('matches native field across every table format, both types, heights and the chained scopes on linear graph actor and timed paths',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-field-'));const counts:Record<string,number>={};
 try{
  for(const format of formats)for(const height of [3,5,7,8,9,12]){
   const input=pattern(format,height),file=join(root,'input.raw');writeFileSync(file,input);
   const descriptions=['field','field=bottom','field=type=top','field=1',...(height===7?['field,hflip','field=bottom,hflip','scale=8:10,field','scale=8:12,field=bottom']:[])];
   for(const description of descriptions)for(const muxer of ['rawvideo','framecrc']){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i'];
    for(const path of ['linear','graph','actor','timed'] as const){
     const after=[...filterArgs(path,description),...timed(path),'-bitexact','-f',muxer],expected=execFileSync(native,['-v','error',...before,file,...after,'-']),label=`${path}/${format}/${height}/${description}/${muxer}`;
     const {result,sinks}=await edge(path,input,[...before,'/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);
     expect(Buffer.from(sinks.get('/out')!.bytes()),label).toEqual(expected);expect(sinks.get('/out')!.committed,label).toBe(true);counts[path]=(counts[path]??0)+1;
    }
   }
  }
  expect(counts).toEqual({linear:784,graph:784,actor:784,timed:784});
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed field streams with a second branch and geometry propagated into vstack',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-field-stream-'));let checked=0;
 try{
  for(const format of formats)for(const height of [5,8]){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,height),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<frames;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]field[out]','[in]field=bottom,hflip[out]','[in]split[x][y];[x]field[l];[y]field=bottom[r];[l][r]vstack[out]','[in]split[x][y];[x]field[l];[y]scale=5:4,field=bottom,scale=5:2[r];[l][r]vstack[out]']){
    if(graph.includes('vstack')&&height===5&&!graph.includes('scale'))continue;
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);for(const [index,plane]of layout.planes.entries())for(let row=0;row<plane.height;row++)chunks.push(frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${height}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(98);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native two-input field streams in rawvideo and framecrc through the multi-input CLI',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-field-multi-'));let checked=0;
 try{
  for(const format of ['yuv420p','nv21','rgba','gbrp','yuv422p']){
   const input=pattern(format,8),file=join(root,'input.raw');writeFileSync(file,input);
   for(const muxer of ['rawvideo','framecrc']){
    const raw=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x8`,'-framerate','25'],outputs=(prefix:string)=>['-map','[a]','-bitexact','-f',muxer,prefix+'0.out','-map','[b]','-bitexact','-f',muxer,prefix+'1.out'],graph='[0:v]field[a];[1:v]field=bottom,vflip[b]';
    execFileSync(native,['-y','-v','error','-cpuflags','0',...raw,'-i',file,...raw,'-i',file,'-filter_complex',graph,...outputs(root+'/')]);
    const {result,sinks}=await edge('graph',input,['-cpuflags','0',...raw,'-i','/in',...raw,'-i','/in','-filter_complex',graph,...outputs('/')]);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${format}/${muxer}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}checked++;
   }
  }
  expect(checked).toBe(10);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses bottom fields of one-row inputs and of subsampled chroma at h % 4 == 2 before opening any output on every path',async()=>{
 let checked=0;
 for(const [format,height]of [['gray',1],['yuv444p',1],['yuv420p',6],['yuva420p',10],['nv12',2],['nv21',14]] as const){
  const input=pattern(format,height),before=['-cpuflags','0','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i'];
  // Native accepts both: a zero-height link that still muxes 5-byte packets, or one chroma row read past the plane. Both are refused here.
  const reference=spawnSync(native,['-v','error',...before,'-',...['-vf','field=bottom','-f','rawvideo','-']],{input,timeout:10000});expect(reference.status,`${format}/${height}`).toBe(0);
  for(const path of ['linear','graph','actor','timed'] as const){
   const {result,sinks}=await edge(path,input,[...before,'/in',...filterArgs(path,'field=bottom'),...timed(path),'-f','rawvideo','/out']);
   expect(result.exitCode,`${path}/${format}/${height}`).not.toBe(0);expect(JSON.stringify(result.diagnostics),`${path}/${format}/${height}`).toMatch(height===1?/empty frame/:/past the subsampled chroma/);expect(sinks.size,`${path}/${format}/${height}`).toBe(0);checked++;
  }
 }
 expect(checked).toBe(24);
},60000);
