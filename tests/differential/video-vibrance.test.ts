import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {vibranceVideoFrame,parseVibranceOptions} from '../../packages/avfilter/src/video-ops/vibrance.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** Single-precision kernels: unfused float matches only on x86-64 (macOS arm64 contracts multiply-adds). */
const linuxX64=process.platform==='linux'&&process.arch==='x64';
const formats=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Defaults, every option at both range ends and a typical value, alternate, and the positional AVOption order. */
const settings=['','intensity=2','intensity=-2','intensity=0.5','intensity=-0.35','intensity=1:rbal=-10','intensity=-1:gbal=10','intensity=1.5:bbal=0','intensity=0.7:rbal=2.5:gbal=-3:bbal=0.4',
 'intensity=1:rlum=0:glum=1:blum=0','intensity=-0.7:rlum=1:glum=1:blum=1','intensity=2:rlum=0:glum=0:blum=0','intensity=1.2:rlum=0.299:glum=0.587:blum=0.114','alternate=1','alternate=1:intensity=1','alternate=true:intensity=-2:rbal=10:gbal=-10:bbal=5',
 '0.8:2:0.5:-3:0.3:0.6:0.1:1','intensity=max:rbal=min:gbal=max:bbal=none'] as const;
const filter=(setting:string)=>setting?`vibrance=${setting}`:'vibrance';
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then ramps with 0/255 edges, then constant planes with a sparse 200 lattice. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const decode=(input:Uint8Array,format:string,width:number,height:number,n:number,maxFrameBytes=1<<16)=>{const frameBytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes});};
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it.skipIf(!linuxX64)('matches native vibrance frames for every format, size and setting (linux-x64 float)',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const setting of settings){
    const label=`${format}/${width}x${height}/${setting}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(setting),'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label+native.stderr).toBe(0);const step=parseVibranceOptions(setting||null),chunks:Uint8Array[]=[];
    for(let n=0;n<3;n++)chunks.push(...vibranceVideoFrame(decode(input,format,width,height,n),step,{maxFrameBytes:1<<16}).planes);
    expect(Buffer.concat(chunks),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(756);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native vibrance on every 8-bit RGB triple (linux-x64 float)',()=>{
 // A 4096x4096 rgb24 cube: row r*16+(g>>4), column (g&15)*256+b holds (r, g, b); gbrp and bgra carry the same cube through their layouts.
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-cube-'));let count=0;
 try{
  const side=4096,cube=new Uint8Array(side*side*3);for(let r=0,i=0;r<256;r++)for(let g=0;g<256;g++)for(let b=0;b<256;b++,i+=3){cube[i]=r;cube[i+1]=g;cube[i+2]=b;}
  const pixels=side*side,planar=new Uint8Array(pixels*3),bgra=new Uint8Array(pixels*4);
  for(let p=0;p<pixels;p++){const r=cube[p*3]!,g=cube[p*3+1]!,b=cube[p*3+2]!;planar[p]=g;planar[pixels+p]=b;planar[2*pixels+p]=r;bgra[p*4]=b;bgra[p*4+1]=g;bgra[p*4+2]=r;bgra[p*4+3]=p&255;}
  const inputs={rgb24:cube,gbrp:planar,bgra} as const;
  for(const [setting,format] of [['','rgb24'],['intensity=2','gbrp'],['intensity=-2','rgb24'],['intensity=0.5','bgra'],['alternate=1:intensity=1.3','rgb24'],['intensity=-1:rbal=-10:gbal=10:bbal=0.5','gbrp'],['intensity=1:rlum=1:glum=0:blum=0.5','rgb24'],['alternate=1:intensity=-0.6:rbal=3:gbal=-2:bbal=7','bgra']] as const){
   const data=inputs[format],file=join(root,`${format}.raw`);writeFileSync(file,data);
   const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${side}x${side}`,'-i',file,'-vf',filter(setting),'-f','rawvideo','-'],{timeout:60000,maxBuffer:1<<27});expect(native.status,setting).toBe(0);
   const frame=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:side,height:side},{maxFrameBytes:1<<26});
   expect(Buffer.concat(vibranceVideoFrame(frame,parseVibranceOptions(setting||null),{maxFrameBytes:1<<26}).planes).equals(native.stdout),`${format}/${setting}`).toBe(true);count++;
  }
  expect(count).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
/** Representative source and setting pairs for the CLI, stream and timed paths. */
const scoped=[['rgb24',settings[3]],['bgr24',settings[5]],['rgba',settings[15]],['bgra',settings[2]],['argb',settings[8]],['abgr',settings[16]],['gbrp',settings[1]],['gbrp',settings[0]]] as const;
it.skipIf(!linuxX64)('matches native vibrance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-cli-'));let count=0;
 try{
  for(const [source,setting]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(setting),`${filter(setting)},hflip`,`vflip,${filter(setting)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native replayed vibrance branches and joins frame by frame (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-stream-'));let checked=0;
 try{
  for(const [source,setting]of scoped){
   const input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input,source,5,3,index,4096);}}};}};
   for(const graph of [`[in]${filter(setting)}[out]`,`[in]split[x][y];[x]${filter(setting)}[l];[y]${filter(setting)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(setting)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    // Split outputs are not writable: native then reads gbrp rows at the output linesize and lets rgb24/bgr24 alpha stores race
    // across slices, so the threaded result is undefined; one filter thread gives the sequential result this kernel implements.
    const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-filter_complex_threads','1','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});expect(native.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(setting)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  expect(checked).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!linuxX64)('matches native vibrance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-timed-'));let count=0;
 try{
  for(const [source,setting]of scoped){
   const input=pattern(source,5,3,source.length*11+3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of [filter(setting),`hflip,${filter(setting)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['3','2']){
    const before=['-y','-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-filter_complex',`[0:v]${chain}[x]`,'-map','[x]','-frames:v',frames,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format],label=`${source}/${chain}/${format}/${frames}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);
    for(const scheduler of ['pull','activation','producer'] as TimedVideoScheduler[]){
     const sink=collectingOutput(),backend=createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
     const result=await frontendFor(input,backend,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+scheduler+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label+scheduler).toEqual(native.stdout);count++;
    }
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native vibrance with default and single filter threads (linux-x64 float)',()=>{
 // Slice threading splits rows; both native runs and the kernel must agree, including heights above the thread count.
 const root=mkdtempSync(join(tmpdir(),'edge-vibrance-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[17,9],[64,16],[33,31],[128,8]] as const){
   const input=pattern(format,width,height,width+height*7),file=join(root,'input.raw');writeFileSync(file,input);
   for(const setting of [settings[3],settings[8],settings[15]]){
    const run=(threads:string[])=>spawnSync(ffmpeg,['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(setting),'-f','rawvideo','-'],{timeout:10000});
    const many=run([]),one=run(['-filter_threads','1']),label=`${format}/${width}x${height}/${setting}`;expect(many.status,label).toBe(0);expect(one.status,label).toBe(0);expect(many.stdout,label).toEqual(one.stdout);
    const step=parseVibranceOptions(setting),chunks:Uint8Array[]=[];for(let n=0;n<3;n++)chunks.push(...vibranceVideoFrame(decode(input,format,width,height,n),step,{maxFrameBytes:1<<16}).planes);
    expect(Buffer.concat(chunks),label).toEqual(one.stdout);count++;
    // Through split the frame is not writable and native's threaded slices are undefined (see the stream test); one thread is the reference.
    const shared=spawnSync(ffmpeg,['-v','error','-filter_complex_threads','1','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',`[0:v]split[x][y];[x]${filter(setting)}[l];[y]nullsink`,'-map','[l]','-f','rawvideo','-'],{timeout:10000});
    expect(shared.status,label).toBe(0);expect(Buffer.concat(chunks),label).toEqual(shared.stdout);count++;
   }
  }
  expect(count).toBe(168);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses vibrance timelines and unimplemented values before opening CLI outputs',async()=>{
 const input=pattern('rgb24',4,2,3);let count=0;
 // Native accepts every one of these; the refusals are scope limits.
 for(const description of ['vibrance=intensity=1/3','vibrance=rbal=2*2','vibrance=intensity=0x1','vibrance=enable=1','vibrance=intensity=0.5:enable=gt(t\\,0.04)'])for(const complex of [false,true])for(const timed of [false,true]){
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','rgb24','-s','4x2'],native=spawnSync(ffmpeg,['-v','error',...argv,'-i','-',...graph,'-f','null','-'],{input,timeout:10000});
  expect(native.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 // Out-of-range values, auto and unknown options fail natively too.
 for(const description of ['vibrance=intensity=2.5','vibrance=rbal=-11','vibrance=glum=1.01','vibrance=blum=-0.1','vibrance=rlum=all','vibrance=alternate=2','vibrance=alternate=auto','vibrance=0:1:1:1:0.2:0.7:0.07:0:1']){
  const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','-','-vf',description,'-f','null','-'],{input,timeout:10000});expect(native.status,description).not.toBe(0);
  let opened=0;const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','/in','-vf',description,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 expect(count).toBe(28);
},60000);
it.skipIf(!linuxX64)('negotiates every accepted source as native does and refuses picks without storage before output on every path (linux-x64 float)',async({signal})=>{
 const outcomes=[];for(const vf of ['vibrance','vibrance=intensity=1.4:alternate=1:gbal=-3'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 // Every source negotiates a member with frame storage: yuva420p keeps alpha as argb, other YUV and gray become rgb24.
 const matched={yuv420p:'rgb24',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'rgb24',yuv444p:'rgb24',gray:'rgb24',nv12:'rgb24',nv21:'rgb24',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'gbrp',yuvj420p:'rgb24',yuvj422p:'rgb24',yuvj444p:'rgb24'};
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([{},{}]);expect(outcomes.map(outcome=>outcome.matched)).toEqual([matched,matched]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([73,73]);
},120000);
