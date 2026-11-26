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
import {mixVideoChannels,parseColorchannelmixerOptions} from '../../packages/avfilter/src/video-ops/colorchannelmixer.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
const formats=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Identity, sepia-style matrices, negative and alpha gains, products landing on .5 (ties to even) and the range ends. */
const mixes=['','.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131','rr=.3:rg=.4:rb=.3:gr=.3:gg=.4:gb=.3:br=.3:bg=.4:bb=.3','rr=-1:gg=-0.5:bb=-2:rb=2:gr=1.5:bg=1','ra=.5:ga=-1:ba=1.5:ar=.25:ag=.5:ab=.25:aa=-.5','rr=.5:rg=.5:gg=1.5:gb=-.5:bb=.25:br=.125:aa=.5:ar=.75',
 'rr=2:rg=2:rb=2:ra=2:gr=-2:gg=-2:gb=-2:ga=-2:br=2:bg=-2:bb=1:ba=0:ar=-2:ag=2:ab=-2:aa=2','0:0:1:0:0:1:0:0:1:0:0:0:0:0:0:1','rr=0.1:gg=0.7:bb=1.3:aa=0.9:ra=0.01:pc=none:pa=0.75'] as const;
const filter=(mix:string)=>mix?`colorchannelmixer=${mix}`:'colorchannelmixer';
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then horizontal ramps with 0/255 edges, then constant planes. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native colorchannelmixer frames for every format, size and mix',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorchannelmixer-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const mix of mixes){
    const label=`${format}/${width}x${height}/${mix}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(mix),'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label+native.stderr).toBe(0);const step=parseColorchannelmixerOptions(mix||null),chunks:Uint8Array[]=[];
    for(let n=0;n<3;n++){const frame=decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});chunks.push(...mixVideoChannels(frame,step,{maxFrameBytes:65536}).planes);}
    expect(Buffer.concat(chunks),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(378);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native colorchannelmixer tables for every 8-bit value of every input channel',()=>{
 // Row k of a 256-wide frame ramps channel k from 0 to 255 over the constant other channels 0, 128 or 255, isolating each table.
 const root=mkdtempSync(join(tmpdir(),'edge-colorchannelmixer-tables-'));let count=0;
 const gains=['rr=.5:rg=-.5:rb=1.5:ra=-1.5:gr=.25:gg=-.25:gb=.75:ga=-.75:br=.125:bg=-.125:bb=1.25:ba=-1.25:ar=.375:ag=-.375:ab=1.375:aa=-1.375','rr=.1:rg=.2:rb=.3:ra=.4:gr=-.6:gg=.7:gb=-.8:ga=.9:br=1.1:bg=-1.2:bb=1.3:ba=-1.4:ar=1.9:ag=-1.7:ab=.05:aa=1.999','rr=1.5:gg=.5:bb=-.5:aa=.5:rg=2:gb=-2:ba=1:ar=-1','rr=0.333:rg=0.6667:gb=0.4999:gg=0.5001:bb=1.0039:br=-0.0039:aa=0.996:ab=0.002'];
 try{
  for(const format of formats)for(const base of [0,128,255]){
   const width=256,height=4,layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes).fill(base);
   if(format==='gbrp'){const plane=[2,0,1];for(let row=0;row<3;row++)for(let x=0;x<256;x++)data[layout.planes[plane[row]!]!.offset+row*256+x]=x;}
   else{const pixel=layout.planes[0]!.rowBytes/width,order={rgb24:'rgb',bgr24:'bgr',rgba:'rgba',bgra:'bgra',argb:'argb',abgr:'abgr'}[format as 'rgb24'];for(let row=0;row<height;row++){const channel='rgba'[row]!,offset=order.indexOf(channel);if(offset<0)continue;for(let x=0;x<256;x++)data[row*256*pixel+x*pixel+offset]=x;}}
   const file=join(root,'input.raw');writeFileSync(file,data);
   const frame=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});
   for(const mix of gains){
    const label=`${format}/${base}/${mix}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(mix),'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label).toBe(0);expect(Buffer.concat(mixVideoChannels(frame,parseColorchannelmixerOptions(mix),{maxFrameBytes:1<<16}).planes),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(84);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Representative source and mix pairs for the CLI, stream and timed paths. */
const scoped=[['rgb24',mixes[1]],['bgr24',mixes[3]],['rgba',mixes[4]],['bgra',mixes[5]],['argb',mixes[6]],['abgr',mixes[4]],['gbrp',mixes[3]],['gbrp',mixes[0]]] as const;
it('matches native colorchannelmixer CLI rawvideo and framecrc through -vf and -filter_complex',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorchannelmixer-cli-'));let count=0;
 try{
  for(const [source,mix]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(mix),`${filter(mix)},hflip`,`vflip,${filter(mix)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native replayed colorchannelmixer branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorchannelmixer-stream-'));let checked=0;
 try{
  for(const [source,mix]of scoped){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of [`[in]${filter(mix)}[out]`,`[in]split[x][y];[x]${filter(mix)}[l];[y]${filter(mix)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(mix)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});expect(native.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(mix)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  expect(checked).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native colorchannelmixer framecrc and rawvideo through the actor and timed schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorchannelmixer-timed-'));let count=0;
 try{
  for(const [source,mix]of scoped){
   const input=pattern(source,5,3,source.length*11+3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of [filter(mix),`hflip,${filter(mix)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['3','2']){
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
it('refuses colorchannelmixer preserve modes, timelines and unimplemented values before opening CLI outputs',async()=>{
 const input=pattern('rgb24',4,2,3);let count=0;
 // Native accepts every one of these; the refusals are scope limits.
 for(const description of ['colorchannelmixer=pc=lum','colorchannelmixer=pc=pwr:pa=1','colorchannelmixer=pc=max:pa=0','colorchannelmixer=rr=1/3','colorchannelmixer=enable=1','colorchannelmixer=rr=0.5:enable=gt(t\\,0.04)'])for(const complex of [false,true])for(const timed of [false,true]){
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','rgb24','-s','4x2'],native=spawnSync(ffmpeg,['-v','error',...argv,'-i','-',...graph,'-f','null','-'],{input,timeout:10000});
  expect(native.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 // Out-of-range values fail natively too.
 for(const description of ['colorchannelmixer=rr=3','colorchannelmixer=pa=2','colorchannelmixer=pc=7']){
  const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','-','-vf',description,'-f','null','-'],{input,timeout:10000});expect(native.status,description).not.toBe(0);
  let opened=0;const result=await frontendFor(input,createMediaBackend({pixelArithmetic:'scalar'}),()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','rgb24','-s','4x2','-i','/in','-vf',description,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
 }
 expect(count).toBe(27);
},60000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 const outcomes=[];for(const vf of ['colorchannelmixer','colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0:0:0:0:.5'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 // Every source negotiates a member with frame storage: yuva420p keeps alpha as argb, other YUV and gray become rgb24.
 const matched={yuv420p:'rgb24',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'rgb24',yuv444p:'rgb24',gray:'rgb24',nv12:'rgb24',nv21:'rgb24',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'gbrp',yuvj420p:'rgb24',yuvj422p:'rgb24',yuvj444p:'rgb24'};
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([{},{}]);expect(outcomes.map(outcome=>outcome.matched)).toEqual([matched,matched]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([73,73]);
},120000);
