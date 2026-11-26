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
import {casVideoFrame,parseCasOptions} from '../../packages/avfilter/src/video-ops/cas.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
/** cas_slice8 is single-precision float per sample; the Math.fround emulation is unfused like the x86-64 baseline, while macOS arm64
 * may contract the multiply-adds. Float cases run on linux-x64 only; planes=0 (a copy of every plane) and refusals run everywhere. */
const unfused=process.platform==='linux'&&process.arch==='x64';
const ffmpeg=resolve('.build/reference/ffmpeg');
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,frames=3;
/** Defaults, each option at its extremes and typical values, flag arithmetic and the unenforced flags range. */
const descriptions=['cas','cas=0','cas=1','cas=0.5','cas=strength=0.3:planes=15','cas=0.25:1','cas=strength=0.8:planes=6','cas=0.999:planes=0xff','cas=0.75:planes=-1','cas=1:planes=0x2+8','cas=planes=0'] as const;
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise; structured ramps with 0/255 edges; a zero half (the NaN quotient of an all-zero neighbourhood) beside a constant half with spikes. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const layout=pixelLayout(format,width,height),bytes=layout.bytes,ramp=new Uint8Array(bytes),flat=new Uint8Array(bytes);
 for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  const n=plane.offset+y*plane.width+x;ramp[n]=x===0?255:y===plane.height-1?0:(x*61+y*23+index*40+seed)&255;
  flat[n]=n<bytes/2?0:n%7===0?250:(seed*37)&255;
 }
 return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const native=(args:readonly string[],threads=false)=>spawnSync(ffmpeg,['-v','error','-cpuflags','0',...(threads?['-filter_threads','1']:[]),...args],{timeout:20000,maxBuffer:1<<24});
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,time:readonly string[],input:string,output:string)=>{
 const source=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return ['-y',...source,...(path==='stream'?source:[]),...filter,...timing,...time,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
/** Kernel, linear chain, frame graph and replay stream against native rawvideo, with native's default threads and -filter_threads 1. */
async function apiCases(list:readonly string[],root:string):Promise<number>{
 let matched=0;
 for(const format of formats)for(const [width,height]of sizes){
  const input=pattern(format,width,height,width*31+height*7+format.length),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
  for(const description of list){
   const label=`${format}/${width}x${height}/${description}`,args=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'];
   const expected=native(args),single=native(args,true);expect(expected.status,label+expected.stderr.toString()).toBe(0);expect(single.stdout,label+' threads').toEqual(expected.stdout);
   const step=parseCasOptions(description.slice(4)||null);
   expect(Buffer.concat(sourceFrames.flatMap(frame=>casVideoFrame(frame,step,{maxFrameBytes:1<<20}).planes)),label+' kernel').toEqual(expected.stdout);
   const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
   expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
   expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
   const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
   try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
   expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;
  }
 }
 return matched;
}
it.skipIf(!unfused)('matches native cas through the kernel, linear, frame graph and replay APIs across formats, sizes, strengths and planes (Linux x64 unfused float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-cas-api-'));
 try{expect(await apiCases(descriptions,root)).toBe(396);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native cas=planes=0 copies through the kernel, linear, frame graph and replay APIs on every platform',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-cas-copy-api-'));
 try{expect(await apiCases(['cas=planes=0','cas=1:planes=0x10'],root)).toBe(72);}finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Every flagged CLI path, rawvideo and framecrc, with and without -ss/-t. */
async function cliCases(list:readonly string[],cliSizes:readonly (readonly [number,number])[],root:string):Promise<number>{
 let matched=0;
 for(const format of formats)for(const [width,height]of cliSizes){
  const input=pattern(format,width,height,width*13+height*3+format.length),file=join(root,'input.raw');writeFileSync(file,input);
  for(const description of list)for(const muxer of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']] as const){
   for(const path of cliPaths){
    const label=`${path}/${format}/${width}x${height}/${description}/${muxer}/${time.join(' ')}`,sink=collectingOutput();
    const expected=native(argv(path,format,width,height,description,muxer,time,file,'-'));expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const result=await frontend(input,backendFor(path),()=>sink.output).exec(argv(path,format,width,height,description,muxer,time,'/in','/out'));
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
   }
  }
 }
 return matched;
}
it.skipIf(!unfused)('matches native cas rawvideo and framecrc bytes on every flagged CLI path (Linux x64 unfused float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-cas-cli-'));
 try{expect(await cliCases(['cas','cas=1:planes=5','cas=strength=0.6:planes=0xf'],[[1,1],[7,5],[17,9]],root)).toBe(1080);}finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native cas=planes=0 copies on every flagged CLI path on every platform',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-cas-copy-cli-'));
 try{expect(await cliCases(['cas=planes=0'],[[2,2],[5,3]],root)).toBe(240);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses cas timelines, expressions and out-of-range or unknown options before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-cas-reject-')),input=pattern('gray',5,3,7),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  // Native accepts these; the refusals are scope limits (enable=, the generic threads option, av_expr expressions and constants).
  for(const description of ['cas=enable=1','cas=threads=2','cas=0.5:enable=gt(t\\,0.04)','cas=strength=1/2','cas=strength=max','cas=strength=default:planes=1'])for(const path of cliPaths){
   const expected=native(argv(path,'gray',5,3,description,'rawvideo',[],file,'-'));expect(expected.status,description+expected.stderr.toString()).toBe(0);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(argv(path,'gray',5,3,description,'rawvideo',[],'/in','/out'));
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  // Native refuses these too.
  for(const [description,message]of [['cas=strength=1.5','out of range'],['cas=-0.1','out of range'],['cas=sharpness=1','Option not found'],['cas=0.5:3:1','No option name'],['cas=planes=0.5','not a valid set']] as const)for(const path of cliPaths){
   const expected=native(argv(path,'gray',5,3,description,'rawvideo',[],file,'-'));expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(argv(path,'gray',5,3,description,'rawvideo',[],'/in','/out'));
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(55);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
const negotiated={yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'};
const packedAlpha={argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'};
it('negotiates every accepted cas=planes=0 source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('cas=planes=0',negotiationSources,signal);
 expect(outcome.refused).toEqual(packedAlpha);expect(outcome.matched).toEqual(negotiated);expect(outcome.checks).toBe(89);
},120000);
it.skipIf(!unfused)('negotiates every accepted sharpening cas source as native does and refuses the packed-alpha gbrap picks before output on every path (Linux x64 unfused float)',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('cas=0.7:planes=0xf',negotiationSources,signal);
 expect(outcome.refused).toEqual(packedAlpha);expect(outcome.matched).toEqual(negotiated);expect(outcome.checks).toBe(89);
},120000);
