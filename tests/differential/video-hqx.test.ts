import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {hqxVideoFrame,parseHqxOptions,VideoHqxError} from '../../packages/avfilter/src/video-hqx.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const native=resolve('.build/reference/ffmpeg'),sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,time={num:1n,den:25n};
// Palette words differ in single channels around the yuv_diff thresholds (Y 48, U 7, V 6) and in alpha only.
const palette=[[10,20,30,255],[10,20,30,0],[200,20,30,255],[10,21,30,255],[0,0,0,0],[60,80,40,255],[64,84,47,200],[250,250,250,255],[30,30,30,255],[80,80,80,255]] as const;
/** Pixel-art blocks, diagonals, single-pixel features, checkerboards, staircases, gradients, alpha ramps,
 * constant planes, few-colour noise and byte noise, as bgra words. */
function patterns(width:number,height:number):Uint8Array[]{
 let seed=4099;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 const pick:((x:number,y:number)=>number)[]=[
  (x,y)=>((x>>1)+(y>>1)*3)%3,(x,y)=>(x-y+64)%4===0?2:0,(x,y)=>(x+y)%3===0?3:1,(x,y)=>x===width>>1&&y===height>>1?2:x===0&&y===height-1?7:8,
  (x,y)=>(x+y)&1?4:2,(x,y)=>((x>>1)+(y>>1))&1?5:6,(x,y)=>x<y?0:x===y?2:9,()=>next()%3,()=>next()%2?5:6,()=>7,(x,y)=>(x*7+y*3)%10];
 const frames=pick.map(color=>{const data=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(palette[color(x,y)]!,(y*width+x)*4);return data;});
 const ramp=(f:(x:number,y:number)=>readonly number[])=>{const data=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(f(x,y),(y*width+x)*4);return data;};
 frames.push(ramp((x,y)=>[x*15&255,y*29&255,(x+y)*9&255,255]),ramp((x,y)=>[100,100,100,(x*40+y*17)&255]),ramp(x=>[(x*61)&255,(x*61)&255,(x*61)&255,255]));
 frames.push(Uint8Array.from({length:width*height*4},next));return frames;
}
const decode=(data:Uint8Array,pixelFormat:string,width:number,height:number,pts:bigint)=>decodeRawVideo({streamIndex:0,data,pts,dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat,width,height},{maxFrameBytes:1<<20});
const concat=(chunks:readonly Uint8Array[])=>Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)));
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
/** Bytes of a non-bgra source: ramps, edges and a constant run across every plane. */
const sourceBytes=(format:string,width:number,height:number,frames:number)=>Uint8Array.from({length:pixelLayout(format,width,height).bytes*frames},(_,i)=>[16,16,200,90,235,0,255,128][((i>>1)+(i/width|0)+(i*7>>4))%8]!);
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const timedBackend=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};},limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
it('runs against the sandbox-built native reference at 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native hq2x, hq3x and hq4x pixels on bgra across sizes, structured patterns and noise with default and single filter threads',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-hqx-kernel-'));let frames=0,changed=0;
 try{
  for(const [width,height]of sizes){
   const inputs=patterns(width,height);writeFileSync(join(root,'input.raw'),concat(inputs));
   for(const n of [2,3,4] as const){
    const run=(threads:readonly string[])=>execFileSync(native,['-v','error',...threads,'-f','rawvideo','-pixel_format','bgra','-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',`hqx=n=${n}`,'-f','rawvideo','-'],{maxBuffer:1<<24});
    const expected=run([]),single=run(['-filter_threads','1']),bytes=width*height*4*n*n;
    expect(single.equals(expected),`${width}x${height}/n=${n} threads`).toBe(true);expect(expected.length).toBe(bytes*inputs.length);
    for(const [index,data]of inputs.entries()){
     const label=`${width}x${height}/n=${n}/${index}`,frame=decode(data,'bgra',width,height,BigInt(index)),output=hqxVideoFrame(frame,parseHqxOptions(`n=${n}`),{maxFrameBytes:bytes});
     expect([output.width,output.height,output.pixelFormat,output.linesizes[0]],label).toEqual([width*n,height*n,'bgra',width*n*4]);
     const actual=concat(output.planes);expect(actual,label).toEqual(expected.subarray(index*bytes,(index+1)*bytes));expect(output.pts).toEqual(frame.pts);
     // Count frames where hqx differs from nearest-neighbour replication, so the pattern tables are exercised.
     const replicated=Buffer.alloc(bytes);for(let y=0;y<height*n;y++)for(let x=0;x<width*n;x++)replicated.set(data.subarray(((y/n|0)*width+(x/n|0))*4,((y/n|0)*width+(x/n|0))*4+4),(y*width*n+x)*4);
     if(!actual.equals(replicated))changed++;frames++;
    }
   }
  }
  expect(frames).toBe(6*3*15);expect(changed).toBe(180);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native linear and graph hqx plans with scalar conversions from rgba, rgb24 and other packed and gray sources',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-hqx-plan-'));let count=0;
 try{
  for(const source of ['rgba','rgb24','bgr24','argb','abgr','gray'])for(const [width,height]of [[5,3],[8,6]] as const){
   const input=source==='rgba'||source==='argb'||source==='abgr'?patterns(width,height)[14]!:sourceBytes(source,width,height,1);writeFileSync(join(root,'input.raw'),input);
   const frame=decode(input,source,width,height,9007199254740993n);
   for(const description of ['hqx','hqx=n=2','hqx=4,hflip','format=bgra,hqx=2,vflip'])for(const target of [null,'rgb24']){
    const label=`${source}/${width}x${height}/${description}/${target}`,expected=execFileSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'}),linear=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});
    expect(tight(linear),label).toEqual(expected);expect(linear.pts).toEqual(frame.pts);
    const graph=compileVideoFilterGraph(`[0:v]${description}[out]`).plan({format:source,width,height},[target],{arithmetic:'scalar'}).apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<22,maxResidentBytes:1<<24})[0]!;
    expect(tight(graph),label).toEqual(expected);count++;
   }
  }
  expect(count).toBe(96);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native replayed hqx streams with branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-hqx-stream-'));let checked=0;
 try{
  for(const [source,target]of [['bgra',null],['rgba','rgba'],['rgb24','rgb24']] as const){
   const data=source==='rgb24'?sourceBytes('rgb24',5,3,3):concat(patterns(5,3).slice(9,12)),size=pixelLayout(source,5,3).bytes,file=join(root,'input.raw');writeFileSync(file,data);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield decode(data.subarray(n*size,(n+1)*size),source,5,3,BigInt(n));}}};}};
   for(const graph of ['[in]hqx[out]','[in]hqx=n=2,hflip[out]','[in]split[x][y];[x]hqx=2[l];[y]hqx=2,vflip[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,hqx=4[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native hqx CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths',async()=>{
 const backends:readonly [string,(()=>ExecutionBackend),boolean][]=[['media',()=>createMediaBackend({pixelArithmetic:'scalar'}),true],['actor',()=>timedBackend('producer'),false],['activation',()=>timedBackend('activation'),false],['timed',()=>timedBackend('pull'),false]];let count=0;
 const root=mkdtempSync(join(tmpdir(),'edge-hqx-cli-'));
 try{
  for(const source of ['bgra','rgba','rgb24']){
   const input=source==='rgb24'?sourceBytes('rgb24',5,3,3):concat(patterns(5,3).slice(10,13));writeFileSync(join(root,'input.raw'),input);
   for(const description of ['hqx','hqx=2,hflip','split[a][b];[a]hqx=2[l];[b]hqx=2,vflip[r];[l][r]vstack'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]] as const){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'];
    const expected=new Map<string,Buffer>();
    for(const [name,backend,linear]of backends)for(const complex of linear&&!description.includes(';')?[false,true]:[true]){
     const after=[...(complex?['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']:['-vf',description]),...(linear?[]:['-fps_mode','passthrough','-enc_time_base','filter']),...outputTime,'-c:v','rawvideo','-bitexact','-f',format];
     const key=after.join(' ');if(!expected.has(key))expected.set(key,execFileSync(native,['-v','error',...before,...inputTime,'-i',join(root,'input.raw'),...after,'-']));
     const sink=collectingOutput(),result=await frontend(input,backend(),()=>sink.output).exec(['-y',...before,...inputTime,'-i','/in',...after,'/out']),label=`${source}/${description}/${format}/${inputTime}/${outputTime}/${name}/${complex}`;
     expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.get(key));expect(sink.committed).toBe(true);count++;
    }
   }
  }
  expect(count).toBe(3*2*3*(2*5+4));
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('negotiates every accepted source to bgra as native does, byte-exact on every path',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('hqx=n=2',negotiationSources,signal);
 expect(outcome.refused).toEqual({});
 expect(outcome.matched).toEqual(Object.fromEntries(negotiationSources.map(source=>[source,'bgra'])));
 expect(outcome.checks).toBe(73);
},120000);
it('refuses hqx output above maxFrameBytes and options native rejects or scopes out before any output is opened',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-hqx-reject-'));let rejected=0,scoped=0;
 try{
  const input=concat(patterns(3,2).slice(0,2));writeFileSync(join(root,'input.raw'),input);const frame=decode(input.subarray(0,24),'bgra',3,2,0n);
  // Input fits, scaled output does not: 3x2 bgra is 24 bytes, hq4x is 384 bytes.
  expect(()=>hqxVideoFrame(frame,parseHqxOptions('4'),{maxFrameBytes:383})).toThrow('hqx frame exceeds allocation limit');expect(hqxVideoFrame(frame,parseHqxOptions('4'),{maxFrameBytes:384}).planes[0]!.length).toBe(384);
  const plan=compileVideoFilterChain('hqx').plan('bgra',3,2);expect(()=>plan.apply(frame,{maxFrameBytes:215,maxStateBytes:0})).toThrow();
  for(const [options,accepted]of [['n=1',false],['n=5',false],['n=0',false],['n=-3',false],['enable=1',false],['foo=1',false],['n=2+1',true],['n=0x2',true],['n=4.0',true]] as const){
   const description=`hqx=${options}`,nativeRun=spawnSync(native,['-v','error','-f','rawvideo','-pixel_format','bgra','-s','3x2','-i',join(root,'input.raw'),'-vf',description,'-f','rawvideo','-'],{timeout:10000});
   expect(nativeRun.status===0,description).toBe(accepted);if(accepted)scoped++;else{expect(nativeRun.stdout.length,description).toBe(0);rejected++;}
   expect(()=>parseHqxOptions(options),description).toThrow(VideoHqxError);
   const complex=['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
   for(const [backend,filter]of [[createMediaBackend({pixelArithmetic:'scalar'}),['-vf',description]],[createMediaBackend({pixelArithmetic:'scalar'}),complex],[timedBackend('producer'),complex],[timedBackend('pull'),complex]] as const){
    let opened=0;const result=await frontend(input,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format','bgra','-video_size','3x2','-i','/in',...filter,'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);
   }
  }
  expect([rejected,scoped]).toEqual([6,3]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
