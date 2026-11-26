import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {colorcorrectVideoFrame,parseColorcorrectOptions} from '../../packages/avfilter/src/video-ops/colorcorrect.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** Single-precision float per pixel: macOS arm64 contracts the multiply-adds, so every native byte comparison runs on linux-x64 only. */
const linux=process.platform==='linux'&&process.arch==='x64';
const formats=['yuv420p','yuv422p','yuv444p','yuva420p'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Defaults, every option at both range ends, typical values, both implemented analyses and the named constants. */
const cases=['','rl=-1','rl=1','bl=-1','bl=1','rh=-1','rh=1','bh=-1','bh=1','saturation=-3','saturation=3','saturation=0','0.1:-0.2:0.3:-0.05:1.5','rl=0.33:bl=-0.67:rh=-0.21:bh=0.9:saturation=0.7','rl=max:bl=min:rh=all:bh=none:saturation=default','-0.5:0.25:0.75:-0.125:-1.25','analyze=median','analyze=median:saturation=2.5','rl=0.5:analyze=3:saturation=-0.6','analyze=manual:rl=0.2'] as const;
const filter=(options:string)=>options?`colorcorrect=${options}`:'colorcorrect';
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then ramps with 0/255 edges, then constant planes with a sparse stripe. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const tight=(planes:readonly Uint8Array[])=>Buffer.concat(planes.map(plane=>Buffer.from(plane.buffer,plane.byteOffset,plane.byteLength)));
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
const decode=(data:Uint8Array,format:string,width:number,height:number,n:number)=>decodeRawVideo({streamIndex:0,data,pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it.skipIf(!linux)('matches native colorcorrect frames for every format, size and option case, with default and single filter threads',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcorrect-kernel-'));let count=0,threads=0;
 try{
  const run=(format:string,width:number,height:number,input:Uint8Array,options:string,file:string)=>{
   const frameBytes=pixelLayout(format,width,height).bytes,label=`${format}/${width}x${height}/${options}`,args=['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(options),'-f','rawvideo','-'];
   const native=spawnSync(ffmpeg,args,{timeout:10000}),single=spawnSync(ffmpeg,['-filter_threads','1',...args],{timeout:10000});
   expect(native.status,label+native.stderr).toBe(0);expect(single.stdout,`threads/${label}`).toEqual(native.stdout);threads++;
   const step=parseColorcorrectOptions(options||null),chunks:Buffer[]=[];
   for(let n=0;n<input.length/frameBytes;n++){const data=input.slice(n*frameBytes,(n+1)*frameBytes),frame=decode(data,format,width,height,n);chunks.push(tight(colorcorrectVideoFrame(frame,step,{maxFrameBytes:1<<20}).planes));expect(tight(frame.planes),`unmutated/${label}`).toEqual(Buffer.from(data));}
   expect(Buffer.concat(chunks),label).toEqual(native.stdout);count++;
  };
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of cases)run(format,width,height,input,options,file);
   // minmax only where native analyses one slice: a one-row chroma plane.
   if((format==='yuv420p'||format==='yuva420p')?height<=2:height===1)for(const options of ['analyze=minmax','analyze=minmax:saturation=-2','analyze=2:rl=1:bh=-1'])run(format,width,height,input,options,file);
  }
  // Every 8-bit chroma value over every luma value: 256x256 planes in yuv444p, chroma ramps in 4:2:0, and one-row minmax ramps.
  for(const [format,width,height]of [['yuv444p',256,256],['yuv420p',512,512],['yuv444p',256,1],['yuv422p',300,1]] as const){
   const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes),[y,u,v]=layout.planes as unknown as readonly [typeof layout.planes[0],typeof layout.planes[0],typeof layout.planes[0]];
   for(let r=0;r<y.height;r++)for(let x=0;x<y.width;x++)data[y.offset+r*y.width+x]=(r+x*7)&255;
   for(let r=0;r<u.height;r++)for(let x=0;x<u.width;x++){data[u.offset+r*u.width+x]=x&255;data[v.offset+r*v.width+x]=(255-x-r)&255;}
   const file=join(root,'ramp.raw');writeFileSync(file,data);
   for(const options of height===1?['','analyze=minmax','analyze=median','0.3:-0.7:-0.2:0.6:2.2']:['','0.1:-0.2:0.3:-0.05:1.5','rl=1:bl=-1:rh=-1:bh=1:saturation=-3','analyze=median:saturation=0.5'])run(format,width,height,data,options,file);
  }
  expect(count).toBe(514);expect(threads).toBe(count);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
/** Representative source and option pairs for the CLI, stream and timed paths. */
const scoped=[['yuv420p',cases[12]],['yuv422p',cases[13]],['yuv444p',cases[15]],['yuva420p',cases[17]],['yuv420p',cases[0]],['yuv444p',cases[10]]] as const;
it.skipIf(!linux)('matches native colorcorrect CLI rawvideo and framecrc through -vf and -filter_complex',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcorrect-cli-'));let count=0;
 try{
  for(const [source,options]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(options),`${filter(options)},hflip`,`vflip,${filter(options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  // One-row minmax through the CLI, and nv12 converted to yuv420p before the filter (-cpuflags 0).
  for(const [source,size,options]of [['yuv420p','9x2','analyze=minmax'],['yuv444p','6x1','analyze=minmax:saturation=1.5'],['nv12','7x5','rl=0.2:bh=-0.3']] as const){
   const [width,height]=size.split('x').map(Number) as [number,number],input=pattern(source,width,height,size.length),file=join(root,'input.raw');writeFileSync(file,input);
   for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',size],after=['-vf',filter(options),'-bitexact','-f',format],label=`${source}/${options}/${format}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(150);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linux)('matches native replayed colorcorrect branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcorrect-stream-'));let checked=0;
 try{
  for(const [source,options]of scoped){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input.slice(index*frameBytes,(index+1)*frameBytes),source,5,3,index);}}};}};
   for(const graph of [`[in]${filter(options)}[out]`,`[in]split[x][y];[x]${filter(options)}[l];[y]${filter(options)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(options)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});expect(native.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(options)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  expect(checked).toBe(18);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!linux)('matches native colorcorrect framecrc and rawvideo through the actor and timed schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcorrect-timed-'));let count=0;
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
  expect(count).toBe(144);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses colorcorrect average, multi-slice minmax, timelines and unimplemented values before opening CLI outputs',async()=>{
 const input=pattern('yuv420p',4,4,3);let count=0;
 // Native accepts every one of these; the refusals are scope limits.
 for(const [description,message]of [['colorcorrect=analyze=average','analyze=average'],['colorcorrect=analyze=1','analyze=average'],['colorcorrect=analyze=minmax','one-row chroma'],['colorcorrect=rl=1/3','Only constant decimal'],['colorcorrect=saturation=0x1','Only constant decimal'],['colorcorrect=enable=1','timeline'],['colorcorrect=rl=0.5:enable=gt(t\\,0.04)','timeline']] as const)for(const complex of [false,true])for(const timed of [false,true]){
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','yuv420p','-s','4x4'],native=spawnSync(ffmpeg,['-v','error',...argv,'-i','-',...graph,'-f','null','-'],{input,timeout:10000});
  expect(native.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);expect(JSON.stringify(result.diagnostics),description).toContain(message);count++;
 }
 // Out-of-range values fail natively too.
 for(const description of ['colorcorrect=rl=1.5','colorcorrect=bh=-1.01','colorcorrect=saturation=3.5','colorcorrect=analyze=4','colorcorrect=analyze=all','colorcorrect=saturation=-4']){
  const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','yuv420p','-s','4x4','-i','-','-vf',description,'-f','null','-'],{input,timeout:10000});expect(native.status,description).not.toBe(0);
  let opened=0;const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','yuv420p','-s','4x4','-i','/in','-vf',description,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 expect(count).toBe(34);
},60000);
it.skipIf(!linux)('negotiates every accepted colorcorrect source as native does and refuses picks without storage before output on every path',async({signal})=>{
 const outcomes=[];for(const vf of ['colorcorrect','colorcorrect=0.1:-0.2:0.3:-0.05:1.5'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 // RGB sources convert to yuv444p and run; gray picks yuvj444p and packed RGBA picks yuva444p, which have no frame storage here.
 const matched={yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'},refused={gray:'yuvj444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'};
 expect(outcomes.map(outcome=>outcome.matched)).toEqual([matched,matched]);expect(outcomes.map(outcome=>outcome.refused)).toEqual([refused,refused]);expect(outcomes.map(outcome=>outcome.checks)).toEqual([93,93]);
},120000);
it.skipIf(!linux)('plans colorcorrect through compileVideoFilterChain with negotiated conversions as native does',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorcorrect-chain-'));let count=0;
 try{
  for(const source of ['yuv420p','yuva420p','nv12','yuv444p'] as const){
   const input=pattern(source,8,6,source.length),file=join(root,'input.raw');writeFileSync(file,input);
   const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','8x6','-i',file,'-vf','colorcorrect=0.2:0.1,hflip','-f','rawvideo','-'],{timeout:10000});expect(native.status).toBe(0);
   const plan=compileVideoFilterChain('colorcorrect=0.2:0.1,hflip').plan(source,8,6,{arithmetic:'scalar'}),frameBytes=pixelLayout(source,8,6).bytes,chunks:Buffer[]=[];
   for(let n=0;n<3;n++)chunks.push(tight(plan.apply(decode(input.slice(n*frameBytes,(n+1)*frameBytes),source,8,6,n),{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes}).planes));
   expect(Buffer.concat(chunks),source).toEqual(native.stdout);count++;
  }
  expect(count).toBe(4);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
