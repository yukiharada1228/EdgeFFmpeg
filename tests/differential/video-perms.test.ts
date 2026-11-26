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
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// Native runs at test time with -cpuflags 0 and this side with scalar arithmetic, so the implicit conversions in front of negate
// stay on the scalar swscale path. perms does no pixel arithmetic: every case is integer or copy and runs on every platform.
const reference=resolve('.build/reference/ffmpeg'),sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const forms=['perms','perms=ro','perms=rw','perms=toggle','perms=random:7','perms=mode=toggle:seed=0'] as const;
const scopes:readonly (readonly [readonly string[],readonly string[]])[]=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-t','0.05']]];
/** Three frames per plane: ramps, a vertical edge and a constant plane in the first, LCG noise in the others. */
const pattern=(format:string,width:number,height:number,frames=3)=>{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=(width*131+height*17+format.length)>>>0;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;out[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=n?seed>>>24:index===layout.planes.length-1&&index>0?0x80:index===1?(x<plane.rowBytes>>1?0:255):(x*29+y*7)&255;
 }
 return out;
};
const memoryFiles=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output']):VirtualFileSystem=>({async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}});
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createMediaBackend({pixelArithmetic:'scalar'}),budget});
const timedStores=()=>{const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];const storage:TimedVideoBackendOptions['storage']=()=>{const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};return {storage,closed:()=>stores.every(store=>store.closed===1&&store.values.size===0)};};
const timedBackend=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'],storage:TimedVideoBackendOptions['storage'])=>new FFmpeg({filesystem:memoryFiles(input,open),backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}),budget});
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>decodeRawVideo({streamIndex:0,data,pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.map((plane,index)=>Buffer.concat(Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));};
it('runs the unpinned reference built from FFmpeg 946fcce0 with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
 expect(execFileSync(reference,['-hide_banner','-filters']).toString()).toMatch(/ perms +V->V +Set permissions for the output video frame/);
});
it('matches native -vf perms modes alone and chained with hflip and negate across all 14 formats, sizes and timing scopes as rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-perms-cli-'));let count=0,identities=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const form of forms)for(const chain of [form,`${form},hflip`,`negate,${form},perms=toggle`])for(const [scope,[inputTime,outputTime]]of scopes.entries())for(const muxer of ['rawvideo','framecrc']){
    // The timing scopes rotate over the sizes so each chain still meets every scope and muxer in every format.
    if((scope+width)%3===2&&muxer==='framecrc')continue;
    const before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25',...inputTime],after=['-vf',chain,...outputTime,'-bitexact','-f',muxer],label=`${format}/${width}x${height}/${chain}/${inputTime}/${outputTime}/${muxer}`;
    const native=execFileSync(reference,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']),sink=collectingOutput(),result=await media(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(native);count++;
    // Frame bytes are identical for every mode: the native output of perms alone is the input itself.
    if(chain===form&&muxer==='rawvideo'&&!scope){expect(native,label).toEqual(Buffer.from(input));identities++;}
   }
  }
  expect([count,identities]).toEqual([14*sizes.length*6*3*5,14*sizes.length*6]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native -filter_complex split and perms branches across all 14 formats as rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-perms-graph-'));let count=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of [[1,1],[5,3],[17,9]] as const){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const [index,form]of forms.entries())for(const graph of [`[0:v]split[a][b];[a]${form}[left];[b]${form},hflip[right]`,`[0:v]${form},split[left][right]`,`[0:v]split[a][b];[a]negate,${form}[left];[b]perms=rw,${form}[right]`])for(const muxer of ['rawvideo','framecrc']){
    const scope=(index+width)%2?['-ss','0.04','-frames:v','1']:[],before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...scope,'-bitexact','-f',muxer,prefix+index+'.out']);
    execFileSync(reference,['-y','-v','error','-cpuflags','0',...before,'-i',file,'-filter_complex',graph,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await media(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',graph,...outputs('/')]);expect(result.exitCode,JSON.stringify({format,graph,result})).toBe(0);
    for(const output of [0,1]){const sink=sinks.get(`/${output}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${format}/${width}x${height}/${graph}/${muxer}/${scope}/${output}`).toEqual(readFileSync(join(root,output+'.out')));}count++;
   }
  }
  expect(count).toBe(14*3*6*3*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native perms frame by frame through replay streams and activation actors across all 14 formats and sizes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-perms-stream-'));let streamCount=0,actorCount=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height),file=join(root,'input.raw'),frame=(index:number)=>decode(input.slice(index*frameBytes,(index+1)*frameBytes),format,width,height,index);writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield frame(index);}}};}};
   for(const form of forms)for(const chain of [form,`${form},hflip`,`vflip,${form},perms=toggle`]){
    const native=execFileSync(reference,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',`[0:v]${chain}[out]`,'-map','[out]','-f','rawvideo','-']),label=`${format}/${width}x${height}/${chain}`;
    for(const graph of [`[in]${chain}[out]`,`[in]split[x][y];[x]${chain}[out];[y]${form},nullsink`]){
     const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
     try{for await(const value of execution.outputs[0]!.frames){chunks.push(tight(value));stamps.push(value.pts!.value);}}finally{await execution.close();}
     expect(Buffer.concat(chunks),`stream ${label}/${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);streamCount++;
    }
    const actors=createFrameActors(chain,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:{format,width,height}}]}),chunks:Buffer[]=[];
    try{for(let index=0;index<3;index++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:frame(index)});actors.endInput(0,EOF,3n);
     for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${label}`).toEqual(native);actorCount++;
   }
  }
  expect([streamCount,actorCount]).toEqual([14*sizes.length*18*2,14*sizes.length*18]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native perms through the timed backend as rawvideo and framecrc with and without -ss and -frames',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-perms-timed-'));let count=0;
 try{
  for(const format of negotiationOrder)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const [index,form]of forms.entries())for(const chain of [form,`${form},hflip`,`vflip,${form},perms=toggle`])for(const muxer of ['rawvideo','framecrc']){
    const scope=(index+width+muxer.length)%2?['-ss','0.04','-frames:v','1']:[];
    const args=['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','/in','-vf',chain,...scope,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,'/out'],label=`timed ${format}/${width}x${height}/${chain}/${muxer}/${scope}`;
    const expected=execFileSync(reference,['-v','error','-cpuflags','0',...args.slice(1,-1).map(value=>value==='/in'?file:value),'-']),sink=collectingOutput(),stores=timedStores(),result=await timedBackend(input,()=>sink.output,stores.storage).exec(args);
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(stores.closed()).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
   }
  }
  expect(count).toBe(14*sizes.length*6*3*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses perms forms outside scope before opening any output and asserts the native exit status of each',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-perms-reject-'));let count=0;
 try{
  const input=pattern('gray',5,3),file=join(root,'input.raw');writeFileSync(file,input);
  // Native exits with the low byte of the negative AVERROR: EINVAL and ERANGE from the host errno table, 8 for AVERROR_OPTION_NOT_FOUND.
  const status=(errno:number)=>256-errno,EINVAL=status(constants.errno.EINVAL),ERANGE=status(constants.errno.ERANGE);
  // Native accepts numeric modes, octal and hex seeds, enable=, threads= and an unseeded random mode (av_get_random_seed); all are refused here.
  for(const [description,complex,nativeStatus,message]of [['perms=bogus',false,EINVAL,'Unsupported perms mode: bogus'],['perms=mode=RO',false,EINVAL,'Unsupported perms mode: RO'],['perms=mode=1',false,0,'Unsupported perms mode: 1'],
   ['perms=seed=-2',false,ERANGE,'Invalid perms seed: -2'],['perms=seed=4294967296',false,ERANGE,'Invalid perms seed: 4294967296'],['perms=seed=07',false,0,'Invalid perms seed: 07'],['perms=seed=0x7',false,0,'Invalid perms seed: 0x7'],
   ['perms=random',false,0,'perms random mode requires an explicit seed'],['perms=random:-1',false,0,'perms random mode requires an explicit seed'],
   ['perms=enable=1',false,0,'Unsupported perms option: enable'],['null,perms=ro:enable=gte(t\\,0)',false,0,'Unsupported perms option: enable'],['perms=threads=1',false,0,'Unsupported perms option: threads'],['perms=foo=1',false,8,'Unsupported perms option: foo'],
   ['perms=ro:7:1',false,EINVAL,'Missing filter option name'],['perms=mode=ro:7',false,EINVAL,'Missing filter option name'],
   ['[0:v]split[a][b];[a]perms=enable=1[left];[b]perms[right]',true,0,'Unsupported perms option: enable']] as const){
   const before=['-f','rawvideo','-pixel_format','gray','-s','5x3'],after=complex?['-filter_complex',description,'-map','[left]','-f','rawvideo','OUT0','-map','[right]','-f','rawvideo','OUT1']:['-vf',description,'-f','rawvideo','OUT0'];
   const native=spawnSync(reference,['-y','-v','error',...before,'-i',file,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,description).toBe(nativeStatus);
   for(const backend of ['media','timed'] as const){
    let opened=0;const open=()=>{opened++;return collectingOutput().output;},stores=timedStores(),ffmpeg=backend==='media'?media(input,open):timedBackend(input,open,stores.storage);
    const result=await ffmpeg.exec([...before,'-i','/in',...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
    expect(result.exitCode,`${backend} ${description}`).not.toBe(0);expect(opened,`${backend} ${description}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${backend} ${description}`).toContain(message);count++;
   }
  }
  expect(count).toBe(32);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source unchanged as native does on every path',async({signal})=>{
 // f_perms.c has no query_formats: native keeps every source format, and every one has storage here (yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('perms=toggle',negotiationSources,signal);
 expect(outcome.refused).toEqual({});expect(outcome.matched).toEqual(Object.fromEntries(negotiationSources.map(source=>[source,source])));
 expect(outcome.checks).toBe(14*5+3);
},120000);
