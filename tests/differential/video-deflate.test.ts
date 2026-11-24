import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
// Inputs stay in deflate's own formats, so no path converts and every byte comes from the kernel.
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'],sizes=[[2,3],[3,3],[9,7],[16,12]] as const,frames=2;
const descriptions=['deflate','deflate=0:0:0:0','deflate=1:1:1:1','deflate=10:10:10:10','deflate=255:255:255:255','deflate=threshold0=1:threshold1=10:threshold2=0:threshold3=255','deflate=threshold3=0:threshold0=255:threshold1=1:threshold2=10','deflate=threshold0=10:threshold1=0:threshold2=0:threshold3=1','deflate=threshold0=2.5:threshold1=max/2:threshold2=3.5:threshold3=default'];
const pattern=(format:string,width:number,height:number,kind:'noise'|'block')=>{
 const bytes=pixelLayout(format,width,height).bytes;let seed=width*31+height*7+format.length;
 // Blocks give flat areas and hard edges where the threshold and min(sum/8,p) clamps both bind.
 return Uint8Array.from({length:bytes*frames},(_,i)=>{if(kind==='block'){const n=i%bytes;return ((n>>2)+(Math.floor(n/width)>>1)+(i>=bytes?1:0))%2?235:(n*7)%40;}seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
};
// A width-1 plane with a nonzero threshold is refused: native filter_slice reads one sample past that row.
const refused=(format:string,width:number,height:number,description:string)=>{try{compileVideoFilterChain(description).plan(format,width,height);return false;}catch(error){expect((error as Error).message).toContain('narrower than two samples');return true;}};
const native=(args:readonly string[])=>{const result=spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0',...args],{timeout:20000,maxBuffer:1<<24});return result;};
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:referencePixelArithmetic()}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,input:(index:number)=>string,output:string)=>{
 const source=(index:number)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input(index)];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...source(0),...(path==='stream'?source(1):[]),...filter,...timing,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
it('matches native deflate through the linear, frame graph and replay APIs across formats, thresholds, sizes and patterns',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deflate-api-'));let matched=0,rejected=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of ['noise','block'] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of descriptions){
    const label=`${format}/${width}x${height}/${kind}/${description}`;
    if(refused(format,width,height,description)){
     expect(()=>compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null]),label).toThrow('narrower than two samples');
     expect(()=>createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4}),label).toThrow('narrower than two samples');rejected++;continue;
    }
    const expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n]);matched++;
   }
  }
  expect([matched,rejected]).toEqual([390,42]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native deflate rawvideo and framecrc bytes on every flagged CLI path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deflate-cli-'));let matched=0,rejected=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of ['noise','block'] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of descriptions)for(const muxer of ['rawvideo','framecrc']){
    const isRefused=refused(format,width,height,description);
    for(const path of cliPaths){
     const label=`${path}/${format}/${width}x${height}/${kind}/${description}/${muxer}`;let opened=0;const sink=collectingOutput();
     const result=await frontend(input,backendFor(path),()=>{opened++;return sink.output;}).exec(['-y',...argv(path,format,width,height,description,muxer,()=>'/in','/out')]);
     if(isRefused){expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);rejected++;continue;}
     const expected=native(['-y',...argv(path,format,width,height,description,muxer,()=>file,'-')]);expect(expected.status,label+expected.stderr.toString()).toBe(0);
     expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
    }
   }
  }
  expect([matched,rejected]).toEqual([3900,420]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('fails like native for the erosion-only coordinates option and out-of-range thresholds before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deflate-reject-')),input=pattern('gray',9,7,'noise'),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  for(const [description,message]of [['deflate=coordinates=1','Option not found'],['deflate=coordinates=255:threshold0=1','Option not found'],['deflate=threshold0=65536','out of range'],['deflate=threshold2=-1','out of range'],['deflate=1:2:3:4:5','No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'gray',9,7,description,'rawvideo',()=>file,'-')]);expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',9,7,description,'rawvideo',()=>'/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(25);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('copies width-1 planes with zero thresholds like native and refuses nonzero ones before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deflate-narrow-'));let matched=0,rejected=0;
 try{
  for(const [format,width,height,description,accepted]of [['gray',1,5,'deflate=0',true],['yuv444p',1,4,'deflate=0:0:0',true],['yuv420p',1,3,'deflate=0:0:0',true],['yuv420p',2,4,'deflate=threshold0=10:threshold1=0:threshold2=0',true],['yuva420p',2,3,'deflate=7:0:0:9',true],['gray',1,5,'deflate',false],['gbrp',1,3,'deflate=0:0:1',false],['yuv422p',2,2,'deflate=0:0:1',false],['yuva420p',1,2,'deflate=0:0:0',false]] as const){
   const input=pattern(format,width,height,'noise'),file=join(root,'input.raw');writeFileSync(file,input);
   for(const path of cliPaths)for(const muxer of ['rawvideo','framecrc']){
    const label=`${path}/${format}/${width}x${height}/${description}/${muxer}`;let opened=0;const sink=collectingOutput();
    const result=await frontend(input,backendFor(path),()=>{opened++;return sink.output;}).exec(['-y',...argv(path,format,width,height,description,muxer,()=>'/in','/out')]);
    if(!accepted){expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain('narrower than two samples');rejected++;continue;}
    const expected=native(['-y',...argv(path,format,width,height,description,muxer,()=>file,'-')]);expect(expected.status,label).toBe(0);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
   }
  }
  expect([matched,rejected]).toEqual([50,40]);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
