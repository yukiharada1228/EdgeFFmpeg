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
import {balanceVideoColors,parseColorbalanceOptions} from '../../packages/avfilter/src/video-ops/colorbalance.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** Single-precision float cases: the linux-x64 reference does not fuse multiply-adds, Math.fround emulates exactly that. */
const linuxX64=process.platform==='linux'&&process.arch==='x64';
const formats=['rgb24','bgr24','rgba','bgra','abgr','argb','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Default spellings: every balance 0 and pl off, which native and this port both reproduce exactly. */
const defaults=['','pl=0','0:0:0:0:0:0:0:0:0:0','rs=none:gm=default:bh=0:pl=false'] as const;
/** Extremes, typical values, the shorthand order, constants, and pl with black and white inputs (inf/NaN saturation). */
const balances=['rs=1:gs=1:bs=1','rs=-1:gs=-1:bs=-1','rm=1:gm=-1:bm=0.5','rh=-1:gh=1:bh=-0.5','rs=0.3:gm=-0.2:bh=0.5','-1:0.5:0:0.25:-0.75:1:0:0:-0.4','rs=all:gs=max:bs=min:rm=0.333:gh=-0.333',
 'pl=1','rs=0.5:gs=0.5:bs=0.5:pl=1','rh=-0.5:gh=-0.5:bh=-0.5:pl=1','rm=0.6:bs=-0.3:gh=0.2:pl=true','1:-1:1:-1:1:-1:1:-1:1:1','rs=0.1:gs=0.2:bs=0.3:rm=-0.4:gm=0.5:bm=-0.6:rh=0.7:gh=-0.8:bh=0.9:pl=1'] as const;
const filter=(options:string)=>options?`colorbalance=${options}`:'colorbalance';
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then ramps with 0/255 edges, then constant planes. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const decode=(format:string,width:number,height:number,data:Uint8Array,n:number)=>decodeRawVideo({streamIndex:0,data,pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<22});
const nativeRaw=(file:string,format:string,width:number,height:number,vf:string,extra:readonly string[]=[])=>spawnSync(ffmpeg,['-v','error',...extra,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',vf,'-f','rawvideo','-'],{timeout:20000,maxBuffer:1<<26});
/** The kernel over every frame of a raw file. */
function kernel(format:string,width:number,height:number,input:Uint8Array,options:string):Buffer{
 const frameBytes=pixelLayout(format,width,height).bytes,step=parseColorbalanceOptions(options||null),chunks:Uint8Array[]=[];
 for(let n=0;n*frameBytes<input.length;n++)chunks.push(...balanceVideoColors(decode(format,width,height,input.slice(n*frameBytes,(n+1)*frameBytes),n),step,{maxFrameBytes:1<<22}).planes);
 return Buffer.concat(chunks);
}
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native colorbalance defaults as the identity for every format and size',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-defaults-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*17+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of defaults){
    const label=`${format}/${width}x${height}/${options}`,native=nativeRaw(file,format,width,height,filter(options));
    expect(native.status,label+native.stderr).toBe(0);expect(native.stdout,label).toEqual(Buffer.from(input));expect(kernel(format,width,height,input,options),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(168);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!linuxX64)('matches native colorbalance frames for every format, size and balance (linux-x64 float)',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of balances){
    const label=`${format}/${width}x${height}/${options}`,native=nativeRaw(file,format,width,height,filter(options));
    expect(native.status,label+native.stderr).toBe(0);expect(kernel(format,width,height,input,options),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(546);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
/** Each balance alone at -1, a typical value and 1, with pl off and on, and the nine together. */
const extremes=[...['rs','gs','bs','rm','gm','bm','rh','gh','bh'].flatMap(key=>['-1','0.37','1'].map(value=>`${key}=${value}`)),'rs=-0.6:gs=0.2:bs=0.9:rm=0.4:gm=-0.8:bm=0.1:rh=-0.3:gh=0.7:bh=-1'].flatMap(options=>[options,`${options}:pl=1`]);
it.skipIf(!linuxX64)('matches native colorbalance over a structured colour cube for every balance at its extremes (linux-x64 float)',()=>{
 // Every (r, g, b) on a 0, 5, ..., 255 grid plus the 1/254 neighbours of black and white, one pixel each, as rgb24 and gbrp.
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-cube-'));let count=0;
 try{
  const levels=[...Array.from({length:52},(_,i)=>i*5),1,254],colors:[number,number,number][]=[];for(const r of levels)for(const g of levels)for(const b of levels)colors.push([r,g,b]);
  const width=216,height=colors.length/width;expect(Number.isInteger(height)).toBe(true);
  for(const format of ['rgb24','gbrp'] as const){
   const layout=pixelLayout(format,width,height),input=new Uint8Array(layout.bytes);
   colors.forEach(([r,g,b],i)=>{if(format==='rgb24')input.set([r,g,b],i*3);else{input[layout.planes[0]!.offset+i]=g;input[layout.planes[1]!.offset+i]=b;input[layout.planes[2]!.offset+i]=r;}});
   const file=join(root,'cube.raw');writeFileSync(file,input);
   for(const options of extremes){const native=nativeRaw(file,format,width,height,filter(options));expect(native.status,options).toBe(0);expect(kernel(format,width,height,input,options).equals(native.stdout),`${format}/${options}`).toBe(true);count++;}
  }
  expect(count).toBe(112);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native colorbalance with default slice threads and -filter_threads 1 (linux-x64 float)',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-threads-'));let count=0;
 try{
  for(const format of ['rgb24','argb','gbrp'] as const)for(const options of [balances[4],balances[10],balances[12]]){
   const input=pattern(format,17,64,format.length*5+3),file=join(root,'input.raw');writeFileSync(file,input);
   const threaded=nativeRaw(file,format,17,64,filter(options)),single=nativeRaw(file,format,17,64,filter(options),['-filter_threads','1']),label=`${format}/${options}`;
   expect(threaded.status,label).toBe(0);expect(single.status,label).toBe(0);expect(threaded.stdout,label).toEqual(single.stdout);expect(kernel(format,17,64,input,options),label).toEqual(single.stdout);count++;
  }
  expect(count).toBe(9);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Representative source and balance pairs for the CLI, stream and timed paths. */
const scoped=[['rgb24',balances[4]],['bgr24',balances[5]],['rgba',balances[10]],['bgra',balances[8]],['abgr',balances[1]],['argb',balances[12]],['gbrp',balances[2]],['gbrp',balances[9]]] as const;
it.skipIf(!linuxX64)('matches native colorbalance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-cli-'));let count=0;
 try{
  for(const [source,options]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(options),`${filter(options)},hflip`,`vflip,${filter(options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native replayed colorbalance branches and joins frame by frame (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-stream-'));let checked=0;
 try{
  for(const [source,options]of scoped){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(source,5,3,input.slice(index*frameBytes,(index+1)*frameBytes),index);}}};}};
   for(const graph of [`[in]${filter(options)}[out]`,`[in]split[x][y];[x]${filter(options)}[l];[y]${filter(options)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(options)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});expect(native.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(options)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  expect(checked).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!linuxX64)('matches native colorbalance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorbalance-timed-'));let count=0;
 try{
  for(const [source,options]of scoped){
   const input=pattern(source,5,3,source.length*11+3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of [filter(options),`hflip,${filter(options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['3','2']){
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
it('refuses colorbalance timelines and unimplemented values before opening CLI outputs',async()=>{
 const input=pattern('rgb24',4,2,3);let count=0;
 // Native accepts every one of these; the refusals are scope limits.
 for(const description of ['colorbalance=rs=1/3','colorbalance=gm=0x1','colorbalance=bh=sin(0)','colorbalance=enable=1','colorbalance=rs=0.5:enable=gt(t\\,0.04)','colorbalance=threads=1'])for(const complex of [false,true])for(const timed of [false,true]){
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','rgb24','-s','4x2'],native=spawnSync(ffmpeg,['-v','error',...argv,'-i','-',...graph,'-f','null','-'],{input,timeout:10000});
  expect(native.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 // Out-of-range values fail natively too.
 for(const description of ['colorbalance=rs=1.5','colorbalance=bh=-1.01','colorbalance=pl=2','colorbalance=pl=auto']){
  const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','-','-vf',description,'-f','null','-'],{input,timeout:10000});expect(native.status,description).not.toBe(0);
  let opened=0;const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','/in','-vf',description,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 expect(count).toBe(28);
},60000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 const outcomes=[];for(const vf of ['colorbalance','colorbalance=pl=0'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 // Every source negotiates a member with frame storage: yuva420p keeps alpha as argb, other YUV and gray become rgb24.
 const matched={yuv420p:'rgb24',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'rgb24',yuv444p:'rgb24',gray:'rgb24',nv12:'rgb24',nv21:'rgb24',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'gbrp',yuvj420p:'rgb24',yuvj422p:'rgb24',yuvj444p:'rgb24'};
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([{},{}]);expect(outcomes.map(outcome=>outcome.matched)).toEqual([matched,matched]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([73,73]);
},120000);
