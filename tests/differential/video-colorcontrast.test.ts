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
import {colorcontrastVideoFrame,parseColorcontrastOptions} from '../../packages/avfilter/src/video-ops/colorcontrast.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** Single-precision cases match the unfused x86-64 baseline; macOS arm64 may fuse multiply-adds, so they run on linux-x64 only. */
const linuxX64=process.platform==='linux'&&process.arch==='x64';
const formats=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Weight sums at most FLT_EPSILON skip the row loop natively: the frame passes unchanged. */
const identities=['','rc=1:gm=-1:by=0.5:pl=1','gmw=1e-7','rcw=4e-8:gmw=4e-8:byw=3e-8:rc=1:pl=0.5','rcw=0:gmw=0:byw=0:pl=0.7'] as const;
/** Each axis alone, all three, range ends, a lightness-only preserve, a sum just above FLT_EPSILON, constants and expressions. */
const settings=['rc=0.5:rcw=1','gm=-1:gmw=1','by=1:byw=1','-0.3:0.7:1:0.2:0.5:1:0.4','rc=1:gm=1:by=1:rcw=1:gmw=1:byw=1:pl=1','rc=-1:gm=-1:by=-1:rcw=0.1:gmw=0.3:byw=0.7:pl=0.33',
 'rcw=1:pl=1','rcw=5e-8:gmw=5e-8:byw=2e-8:rc=0.9:gm=-0.2','rc=max:gm=min:by=default:rcw=max:gmw=0.1:byw=none:pl=max','rc=1/3:gm=-2/3:by=0.1*7:rcw=0.123:gmw=0.456:byw=0.789:pl=0.5'] as const;
const filter=(options:string)=>options?`colorcontrast=${options}`:'colorcontrast';
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then ramps with 0/255 edges, then constant planes with sparse spikes. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const native=(args:readonly string[],input?:Uint8Array)=>spawnSync(ffmpeg,['-v','error',...args],{input,timeout:20000,maxBuffer:1<<24});
const kernel=(format:string,width:number,height:number,input:Uint8Array,options:string)=>{
 const frameBytes=pixelLayout(format,width,height).bytes,step=parseColorcontrastOptions(options||null),chunks:Uint8Array[]=[];
 for(let n=0;n*frameBytes<input.length;n++){const frame=decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});chunks.push(...colorcontrastVideoFrame(frame,step,{maxFrameBytes:1<<20}).planes);}
 return Buffer.concat(chunks);
};
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native colorcontrast identity settings for every format and size on the kernel and the CLI',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-identity-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*17+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of identities){
    const label=`${format}/${width}x${height}/${options}`,result=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(options),'-f','rawvideo','-']);
    expect(result.status,label+result.stderr).toBe(0);expect(result.stdout,label).toEqual(Buffer.from(input));expect(kernel(format,width,height,input,options),label).toEqual(result.stdout);count++;
   }
  }
  for(const format of formats)for(const options of identities)for(const output of ['rawvideo','framecrc']){
   const input=pattern(format,7,5,format.length),before=['-f','rawvideo','-pixel_format',format,'-s','7x5'],after=['-vf',`${filter(options)},hflip`,'-bitexact','-f',output],label=`${format}/${options}/${output}`;
   const expected=native(['-cpuflags','0',...before,'-i','-',...after,'-'],input);expect(expected.status,label).toBe(0);const sink=collectingOutput();
   const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);count++;
  }
  expect(count).toBe(280);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native colorcontrast float frames for every format, size and setting on linux-x64',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of settings){
    const label=`${format}/${width}x${height}/${options}`,result=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(options),'-f','rawvideo','-']);
    expect(result.status,label+result.stderr).toBe(0);expect(kernel(format,width,height,input,options),label).toEqual(result.stdout);count++;
   }
  }
  expect(count).toBe(420);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native colorcontrast over structured colour ramps on linux-x64',()=>{
 // Frame 1 is the 16x16x16 grid of channel values n * 17; frame 2 ramps each channel through 0..255 against fixed others; frame 3 walks greys and near-greys.
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-ramps-'));let count=0;
 try{
  const width=64,height=64,pixels=width*height,rgb=[
   Array.from({length:pixels},(_,i)=>[(i&15)*17,(i>>4&15)*17,(i>>8)*17]),
   Array.from({length:pixels},(_,i)=>{const v=i&255,c=i>>8&3,o=[0,128,255,64][i>>10]!;return c===0?[v,o,o]:c===1?[o,v,o]:c===2?[o,o,v]:[v,v,o];}),
   Array.from({length:pixels},(_,i)=>{const v=i&255,d=(i>>8)-8;return [v,Math.min(255,Math.max(0,v+d)),Math.min(255,Math.max(0,v-d))];}),
  ] as const;
  for(const format of formats){
   const layout=pixelLayout(format,width,height),input=new Uint8Array(layout.bytes*3);
   for(const [n,frame]of rgb.entries()){
    const base=n*layout.bytes;
    for(const [i,[r,g,b]]of frame.entries()){
     if(format==='gbrp'){input[base+layout.planes[0]!.offset+i]=g!;input[base+layout.planes[1]!.offset+i]=b!;input[base+layout.planes[2]!.offset+i]=r!;continue;}
     const order={rgb24:'rgb',bgr24:'bgr',rgba:'rgba',bgra:'bgra',argb:'argb',abgr:'abgr'}[format],pixel=order.length,o=base+i*pixel;
     input[o+order.indexOf('r')]=r!;input[o+order.indexOf('g')]=g!;input[o+order.indexOf('b')]=b!;if(pixel===4)input[o+order.indexOf('a')]=(i*7)&255;
    }
   }
   const file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of settings){
    const label=`${format}/${options}`,result=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(options),'-f','rawvideo','-']);
    expect(result.status,label).toBe(0);expect(kernel(format,width,height,input,options),label).toEqual(result.stdout);count++;
   }
  }
  expect(count).toBe(70);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native colorcontrast with default threads and -filter_threads 1 on linux-x64',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-threads-'));let count=0;
 try{
  for(const format of ['rgb24','argb','gbrp'] as const)for(const [width,height]of [[17,9],[64,48]] as const){
   const input=pattern(format,width,height,width+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of [settings[3],settings[4],settings[9]]){
    const args=(threads:readonly string[])=>[...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(options),'-f','rawvideo','-'];
    const many=native(args(['-filter_threads','4'])),defaults=native(args([])),one=native(args(['-filter_threads','1'])),label=`${format}/${width}x${height}/${options}`;
    expect([many.status,defaults.status,one.status],label).toEqual([0,0,0]);expect(defaults.stdout,label).toEqual(one.stdout);expect(many.stdout,label).toEqual(one.stdout);expect(kernel(format,width,height,input,options),label).toEqual(one.stdout);count++;
   }
  }
  expect(count).toBe(18);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Representative source and setting pairs for the CLI, stream and timed paths. */
const scoped=[['rgb24',settings[3]],['bgr24',settings[5]],['rgba',settings[4]],['bgra',settings[9]],['argb',settings[1]],['abgr',settings[8]],['gbrp',settings[0]],['gbrp',settings[6]]] as const;
it.skipIf(!linuxX64)('matches native colorcontrast CLI rawvideo and framecrc through -vf and -filter_complex on linux-x64',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-cli-'));let count=0;
 try{
  for(const [source,options]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(options),`${filter(options)},hflip`,`vflip,${filter(options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const expected=native(['-cpuflags','0',...before,'-i',file,...after,'-']);expect(expected.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native replayed colorcontrast branches and joins frame by frame on linux-x64',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-stream-'));let checked=0;
 try{
  for(const [source,options]of scoped){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of [`[in]${filter(options)}[out]`,`[in]split[x][y];[x]${filter(options)}[l];[y]${filter(options)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(options)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const expected=native(['-y','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);expect(expected.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(options)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  expect(checked).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!linuxX64)('matches native colorcontrast framecrc and rawvideo through the actor and timed schedulers on linux-x64',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcontrast-timed-'));let count=0;
 try{
  for(const [source,options]of scoped){
   const input=pattern(source,5,3,source.length*11+3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of [filter(options),`hflip,${filter(options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['3','2']){
    const before=['-y','-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-filter_complex',`[0:v]${chain}[x]`,'-map','[x]','-frames:v',frames,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format],label=`${source}/${chain}/${format}/${frames}`;
    const expected=native(['-cpuflags','0',...before,'-i',file,...after,'-']);expect(expected.status,label).toBe(0);
    for(const scheduler of ['pull','activation','producer'] as TimedVideoScheduler[]){
     const sink=collectingOutput(),backend=createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
     const result=await frontendFor(input,backend,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+scheduler+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label+scheduler).toEqual(expected.stdout);count++;
    }
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses colorcontrast timelines, unparsable and out-of-range values before opening CLI outputs on every backend',async()=>{
 const input=pattern('rgb24',4,2,3);let count=0;
 // Native accepts these; the refusals are scope limits.
 for(const description of ['colorcontrast=enable=1','colorcontrast=rc=0.5:rcw=1:enable=gt(t\\,0.04)','colorcontrast=enable=between(t\\,0\\,1)','colorcontrast=enable=0'])for(const complex of [false,true])for(const timed of [false,true]){
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','rgb24','-s','4x2'],expected=native([...argv,'-i','-',...graph,'-f','null','-'],input);
  expect(expected.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 // Out-of-range and unparsable values (NaN results included) fail natively too.
 for(const description of ['colorcontrast=rc=1.5','colorcontrast=gm=-2','colorcontrast=rcw=-0.5','colorcontrast=byw=2','colorcontrast=pl=1.1','colorcontrast=rcw=all','colorcontrast=pl=inf','colorcontrast=rc=nan','colorcontrast=rcw=0/0','colorcontrast=gm=foo'])for(const timed of [false,true]){
  const expected=native(['-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','-','-vf',description,'-f','null','-'],input);expect(expected.status,description).not.toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','/in','-vf',description,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);expect(JSON.stringify(result.diagnostics),description).toContain('Invalid colorcontrast');count++;
 }
 expect(count).toBe(36);
},60000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 // Identity settings, so the byte checks hold on every platform.
 const outcomes=[];for(const vf of ['colorcontrast','colorcontrast=rc=1:gm=-1:by=0.5:pl=1'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 const matched={yuv420p:'rgb24',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'rgb24',yuv444p:'rgb24',gray:'rgb24',nv12:'rgb24',nv21:'rgb24',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'gbrp',yuvj420p:'rgb24',yuvj422p:'rgb24',yuvj444p:'rgb24'};
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([{},{}]);expect(outcomes.map(outcome=>outcome.matched)).toEqual([matched,matched]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([73,73]);
},120000);
