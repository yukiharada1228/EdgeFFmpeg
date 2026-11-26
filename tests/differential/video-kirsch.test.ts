import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
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
import {kirschPixelFormats} from '../../packages/avfilter/src/video-ops/kirsch.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
/** |sum|*scale+delta is unfused float on the x86-64 baseline; macOS arm64 contracts it into an FMA. Integer cases (scale=1, delta=0) run everywhere. */
const linuxX64=process.platform==='linux'&&process.arch==='x64';
// The sandbox-built reference: the pinned commit without x86 assembly; the binary digest is not pinned.
it('runs against a reference built from commit 946fcce0 with --disable-x86asm',()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');});
/** Inputs stay in kirsch's own storage formats, so no path converts and every byte comes from the kernel. */
const formats=kirschPixelFormats.filter(executableFormat),frames=3;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[1,8],[2,8],[8,1]] as const;
/** Exact in float: scale 1 and delta 0, with every plane mask. */
const integer=['kirsch','kirsch=planes=0','kirsch=planes=1','kirsch=planes=6','kirsch=planes=9','kirsch=15:1:0','kirsch=planes=10:scale=1:delta=0','kirsch=planes=8'];
/** Float scale and delta: halves, tens, fractions with float rounding, negative and positive deltas, and the range ends. */
const float=['kirsch=scale=0.5','kirsch=scale=10','kirsch=delta=-40','kirsch=delta=25.5','kirsch=scale=0.5:delta=-20','kirsch=planes=5:scale=10:delta=-300','kirsch=scale=0.37:delta=-3.3','kirsch=scale=0.1:delta=0.7','kirsch=scale=0:delta=100.9','kirsch=scale=65535:delta=-65535','kirsch=scale=0.0667:delta=0.49999','kirsch=3:0.333:1e1','kirsch=scale=0.7:delta=-0.1','kirsch=scale=0.01:delta=0.3','kirsch=scale=0.03:delta=2.2','kirsch=scale=0.13:delta=-0.3','kirsch=scale=0.7:delta=0.9'];
/** Three frames: LCG noise, ramps with hard edges and isolated spikes, and a constant plane per component. */
function patterned(format:string,width:number,height:number,count=frames):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*count);let seed=width*31+height*7+format.length;
 for(let n=0;n<count;n++)for(const [index,plane]of layout.planes.entries())for(let i=0;i<plane.bytes;i++){
  const at=n*layout.bytes+plane.offset+i,x=i%plane.width,y=Math.floor(i/plane.width),kind=n%3;
  if(kind===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[at]=seed>>>24;}else if(kind===1)data[at]=(x*4+y*29)%7===3?255:(x*37%256)^((y&2)?255:0);else data[at]=[200,64,9,141][index]!;
 }
 return data;
}
const native=(args:readonly string[])=>spawnSync(ffmpeg,['-v','error','-cpuflags','0',...args],{timeout:20000,maxBuffer:1<<24});
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:input.length/bytes},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:()=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return open();}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
/** CLI argv shared by native and every frontend path; stream adds a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,input:string,output:string,inputTime:readonly string[]=[],outputTime:readonly string[]=[],extra:readonly string[]=[])=>{
 const source=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...inputTime,'-i',input];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...extra,...source,...(path==='stream'?source:[]),...filter,...timing,...outputTime,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
/** native -vf rawvideo bytes against compileVideoFilterChain, compileVideoFilterGraph and createReplayVideoExecution. */
async function apiCases(descriptions:readonly string[],label:string):Promise<number>{
 const root=mkdtempSync(join(tmpdir(),`edge-kirsch-api-${label}-`));let matched=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of descriptions){
    const name=`${format}/${width}x${height}/${description}`,expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,name+expected.stderr.toString()).toBe(0);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),name+' linear').toEqual(expected.stdout);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),name+' graph').toEqual(expected.stdout);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),name+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return matched;
}
const scopes=[['rawvideo',[],[]],['framecrc',[],[]],['framecrc',['-ss','0.04'],['-t','0.05']],['rawvideo',[],['-ss','0.04','-frames:v','1']]] as const;
/** native rawvideo and framecrc bytes against the CLI frontend on every flagged path, with and without -ss and -t. */
async function cliCases(descriptions:readonly string[],cliSizes:readonly (readonly [number,number])[],label:string):Promise<number>{
 const root=mkdtempSync(join(tmpdir(),`edge-kirsch-cli-${label}-`));let matched=0;
 try{
  for(const format of formats)for(const [width,height]of cliSizes){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of descriptions)for(const [muxer,inputTime,outputTime]of scopes)for(const path of cliPaths){
    const name=`${path}/${format}/${width}x${height}/${description}/${muxer}/${inputTime}/${outputTime}`,sink=collectingOutput();
    const expected=native(['-y',...argv(path,format,width,height,description,muxer,file,'-',inputTime,outputTime)]);expect(expected.status,name+expected.stderr.toString()).toBe(0);
    const result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,format,width,height,description,muxer,'/in','/out',inputTime,outputTime)]);
    expect(result.exitCode,JSON.stringify({name,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,name).toBe(true);expect(Buffer.from(sink.bytes()),name).toEqual(expected.stdout);matched++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return matched;
}
it('matches native kirsch with scale 1 and delta 0 through the linear, frame graph and replay APIs across formats, plane masks, sizes and patterns',async()=>{
 expect(await apiCases(integer,'integer')).toBe(formats.length*sizes.length*integer.length);
},240000);
it.skipIf(!linuxX64)('matches native kirsch float scale and delta through the linear, frame graph and replay APIs (linux-x64 unfused float)',async()=>{
 expect(await apiCases(float,'float')).toBe(formats.length*sizes.length*float.length);
},240000);
const cliSizes=[[1,1],[2,2],[5,3],[17,9]] as const;
it('matches native kirsch rawvideo and framecrc bytes with scale 1 and delta 0 on every flagged CLI path with and without -ss and -t',async()=>{
 const descriptions=['kirsch','kirsch=planes=6','kirsch=planes=9:scale=1:delta=0'];
 expect(await cliCases(descriptions,cliSizes,'integer')).toBe(formats.length*cliSizes.length*descriptions.length*scopes.length*cliPaths.length);
},600000);
it.skipIf(!linuxX64)('matches native kirsch float rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t (linux-x64 unfused float)',async()=>{
 const descriptions=['kirsch=scale=0.5:delta=-20','kirsch=planes=5:scale=10:delta=25.5','kirsch=scale=0.37:delta=-3.3','kirsch=scale=0.7:delta=-0.1'];
 expect(await cliCases(descriptions,cliSizes,'float')).toBe(formats.length*cliSizes.length*descriptions.length*scopes.length*cliPaths.length);
},600000);
it('agrees with native under default slice threads and -filter_threads 1 on frames tall enough for several slices',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-kirsch-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[9,64],[17,40],[6,33]] as const){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['kirsch','kirsch=planes=5']){
    const outputs=([['linear',[]],['linear',['-filter_threads','1']],['graph',[]],['graph',['-filter_complex_threads','1']]] as const).map(([path,extra])=>{const result=native(['-y',...argv(path,format,width,height,description,'rawvideo',file,'-',[],[],extra)]);expect(result.status,description).toBe(0);return result.stdout;});
    for(const output of outputs.slice(1))expect(output,`${format}/${width}x${height}/${description}`).toEqual(outputs[0]);
    for(const path of ['linear','timed'] as const){const sink=collectingOutput();const result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,format,width,height,description,'rawvideo','/in','/out')]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),`${path}/${format}/${width}x${height}/${description}`).toEqual(outputs[0]);count++;}
   }
  }
  expect(count).toBe(formats.length*3*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('fails like native for out-of-range values, unknown options and extra positional values before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-kirsch-reject-')),input=patterned('yuv420p',8,8),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 const erange=256-constants.errno.ERANGE;
 try{
  for(const [description,status,message]of [['kirsch=planes=16',erange,'out of range'],['kirsch=planes=-1',erange,'out of range'],['kirsch=scale=-0.5',erange,'out of range'],['kirsch=scale=65536',erange,'out of range'],['kirsch=delta=-65536',erange,'out of range'],['kirsch=delta=65535.5',erange,'out of range'],['kirsch=foo=1',null,'Option not found'],['kirsch=1:1:0:4',null,'No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'yuv420p',8,8,description,'rawvideo',file,'-')]);expect(expected.status,description).not.toBe(0);if(status!==null)expect(expected.status,description).toBe(status);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'yuv420p',8,8,description,'rawvideo','/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(40);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses enable=, float expressions and generic options that native accepts before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-kirsch-scope-')),input=patterned('gray',8,8),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  for(const [description,message]of [['kirsch=enable=gte(t\\,0.04)','timeline'],['kirsch=scale=1/2','Only decimal kirsch scale'],['kirsch=delta=-PI','Only decimal kirsch delta'],['kirsch=threads=1','Unsupported kirsch option']] as const){
   expect(native(['-y',...argv('graph','gray',8,8,description,'rawvideo',file,'-')]).status,description).toBe(0);
   for(const path of cliPaths){let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',8,8,description,'rawvideo','/in','/out')]);expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${path} ${description}`).toContain(message);count++;}
  }
  expect(count).toBe(20);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Integer scale and delta keep this case exact on every platform. Packed RGB with alpha picks gbrap, which has no frame storage here.
 const outcome=await nativeNegotiationOutcome('kirsch=planes=13',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
