import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
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
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// Inputs stay in gradfun's own storage formats, so no path converts and every byte comes from the kernel.
const formats=['gray','yuv420p','yuv422p','yuv444p','gbrp'],frames=3;
// [T-FRAME] sizes plus 16x16 and 40x23 (radius 4 filters), 41x34 (default radius filters luma), 70x66 (radius 32 filters); 17x9 and 9x9 hit 2r+1 at radius 4.
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[9,9],[16,16],[40,23],[41,34],[70,66]] as const;
const descriptions=['gradfun','gradfun=0.51','gradfun=strength=64','gradfun=radius=4','gradfun=radius=32','gradfun=7.3:5','gradfun=strength=0.51:radius=4','gradfun=64:31'];
const cliDescriptions=['gradfun','gradfun=0.51:4','gradfun=strength=64:radius=4','gradfun=radius=32'];
type Kind='noise'|'ramp'|'edge'|'flat';
const pattern=(format:string,width:number,height:number,kind:Kind)=>{
 const bytes=pixelLayout(format,width,height).bytes;let seed=width*31+height*7+format.length;
 // Slow ramps band (small deltas pass the threshold), hard edges and noise exceed it, flat planes stay flat.
 return Uint8Array.from({length:bytes*frames},(_,i)=>{const n=i%bytes,frame=Math.floor(i/bytes),x=n%width,y=Math.floor(n/width);
  if(kind==='ramp')return (16+((x*5+y*3)>>3)+frame)&255;if(kind==='edge')return x*2<width!==(y&4)>0?40+frame:200;if(kind==='flat')return 128+frame;
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
};
const kinds=['noise','ramp','edge','flat'] as const;
const refused=(format:string,width:number,height:number,description:string)=>{try{compileVideoFilterChain(description).plan(format,width,height);return false;}catch(error){expect((error as Error).message).toContain('2*radius+1 rows');return true;}};
const native=(args:readonly string[])=>spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0',...args],{timeout:20000,maxBuffer:1<<24});
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:referencePixelArithmetic()}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,input:(index:number)=>string,output:string,time:readonly string[]=[])=>{
 const source=(index:number)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input(index)];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...source(0),...(path==='stream'?source(1):[]),...filter,...timing,...time,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
it('reads the sandbox reference build metadata',()=>{
 const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8'));
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native gradfun through the linear, frame graph and replay APIs across formats, strengths, radii, sizes and patterns',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-gradfun-api-'));let matched=0,rejected=0,changed=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of kinds){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of descriptions){
    const label=`${format}/${width}x${height}/${kind}/${description}`;
    if(refused(format,width,height,description)){
     expect(()=>compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null]),label).toThrow('2*radius+1 rows');
     expect(()=>createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4}),label).toThrow('2*radius+1 rows');rejected++;continue;
    }
    const expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;if(!expected.stdout.equals(input))changed++;
   }
  }
  // changed: cases where native's output differs from the input, so the kernel (not a copy) was compared.
  expect([matched,rejected,changed]).toEqual([1656,104,224]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native gradfun rawvideo and framecrc bytes on every flagged CLI path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-gradfun-cli-'));let matched=0,rejected=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of ['noise','ramp'] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of cliDescriptions)for(const muxer of ['rawvideo','framecrc']){
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
  expect([matched,rejected]).toEqual([3960,440]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native gradfun with -ss and -t on every flagged CLI path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-gradfun-time-'));let matched=0;
 try{
  for(const [format,width,height]of [['gray',16,16],['yuv420p',40,23],['gbrp',41,34],['yuv422p',40,23]] as const){
   const input=pattern(format,width,height,'ramp'),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['gradfun=radius=6','gradfun=2.5:4'])for(const muxer of ['rawvideo','framecrc'])for(const time of [['-ss','0.04'],['-t','0.05'],['-ss','0.04','-t','0.04']])for(const path of cliPaths){
    if(refused(format,width,height,description))continue;
    const label=`${path}/${format}/${width}x${height}/${description}/${muxer}/${time}`,sink=collectingOutput();
    const result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,format,width,height,description,muxer,()=>'/in','/out',time)]);
    const expected=native(['-y',...argv(path,format,width,height,description,muxer,()=>file,'-',time)]);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
   }
  }
  expect(matched).toBe(240);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('shows native filtering 2*radius+1-row planes from stale state and refuses them before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-gradfun-stale-'));let rejected=0;
 try{
  // Three identical 9x9 frames at radius 4: native's later frames differ from its first, so the output depends on earlier frames.
  const one=pattern('gray',9,9,'noise').subarray(0,81),input=Uint8Array.from([...one,...one,...one]),file=join(root,'input.raw');writeFileSync(file,input);
  const expected=native(['-f','rawvideo','-pixel_format','gray','-s','9x9','-i',file,'-vf','gradfun=radius=4','-f','rawvideo','-']);expect(expected.status).toBe(0);
  expect(expected.stdout.subarray(81,162).equals(expected.stdout.subarray(0,81))).toBe(false);
  for(const [format,width,height,description]of [['gray',9,9,'gradfun=radius=4'],['gray',40,33,'gradfun'],['yuv420p',20,18,'gradfun=radius=4'],['gbrp',70,65,'gradfun=radius=32']] as const){
   const data=pattern(format,width,height,'noise');
   for(const path of cliPaths){
    let opened=0;const result=await frontend(data,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,format,width,height,description,'rawvideo',()=>'/in','/out')]);
    expect(result.exitCode,`${path} ${format}`).not.toBe(0);expect(opened).toBe(0);expect(JSON.stringify(result.diagnostics)).toContain('2*radius+1 rows');rejected++;
   }
  }
  expect(rejected).toBe(20);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-gradfun-reject-')),input=pattern('gray',16,16,'noise'),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  for(const [description,message]of [['gradfun=strength=0.5','out of range'],['gradfun=strength=64.5','out of range'],['gradfun=radius=3','out of range'],['gradfun=radius=33','out of range'],['gradfun=threshold=1','Option not found'],['gradfun=1:16:3','No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'gray',16,16,description,'rawvideo',()=>file,'-')]);expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',16,16,description,'rawvideo',()=>'/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(30);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and matches every pick on every path, all of them with storage here',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('gradfun=radius=4',negotiationSources,signal,20,12);
 // Every native pick has storage here: packed RGB(A) goes to gbrp (alpha dropped), yuva420p and the yuvj sources to their yuv siblings.
 expect(outcome.refused).toEqual({});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',argb:'gbrp',rgba:'gbrp',abgr:'gbrp',bgra:'gbrp',yuva420p:'yuv420p',gbrp:'gbrp',yuvj420p:'yuv420p',yuvj422p:'yuv422p',yuvj444p:'yuv444p'});
 expect(outcome.checks).toBe(73);
},120000);
