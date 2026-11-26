import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
import {collectingOutput} from '../helpers/output.js';
// Byte copy only: every run uses -cpuflags 0 natively and scalar arithmetic here, so the implicit format=nv12 conversion stays scalar.
const native=resolve('.build/reference/ffmpeg'),sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
/** Native status for an EINVAL refusal on this host (filter syntax errors), and AVERROR_PATCHWELCOME / AVERROR_OPTION_NOT_FOUND low bytes. */
const hostEinval=(256-constants.errno.EINVAL)&255,patchWelcome=176,optionNotFound=8;
const chains=['pixdesctest','pixdesctest,hflip','format=nv12,pixdesctest'],scopes:readonly (readonly [readonly string[],readonly string[]])[]=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-t','0.05']]];
function checkReference(){
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Three frames: ramps, edges and a constant plane in the first, edge stripes over LCG noise in the others. */
function pattern(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=(width*131+height*17+format.length)>>>0;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const edge=x===0||y===0||x===plane.rowBytes-1||y===plane.height-1;
  out[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=n===0?(index===layout.planes.length-1&&index>0?0x80:edge?255:(x*29+y*7)&255):edge?(n&1?0:255):seed>>>24;
 }
 return out;
}
const memoryFiles=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output']):VirtualFileSystem=>({async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}});
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createMediaBackend({pixelArithmetic:'scalar'}),budget});
const timedStores=()=>{const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];const storage:TimedVideoBackendOptions['storage']=()=>{const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};return {storage,closed:()=>stores.every(store=>store.closed===1&&store.values.size===0)};};
const timed=(scheduler:TimedVideoScheduler)=>(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'],storage=timedStores().storage)=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128,scheduler}}),budget});
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.map((plane,index)=>Buffer.concat(Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));};
it('matches native -vf pixdesctest chains across all 14 formats, sizes and timing scopes as rawvideo and framecrc',async()=>{
 checkReference();const root=mkdtempSync(join(tmpdir(),'edge-pixdesctest-cli-'));let count=0,identities=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of chains)for(const [inputTime,outputTime]of scopes)for(const muxer of ['rawvideo','framecrc']){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25',...inputTime],after=['-vf',chain,...outputTime,'-bitexact','-f',muxer],label=`${format}/${width}x${height}/${chain}/${inputTime}/${outputTime}/${muxer}`;
    const expected=execFileSync(native,['-v','error',...before,'-i',file,...after,'-']),sink=collectingOutput(),result=await media(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
    // The descriptor round trip is the identity on every storage format: native output equals the input.
    if(chain==='pixdesctest'&&muxer==='rawvideo'&&!inputTime.length&&!outputTime.length){expect(expected,label).toEqual(Buffer.from(input));identities++;}
   }
  }
  expect([count,identities]).toEqual([14*6*3*3*2,14*6]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native -filter_complex pixdesctest split branches through the media and timed backends as rawvideo and framecrc',async()=>{
 checkReference();const root=mkdtempSync(join(tmpdir(),'edge-pixdesctest-graph-'));let count=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of ['[0:v]split[a][b];[a]pixdesctest[left];[b]pixdesctest,hflip[right]','[0:v]format=nv12,pixdesctest,split[left][right]'])for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...scope,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,prefix+index+'.out']);
    execFileSync(native,['-y','-v','error',...before,'-i',file,'-filter_complex',graph,...outputs(root+'/')]);
    for(const [name,backend]of [['media',media],['producer',timed('producer')],['pull',timed('pull')]] as const){
     const sinks=new Map<string,ReturnType<typeof collectingOutput>>(),label=`${name}/${format}/${width}x${height}/${graph}/${muxer}/${scope}`;
     const result=await backend(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec(['-y',...before,'-i','/in','-filter_complex',graph,...outputs('/')]);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);
     for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
    }
   }
  }
  expect(count).toBe(14*6*2*2*2*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native pixdesctest frame by frame through replay streams and activation actors across all 14 formats and sizes',async()=>{
 checkReference();const root=mkdtempSync(join(tmpdir(),'edge-pixdesctest-stream-'));let streams=0,actors=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input,format,width,height,index);}}};}};
   for(const chain of [...chains,'pixdesctest,pixdesctest']){
    const expected=execFileSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',`[0:v]${chain}[out]`,'-map','[out]','-f','rawvideo','-']),label=`${format}/${width}x${height}/${chain}`;
    const execution=createReplayVideoExecution(`[in]${chain}[out]`,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),`stream/${label}`).toEqual(expected);expect(stamps).toEqual([0n,1n,2n]);streams++;
    const actor=createFrameActors(chain,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:{format,width,height}}]}),frames:Buffer[]=[];
    try{for(let index=0;index<3;index++)actor.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input,format,width,height,index)});actor.endInput(0,EOF,3n);
     for(let attempt=0;attempt<16;attempt++){const result=await actor.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}frames.push(tight(result.event!.frame));}}finally{actor.dispose();}
    expect(Buffer.concat(frames),`actor/${label}`).toEqual(expected);actors++;
   }
  }
  expect([streams,actors]).toEqual([14*6*4,14*6*4]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('negotiates every source as native does, keeping its own format through pixdesctest on every path',async({signal})=>{
 checkReference();
 // Native has no query_formats: every source keeps its format (legacy yuvj sources on linear chains only), so nothing is refused.
 const outcome=await nativeNegotiationOutcome('pixdesctest',negotiationSources,signal);
 expect(outcome.refused).toEqual({});expect(outcome.matched).toEqual(Object.fromEntries(negotiationSources.map(source=>[source,source])));
 expect(outcome.checks).toBe(14*5+3);
},120000);
it('refuses pixdesctest options before opening any output, with native status for pixdesctest=1',async()=>{
 checkReference();const root=mkdtempSync(join(tmpdir(),'edge-pixdesctest-reject-'));let count=0;const statuses:Record<string,number|null>={};
 try{
  const input=pattern('gray',5,3),file=join(root,'input.raw');writeFileSync(file,input);
  // Native accepts the generic AVFilterContext threads option; the scoped adaptation refuses every option instead of ignoring it.
  for(const [description,complex]of [['pixdesctest=1',false],['pixdesctest=enable=1',false],['pixdesctest=threads=1',false],['pixdesctest=a=b',false],['null,pixdesctest=enable=gte(t\\,0)',false],['[0:v]split[a][b];[a]pixdesctest=1[left];[b]pixdesctest[right]',true]] as const){
   const before=['-f','rawvideo','-pixel_format','gray','-s','5x3'],after=complex?['-filter_complex',description,'-map','[left]','-f','rawvideo','OUT0','-map','[right]','-f','rawvideo','OUT1']:['-vf',description,'-f','rawvideo','OUT0'];
   statuses[description]=spawnSync(native,['-y','-v','error',...before,'-i',file,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000}).status;
   for(const [name,backend]of [['media',media],['producer',timed('producer')],['pull',timed('pull')]] as const){
    let opened=0;const result=await backend(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in',...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
    // EdgeFFmpeg reports every plan-time filter refusal with the generic CLI status 1; native statuses are pinned below.
    expect(result.exitCode,`${name} ${description}`).toBe(1);expect(opened,`${name} ${description}`).toBe(0);count++;
   }
  }
  expect(statuses).toEqual({'pixdesctest=1':hostEinval,'pixdesctest=enable=1':patchWelcome,'pixdesctest=threads=1':0,'pixdesctest=a=b':optionNotFound,'null,pixdesctest=enable=gte(t\\,0)':patchWelcome,'[0:v]split[a][b];[a]pixdesctest=1[left];[b]pixdesctest[right]':hostEinval});expect(count).toBe(18);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
