import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
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
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// Native runs at test time from the sandbox build; only its commit and configuration are pinned, never a binary digest.
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
// Inputs stay in deblock's executable formats, so no path converts and every byte comes from the kernel.
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'],sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[16,16],[33,17]] as const,frames=3;
type Kind='noise'|'blocky'|'ramp';
const descriptions=['deblock','deblock=filter=weak','deblock=filter=strong:block=4','deblock=weak:4','deblock=block=5:alpha=1:beta=1:gamma=1:delta=1','deblock=weak:block=6:alpha=1:beta=1:gamma=1:delta=1','deblock=block=4:alpha=0:beta=0:gamma=0:delta=0',
 'deblock=block=4:alpha=1:beta=0:gamma=1:delta=1','deblock=block=4:alpha=1:beta=1:gamma=0:delta=1','deblock=block=4:alpha=1:beta=1:gamma=1:delta=0','deblock=block=512:alpha=1:beta=1:gamma=1:delta=1','deblock=strong:4:0.3:0.2:0.15:0.1:5','deblock=weak:4:0.0118:0.0118:0.0118:0.0118:10','deblock=block=4:planes=0'];
/** Per-plane noise, 4x4 blocks with small steps (where default thresholds bind) plus a hard edge, or ramps with constant chroma planes. */
const pattern=(format:string,width:number,height:number,kind:Kind)=>{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);let seed=width*31+height*7+format.length+kind.length;
 const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  const value=kind==='noise'?noise():kind==='blocky'?(x===plane.width-3&&y>1?250:100+6*((Math.floor(x/4)*3+Math.floor(y/4)*5+n+index)%5)+(noise()&3)):index===0?(x*9+y*5+n*3)&255:index===3?255:128;
  data[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=value;
 }
 return data;
};
// Native's vertical-edge kernels read past the row when an edge lies within one (weak) or two (strong) samples of the right border.
const message='read outside the plane';
const refused=(format:string,width:number,height:number,description:string)=>{try{compileVideoFilterChain(description).plan(format,width,height);return false;}catch(error){expect((error as Error).message).toContain(message);return true;}};
const native=(args:readonly string[])=>spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0',...args],{timeout:20000,maxBuffer:1<<24});
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,input:(index:number)=>string,output:string,trimmed=false)=>{
 const source=(index:number)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...(trimmed&&index===0?['-ss','0.04']:[]),'-i',input(index)];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...source(0),...(path==='stream'?source(1):[]),...filter,...timing,...(trimmed?['-t','0.05']:[]),'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
it('runs against the sandbox reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native deblock through the linear, frame graph and replay APIs across formats, sizes, patterns and options',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deblock-api-'));let matched=0,rejected=0,changed=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of ['noise','blocky','ramp'] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of descriptions){
    const label=`${format}/${width}x${height}/${kind}/${description}`;
    if(refused(format,width,height,description)){
     expect(()=>compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null]),label).toThrow(message);
     expect(()=>createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4}),label).toThrow(message);rejected++;continue;
    }
    const expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;if(!expected.stdout.equals(Buffer.from(input)))changed++;
   }
  }
  expect([matched,rejected,changed]).toEqual([1446,570,245]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native deblock rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deblock-cli-'));let matched=0,rejected=0;
 try{
  for(const format of formats)for(const [width,height]of [[7,5],[8,6],[17,9],[16,16],[33,17]] as const){
   const input=pattern(format,width,height,'blocky'),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['deblock','deblock=weak:4','deblock=block=5:alpha=1:beta=1:gamma=1:delta=1','deblock=weak:block=6:alpha=1:beta=1:gamma=1:delta=1','deblock=block=512'])for(const muxer of ['rawvideo','framecrc'])for(const trimmed of [false,true]){
    const isRefused=refused(format,width,height,description);
    for(const path of cliPaths){
     const label=`${path}/${format}/${width}x${height}/${description}/${muxer}/${trimmed}`;let opened=0;const sink=collectingOutput();
     const result=await frontend(input,backendFor(path),()=>{opened++;return sink.output;}).exec(['-y',...argv(path,format,width,height,description,muxer,()=>'/in','/out',trimmed)]);
     if(isRefused){expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message);rejected++;continue;}
     const expected=native(['-y',...argv(path,format,width,height,description,muxer,()=>file,'-',trimmed)]);expect(expected.status,label+expected.stderr.toString()).toBe(0);
     expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
    }
   }
  }
  expect([matched,rejected]).toEqual([1980,1020]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('stops each vertical edge at its first skipped row like native on every CLI path',async()=>{
 // Native's vertical kernels advance dst at the end of the loop body, which continue skips: rows after a skipped row stay unfiltered.
 const root=mkdtempSync(join(tmpdir(),'edge-deblock-stop-'));let count=0;
 try{
  for(const [description,skipped]of [['deblock=weak:4:1:1:1',[0,6]],['deblock=strong:4:1:1:1:1',[1,5]]] as const){
   const rows=Array.from({length:8},(_,y)=>(skipped as readonly number[]).includes(y)?[0,0,0,0,255,255,255,255]:[10,10,10,10,20,20,20,20]),input=Uint8Array.from([0,1,2].flatMap(()=>rows.flat())),file=join(root,'input.raw');writeFileSync(file,input);
   for(const path of cliPaths){
    const sink=collectingOutput(),result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,'gray',8,8,description,'rawvideo',()=>'/in','/out')]),expected=native(['-y',...argv(path,'gray',8,8,description,'rawvideo',()=>file,'-')]);
    expect(expected.status).toBe(0);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),`${path}/${description}`).toEqual(expected.stdout);
    // Rows before the first skipped row of each band are filtered; the rest are copied unchanged.
    const first=expected.stdout.subarray(0,64);for(let y=0;y<8;y++)expect(first.subarray(y*8,y*8+8).equals(Buffer.from(rows[y]!)),`${description} row ${y}`).toBe(y>=skipped[0]&&y<4||y>=skipped[1]);count++;
   }
  }
  expect(count).toBe(10);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('agrees with native under default filter threads and -filter_threads 1',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deblock-threads-'));let count=0;
 try{
  for(const format of ['gray','yuv420p','gbrp'])for(const description of ['deblock','deblock=weak:4:1:1:1:1','deblock=block=4:alpha=1:beta=1:gamma=1:delta=1:planes=6']){
   const input=pattern(format,16,16,'blocky'),file=join(root,'input.raw');writeFileSync(file,input);
   const args=['-f','rawvideo','-pixel_format',format,'-s','16x16','-i',file,'-vf',description,'-f','rawvideo','-'],threaded=native(args),single=native(['-filter_threads','1',...args]);
   expect(threaded.status).toBe(0);expect(single.status).toBe(0);expect(threaded.stdout).toEqual(single.stdout);
   const plan=compileVideoFilterChain(description).plan(format,16,16,{arithmetic:'scalar'});
   expect(Buffer.concat(decoded(input,format,16,16).flatMap(frame=>plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes}).planes))).toEqual(threaded.stdout);count++;
  }
  expect(count).toBe(9);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('fails like native for out-of-range and unknown deblock options before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-deblock-reject-')),input=pattern('gray',16,16,'noise'),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  for(const [description,text]of [['deblock=block=3','out of range'],['deblock=block=513','out of range'],['deblock=alpha=1.5','out of range'],['deblock=delta=-0.1','out of range'],['deblock=filter=2','out of range'],['deblock=planes=16','out of range'],['deblock=filter=medium','Unable to parse'],['deblock=foo=1','Option not found'],['deblock=strong:8:0.1:0.1:0.1:0.1:15:1','No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'gray',16,16,description,'rawvideo',()=>file,'-')]);expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(text);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',16,16,description,'rawvideo',()=>'/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(45);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('deblock=block=4:alpha=1:beta=1:gamma=1:delta=1',negotiationSources,signal);
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 // Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
