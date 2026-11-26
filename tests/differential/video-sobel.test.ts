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
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;platform:string;arch:string;flags:string[]};
/** Native sums are integers, converted to float. For sobel, prewitt and roberts they stay below 2^12, so a*a+b*b is exact whether or not it
 * is fused, and a power-of-two scale makes sqrt*scale exact, so a fused multiply-add rounds like the unfused pair. Scharr's /256 squares
 * and a 0.3 scale round, so those cases need the unfused x86-64 baseline (macOS arm64 contracts both): they run only on linux-x64,
 * in tests whose titles are constant across platforms. */
const linuxX64=metadata.platform==='linux'&&metadata.arch==='x64';
const portable=['sobel','prewitt','roberts'].flatMap(name=>[name,`${name}=scale=4`,`${name}=delta=-20`,`${name}=delta=30`,`${name}=planes=1`,`${name}=planes=6:delta=30`,`${name}=planes=9:scale=4:delta=-20`,`${name}=15:4:30`]);
const gated=[...['scharr','scharr=scale=4','scharr=delta=-20','scharr=delta=30','scharr=planes=1','scharr=planes=6:delta=30','scharr=planes=9:scale=4:delta=-20','scharr=15:4:30'],...['sobel','prewitt','scharr','roberts'].flatMap(name=>[`${name}=scale=0.3`,`${name}=scale=0.3:delta=-20`,`${name}=planes=5:scale=0.3:delta=30`]),'sobel=scale=0.7','sobel=scale=0.7:delta=-27','prewitt=scale=0.7:delta=-20','scharr=scale=0.7','scharr=scale=0.7:delta=-6'];
// Inputs stay in the operators' own executable formats, so no path converts and every byte comes from the kernel.
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'],sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,frames=3;
type Kind='noise'|'structured';
/** Three frames: LCG noise; or a horizontal step-5 ramp, hard edges and constant planes. The ramp puts sobel, prewitt and scharr magnitudes
 * at exactly 40, 30 and 10 inside, where scale=0.7 lands within one float ulp of an integer: double arithmetic truncates one lower, and a
 * fused multiply-add with the delta below truncates to 0 where the unfused pair gives 1. */
const pattern=(format:string,width:number,height:number,kind:Kind)=>{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);let seed=width*31+height*7+format.length;
 for(let n=0;n<frames;n++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  const i=n*layout.bytes+plane.offset+y*plane.rowBytes+x;
  if(kind==='noise'){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed>>>24;}
  else data[i]=n===0?(x*5+p*50)&255:n===1?((x>>1)+(y>>1)+p)&1?235:16+p:40+p*60;
 }
 return data;
};
const native=(args:readonly string[])=>spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0',...args],{timeout:30000,maxBuffer:1<<24});
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:referencePixelArithmetic()}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:()=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return open();}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,selection:readonly string[],input:string,output:string)=>{
 const source=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...source,...(path==='stream'?source:[]),...filter,...timing,...selection,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
/** One native run per input writes every description's rawvideo; the linear, frame graph and replay APIs must each match it. */
async function apiCases(descriptions:readonly string[],label:string){
 const root=mkdtempSync(join(tmpdir(),`edge-sobel-api-${label}-`));let matched=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of ['noise','structured'] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   const result=native(['-y','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,...descriptions.flatMap((description,index)=>['-vf',description,'-f','rawvideo',join(root,`${index}.raw`)])]);expect(result.status,result.stderr.toString()).toBe(0);
   for(const [index,description]of descriptions.entries()){
    const name=`${format}/${width}x${height}/${kind}/${description}`,expected=readFileSync(join(root,`${index}.raw`));expect(expected.length).toBe(input.length);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),name+' linear').toEqual(expected);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),name+' graph').toEqual(expected);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),name+' stream').toEqual(expected);expect(stamps).toEqual([0n,1n,2n]);matched++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return matched;
}
/** Every CLI path against native, rawvideo and framecrc, with and without output -ss/-t. */
async function cliCases(descriptions:readonly string[],cases:readonly (readonly [string,number,number])[],label:string){
 const root=mkdtempSync(join(tmpdir(),`edge-sobel-cli-${label}-`));let matched=0;
 try{
  for(const [format,width,height]of cases){
   const input=pattern(format,width,height,width===5?'noise':'structured'),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of descriptions)for(const muxer of ['rawvideo','framecrc'])for(const selection of [[],['-ss','0.04','-t','0.05']])for(const path of cliPaths){
    const name=`${path}/${format}/${width}x${height}/${description}/${muxer}/${selection.join(' ')}`;let opened=0;const sink=collectingOutput();
    const result=await frontend(input,backendFor(path),()=>{opened++;return sink.output;}).exec(['-y',...argv(path,format,width,height,description,muxer,selection,'/in','/out')]);
    const expected=native(['-y',...argv(path,format,width,height,description,muxer,selection,file,'-')]);expect(expected.status,name+expected.stderr.toString()).toBe(0);expect(expected.stdout.length,name).toBeGreaterThan(0);
    expect(result.exitCode,JSON.stringify({name,diagnostics:result.diagnostics})).toBe(0);expect(opened,name).toBe(1);expect(sink.committed,name).toBe(true);expect(Buffer.from(sink.bytes()),name).toEqual(expected.stdout);matched++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return matched;
}
const cliInputs=formats.flatMap(format=>[[format,1,1],[format,5,3],[format,17,9]] as const);
it('checks the native reference build at test time',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native sobel, prewitt and roberts through the linear, frame graph and replay APIs with integer-exact scales',async()=>{
 expect(await apiCases(portable,'portable')).toBe(formats.length*sizes.length*2*portable.length);
},300000);
it.skipIf(!linuxX64)('matches native scharr and the inexact 0.3 scales of every operator through the linear, frame graph and replay APIs (linux-x64)',async()=>{
 expect(await apiCases(gated,'gated')).toBe(formats.length*sizes.length*2*gated.length);
},300000);
it('matches native sobel, prewitt and roberts rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path',async()=>{
 expect(await cliCases(['sobel','prewitt=planes=5:scale=4:delta=-20','roberts=15:1:30'],cliInputs,'portable')).toBe(cliInputs.length*3*2*2*5);
},400000);
it.skipIf(!linuxX64)('matches native scharr and inexact scale rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path (linux-x64)',async()=>{
 expect(await cliCases(['scharr=planes=5:scale=0.3:delta=30','sobel=scale=0.7:delta=-27'],cliInputs,'gated')).toBe(cliInputs.length*2*2*2*5);
},400000);
it('agrees with native under default slice threads and -filter_threads 1, and matches it for integer-exact scales',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-sobel-threads-'));let compared=0,matched=0;
 try{
  for(const format of ['gray','yuv420p','gbrp'])for(const [width,height]of [[17,9],[64,48]] as const){
   const input=pattern(format,width,height,'noise'),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of [...portable,...gated]){
    const args=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'],threaded=native(args),single=native(['-filter_threads','1',...args]),name=`${format}/${width}x${height}/${description}`;
    expect(threaded.status,name).toBe(0);expect(single.status,name).toBe(0);expect(threaded.stdout,name).toEqual(single.stdout);compared++;
    if(!portable.includes(description))continue;
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});expect(Buffer.concat(sourceFrames.flatMap(frame=>plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:0}).planes)),name).toEqual(single.stdout);matched++;
   }
  }
  expect([compared,matched]).toEqual([6*(portable.length+gated.length),6*portable.length]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('fails like native for out-of-range and unknown options, and refuses the timeline, before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-sobel-reject-')),input=pattern('gray',9,7,'noise'),file=join(root,'input.raw');writeFileSync(file,input);let count=0,refused=0;
 try{
  for(const [description,message]of [['sobel=planes=16','out of range'],['prewitt=scale=-1','out of range'],['scharr=scale=65536','out of range'],['roberts=delta=-65536','out of range'],['sobel=0m=1','Option not found'],['prewitt=rdiv=1','Option not found'],['roberts=1:2:3:4','No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'gray',9,7,description,'rawvideo',[],file,'-')]);expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',9,7,description,'rawvideo',[],'/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  // Native supports the generic timeline; it is not implemented here and fails explicitly.
  for(const description of ['sobel=enable=1','scharr=planes=1:enable=gte(t\\,0.04)'])for(const path of cliPaths){
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',9,7,description,'rawvideo',[],'/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);refused++;
  }
  expect([count,refused]).toEqual([35,10]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does for sobel, prewitt and roberts and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 for(const description of ['sobel=planes=5:scale=4:delta=-20','prewitt','roberts=planes=3:delta=30']){
  const outcome=await nativeNegotiationOutcome(description,negotiationSources,signal);
  expect(outcome.refused,description).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
  expect(outcome.matched,description).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
  expect(outcome.checks,description).toBe(89);
 }
},240000);
it.skipIf(!linuxX64)('negotiates every accepted source as native does for scharr and refuses the packed-alpha gbrap picks before output on every path (linux-x64)',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('scharr=planes=5:scale=0.3:delta=30',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},240000);
