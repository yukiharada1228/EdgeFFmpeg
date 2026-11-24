import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const reference=resolve('.build/reference/ffmpeg'),sizes=[[5,3],[7,5],[8,6]] as const,time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const chains=['copy','copy,negate','format=nv12,copy,vflip','copy,hflip'],scopes:readonly (readonly [readonly string[],readonly string[]])[]=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-t','0.05']]];
/** Structured ramps in the first frame, LCG noise in the others. */
const pattern=(format:string,width:number,height:number,frames=3)=>{const bytes=pixelLayout(format,width,height).bytes;let seed=(width*131+height*17+format.length)>>>0;return Uint8Array.from({length:bytes*frames},(_,i)=>{if(i<bytes)return (i*7+(i%width)*29)&255;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});};
const memoryFiles=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output']):VirtualFileSystem=>({async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}});
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createMediaBackend({pixelArithmetic:referencePixelArithmetic()}),budget});
const timedStores=()=>{const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];const storage:TimedVideoBackendOptions['storage']=()=>{const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};return {storage,closed:()=>stores.every(store=>store.closed===1&&store.values.size===0)};};
const timedBackend=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'],storage:TimedVideoBackendOptions['storage'])=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}),budget});
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>decodeRawVideo({streamIndex:0,data,pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.map((plane,index)=>Buffer.concat(Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));};
it('matches native -vf copy chains across all 14 formats, sizes and timing scopes as rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-copy-cli-'));let count=0,identities=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of chains)for(const [inputTime,outputTime]of scopes)for(const muxer of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25',...inputTime],after=['-vf',chain,...outputTime,'-bitexact','-f',muxer],label=`${format}/${width}x${height}/${chain}/${inputTime}/${outputTime}/${muxer}`;
    const native=execFileSync(reference,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']),sink=collectingOutput(),result=await media(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(native);count++;
    // Identity: the native output is the input itself.
    if(chain==='copy'&&muxer==='rawvideo'&&!inputTime.length&&!outputTime.length){expect(native,label).toEqual(Buffer.from(input));identities++;}
   }
  }
  expect([count,identities]).toEqual([14*3*4*3*2,14*3]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native -filter_complex split and copy branches across all 14 formats as rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-copy-graph-'));let count=0;
 try{
  for(const format of negotiationOrder){
   const input=pattern(format,7,5),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of ['[0:v]split[a][b];[a]copy[left];[b]copy,hflip[right]','[0:v]copy,split[left][right]','[0:v]format=nv12,split[a][b];[a]copy[left];[b]vflip,copy[right]','[0:v]split[a][b];[a]copy,negate[left];[b]copy,copy[right]'])for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-f','rawvideo','-pixel_format',format,'-s','7x5','-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...scope,'-bitexact','-f',muxer,prefix+index+'.out']);
    execFileSync(reference,['-y','-v','error','-cpuflags','0',...before,'-i',file,'-filter_complex',graph,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await media(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',graph,...outputs('/')]);expect(result.exitCode,JSON.stringify({format,graph,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${format}/${graph}/${muxer}/${scope}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
   }
  }
  expect(count).toBe(14*4*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed copy graphs frame by frame across all 14 formats and sizes',async()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-copy-stream-'));let count=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input.slice(index*frameBytes,(index+1)*frameBytes),format,width,height,index);}}};}};
   for(const graph of ['[in]copy[out]','[in]copy,hflip[out]','[in]split[x][y];[x]copy[l];[y]copy,nullsink;[l]copy[out]','[in]format=nv12,copy,vflip[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=execFileSync(reference,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-']);
    expect(Buffer.concat(chunks),`${format}/${width}x${height}/${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);if(graph==='[in]copy[out]')expect(native).toEqual(Buffer.from(input));count++;
   }
  }
  expect(count).toBe(14*3*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native copy through activation actors and the timed backend as rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-copy-timed-'));let actorCount=0,timedCount=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of ['copy','copy,hflip','format=nv12,copy,vflip','copy,copy']){
    const native=execFileSync(reference,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',chain,'-f','rawvideo','-']);
    const actors=createFrameActors(chain,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:{format,width,height}}]}),chunks:Buffer[]=[];
    try{for(let index=0;index<3;index++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input.slice(index*frameBytes,(index+1)*frameBytes),format,width,height,index)});actors.endInput(0,EOF,3n);
     for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${format}/${width}x${height}/${chain}`).toEqual(native);actorCount++;
    for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
     const args=['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','/in','-vf',chain,...scope,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,'/out'],label=`timed ${format}/${width}x${height}/${chain}/${muxer}/${scope}`;
     const expected=execFileSync(reference,['-v','error','-cpuflags','0',...args.slice(1,-1).map(value=>value==='/in'?file:value),'-']),sink=collectingOutput(),stores=timedStores(),result=await timedBackend(input,()=>sink.output,stores.storage).exec(args);
     expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(stores.closed()).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected);timedCount++;
    }
   }
  }
  expect([actorCount,timedCount]).toEqual([14*3*4,14*3*4*4]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses copy options before opening any output, as native does except for the generic threads option',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-copy-reject-'));let count=0;
 try{
  const input=pattern('gray',5,3),file=join(root,'input.raw');writeFileSync(file,input);
  // Native accepts the generic AVFilterContext threads option; the scoped adaptation refuses every option instead of ignoring it.
  for(const [description,complex,nativeFails]of [['copy=enable=1',false,true],['copy=threads=1',false,false],['copy=a=b',false,true],['copy=foo',false,true],['null,copy=enable=gte(t\\,0)',false,true],['[0:v]split[a][b];[a]copy=enable=1[left];[b]copy[right]',true,true]] as const){
   const before=['-f','rawvideo','-pixel_format','gray','-s','5x3'],after=complex?['-filter_complex',description,'-map','[left]','-f','rawvideo','OUT0','-map','[right]','-f','rawvideo','OUT1']:['-vf',description,'-f','rawvideo','OUT0'];
   const native=spawnSync(reference,['-y','-v','error',...before,'-i',file,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status!==0,description).toBe(nativeFails);
   for(const backend of ['media','timed'] as const){
    let opened=0;const open=()=>{opened++;return collectingOutput().output;},stores=timedStores(),ffmpeg=backend==='media'?media(input,open):timedBackend(input,open,stores.storage);
    const result=await ffmpeg.exec([...before,'-i','/in',...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);expect(result.exitCode,`${backend} ${description}`).not.toBe(0);expect(opened,`${backend} ${description}`).toBe(0);count++;
   }
  }
  expect(count).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
