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
import {unsharpPixelFormats} from '../../packages/avfilter/src/video-ops/unsharp.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
// The sandbox-built reference: the pinned commit without x86 assembly; the binary digest is not pinned.
it('runs against a reference built from commit 946fcce0 with --disable-x86asm',()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');});
/** Inputs stay in unsharp's own storage formats, so no path converts and every byte comes from the kernel. */
const formats=unsharpPixelFormats.filter(executableFormat),frames=3;
const descriptions=['unsharp','unsharp=3:3:-2','unsharp=3:3:-2:3:3:-2','unsharp=lx=23:ly=3:la=1.5:cx=3:cy=23:ca=-0.5','unsharp=la=0:ca=2.5','unsharp=la=0','unsharp=lx=3:ly=3:la=5:cx=5:cy=3:ca=5','unsharp=luma_msize_x=9:luma_msize_y=3:luma_amount=0.3333:chroma_msize_x=7:chroma_msize_y=7:chroma_amount=-1.7','unsharp=ly=3:ax=4:ay=20:aa=0','unsharp=3:3:1:3:3:1:3:3:0','unsharp=ly=3:la=-1:aa=2','unsharp=lx=13:ly=13:la=-2:cx=3:cy=3','unsharp=lx=3:ly=23:la=0.5:ca=1'];
/** Three frames: LCG noise, ramps with hard edges, and a constant plane per component. */
function patterned(format:string,width:number,height:number,count=frames):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,data=new Uint8Array(bytes*count);let seed=width*31+height*7+format.length;
 for(let i=0;i<data.length;i++){const frame=Math.floor(i/bytes)%3,j=i%bytes;if(frame===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed>>>24;}else if(frame===1)data[i]=(j%width)*4%256^((Math.floor(j/width)&2)?255:0);else data[i]=j<width*height?200:j<bytes-width*height||format!=='yuva420p'?64:9;}
 return data;
};
/** Refused here: heights below 4*(luma_msize_y/2), where native runs no slice job and leaves the output unwritten, and nonzero alpha amounts
 * on yuva420p, where native dereferences unallocated FSM storage (probed: SIGSEGV). */
const refusal=(format:string,width:number,height:number,description:string)=>{try{compileVideoFilterChain(description).plan(format,width,height);return null;}catch(error){const message=(error as Error).message;expect(message).toMatch(/Unsharp (heights below|nonzero alpha)/);return message;}};
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
it('matches native unsharp through the linear, frame graph and replay APIs across formats, matrices, amounts, sizes and patterns',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-unsharp-api-'));let matched=0,refused=0;
 try{
  for(const format of formats)for(const [width,height]of [[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[1,8],[2,8],[3,16],[5,24],[3,44]] as const){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   for(const description of descriptions){
    const label=`${format}/${width}x${height}/${description}`,message=refusal(format,width,height,description);
    if(message!==null){
     expect(()=>compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null]),label).toThrow(message);
     expect(()=>createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4}),label).toThrow(message);refused++;continue;
    }
    const expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
    expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
    const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;
   }
  }
  expect([matched,refused]).toEqual([332,240]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native unsharp rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-unsharp-cli-'));let matched=0,refused=0;
 try{
  for(const format of formats)for(const [width,height]of [[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[1,8],[2,8]] as const){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of descriptions)for(const [muxer,inputTime,outputTime]of [['rawvideo',[],[]],['framecrc',[],[]],['framecrc',['-ss','0.04'],['-t','0.05']],['rawvideo',[],['-ss','0.04','-frames:v','1']]] as const){
    const isRefused=refusal(format,width,height,description)!==null;
    for(const path of cliPaths){
     const label=`${path}/${format}/${width}x${height}/${description}/${muxer}/${inputTime}/${outputTime}`;let opened=0;const sink=collectingOutput();
     const result=await frontend(input,backendFor(path),()=>{opened++;return sink.output;}).exec(['-y',...argv(path,format,width,height,description,muxer,'/in','/out',inputTime,outputTime)]);
     if(isRefused){expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toMatch(/Unsharp (heights below|nonzero alpha)/);refused++;continue;}
     const expected=native(['-y',...argv(path,format,width,height,description,muxer,file,'-',inputTime,outputTime)]);expect(expected.status,label+expected.stderr.toString()).toBe(0);
     expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
    }
   }
  }
  expect([matched,refused]).toEqual([3820,4500]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('agrees with native under default slice threads, -filter_threads 1 and 4 on frames tall enough for several slices',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-unsharp-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[9,64],[17,40],[6,33]] as const){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['unsharp','unsharp=3:3:-2:3:3:-2','unsharp=lx=3:ly=9:la=2:cx=9:cy=5:ca=-1.25','unsharp=lx=21:ly=3:la=0.8:cx=3:cy=21:ca=0.6']){
    const outputs=[[],['-filter_threads','1'],['-filter_threads','4']].map(extra=>{const result=native(['-y',...argv('graph',format,width,height,description,'rawvideo',file,'-',[],[],extra)]);expect(result.status,description).toBe(0);return result.stdout;});
    expect(outputs[1],`${format}/${width}x${height}/${description}`).toEqual(outputs[0]);expect(outputs[2],`${format}/${width}x${height}/${description}`).toEqual(outputs[0]);
    for(const path of ['linear','timed'] as const){const sink=collectingOutput();const result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,format,width,height,description,'rawvideo','/in','/out')]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),`${path}/${format}/${width}x${height}/${description}`).toEqual(outputs[0]);count++;}
   }
  }
  expect(count).toBe(96);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('fails like native for oversized and even matrices, out-of-range values and unknown options before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-unsharp-reject-')),input=patterned('yuv420p',8,8),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 const einval=256-constants.errno.EINVAL,erange=256-constants.errno.ERANGE;
 try{
  for(const [description,status,message]of [['unsharp=lx=23:ly=23',einval,'luma matrix size (lx/2+ly/2)*2=44 greater than maximum value 25'],['unsharp=cx=23:cy=5',einval,'chroma matrix size (cx/2+cy/2)*2=26 greater than maximum value 25'],['unsharp=ax=23:ay=23',einval,'alpha matrix size (ax/2+ay/2)*2=44 greater than maximum value 25'],['unsharp=lx=4',einval,'Invalid even size for luma matrix size 4x5'],['unsharp=cy=6',einval,'Invalid even size for chroma matrix size 5x6'],['unsharp=lx=23:ly=23:cx=4',einval,'luma matrix size'],['unsharp=la=5.1',erange,'out of range'],['unsharp=ca=-2.5',erange,'out of range'],['unsharp=ax=24',erange,'out of range'],['unsharp=ly=2',erange,'out of range'],['unsharp=foo=1',null,'Option not found'],['unsharp=1:2:3:4:5:6:7:8:9:10',null,'No option name']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'yuv420p',8,8,description,'rawvideo',file,'-')]);expect(expected.status,description).not.toBe(0);if(status!==null)expect(expected.status,description).toBe(status);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'yuv420p',8,8,description,'rawvideo','/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);if(message.includes('matrix size'))expect(JSON.stringify(result.diagnostics),`${path} ${description}`).toContain(message);count++;
  }
  expect(count).toBe(60);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses unwritten short frames and the unallocated yuva420p alpha path before opening outputs on every path',async()=>{
 let count=0;
 for(const [format,width,height,description,message]of [['yuv420p',8,7,'unsharp','heights below'],['yuv444p',5,3,'unsharp=3:3:1','heights below'],['yuva420p',4,43,'unsharp=lx=3:ly=23','heights below'],['yuva420p',8,8,'unsharp=aa=1','nonzero alpha'],['yuva420p',8,8,'unsharp=ax=3:ay=3:aa=-0.01','nonzero alpha']] as const){
  const input=patterned(format,width,height);
  for(const path of cliPaths){let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,format,width,height,description,'rawvideo','/in','/out')]);expect(result.exitCode,`${path}/${description}`).not.toBe(0);expect(opened,`${path}/${description}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${path}/${description}`).toContain(message);count++;}
 }
 // Native accepts a short frame but writes nothing into it: a constant input comes back as the fresh pool buffer, not as the input.
 const constant=new Uint8Array(pixelLayout('yuv420p',8,6).bytes).fill(100),root=mkdtempSync(join(tmpdir(),'edge-unsharp-short-'));
 try{writeFileSync(join(root,'c.raw'),constant);const result=native(['-f','rawvideo','-pixel_format','yuv420p','-s','8x6','-i',join(root,'c.raw'),'-vf','unsharp','-f','rawvideo','-']);expect(result.status).toBe(0);expect(Buffer.from(result.stdout)).not.toEqual(Buffer.from(constant));}finally{rmSync(root,{recursive:true,force:true});}
 expect(count).toBe(25);
},60000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 // 8x6 sources: ly=3 keeps one slice job natively. gray picks yuvj444p and packed alpha picks yuva444p, neither stored here.
 const outcome=await nativeNegotiationOutcome('unsharp=ly=3:la=1.5:cx=3:cy=3:ca=-1',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p',gray:'yuvj444p'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(93);
},120000);
