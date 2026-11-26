import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,videoStoragePixelFormat as storage} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {lutVideoFrame,parseLutOptions} from '../../packages/avfilter/src/video-lut.js';
import type {LutName} from '../../packages/avfilter/src/video-lut.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** The storage members of each native list, legacy yuvj links included (they run as full-range planar frames). */
const formats:Readonly<Record<LutName,readonly string[]>>={
 lut:['gray','yuv420p','yuv422p','yuv444p','yuva420p','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuvj420p','yuvj422p','yuvj444p'],
 lutrgb:['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],
 lutyuv:['yuv420p','yuv422p','yuv444p','yuva420p','yuvj420p','yuvj422p','yuvj444p']};
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Filtergraph option strings (one escape layer for the graph parser): defaults, the seven variables, per-component and alias
 * expressions, if()/between(), the 3-argument clip, state, random, the ported log, truncation of negatives and fractions. */
const expressions=['','negval','maxval-val','val*2','clip(val*3\\,16\\,235)',
 'c0=if(lt(val\\,128)\\,0\\,255):c1=between(val\\,32\\,96)*val:c2=minval+maxval-val:c3=val/2',
 'y=w*h+val:u=val+w-h:v=trunc(val*0.7)+h:a=255-clipval','r=st(0\\,ld(0)+3):g=floor(val/3)*3:b=random(1)*255:a=minval',
 'log(val+1)*40','if(between(val\\,minval\\,maxval)\\,val*h/w\\,negval)','mod(val\\,7)*30+bitand(val\\,0xf0)','-val+300.7:PI*val/4-E:gte(val\\,100)*255:negval-0.5'] as const;
const filter=(name:LutName,options:string)=>options?`${name}=${options}`:name;
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
/** Three frames: noise, then ramps with 0/255 edges, then constant planes. */
function pattern(format:string,width:number,height:number,seed:number):Uint8Array{
 const bytes=pixelLayout(storage(format),width,height).bytes,ramp=Uint8Array.from({length:bytes},(_,i)=>i%11===0?255:i%13===0?0:(i*29+seed)&255),flat=new Uint8Array(bytes).fill(seed*37&255);
 for(let i=0;i<bytes;i+=5)flat[i]=200;return Uint8Array.from([...noise(bytes,seed),...ramp,...flat]);
}
/** A rawvideo frame; a legacy yuvj source is a planar frame named by its legacy format, as the linear chains carry it. */
function frameOf(format:string,width:number,height:number,data:Uint8Array,n:number):VideoFrameData{
 const layout=pixelLayout(storage(format),width,height),bytes=data.subarray(n*layout.bytes,(n+1)*layout.bytes);
 if(storage(format)===format)return decodeRawVideo({streamIndex:0,data:bytes,pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});
 return {width,height,pixelFormat:format,planes:layout.planes.map(plane=>bytes.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:{value:BigInt(n),timeBase:{num:1n,den:25n}},metadata:{}};
}
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native lut, lutrgb and lutyuv frames for every storage format, size and expression',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lut-kernel-'));let count=0;
 try{
  for(const name of ['lut','lutrgb','lutyuv'] as const){
   const steps=expressions.map(options=>parseLutOptions(name,options?options.replaceAll('\\,',','):null));
   for(const format of formats[name])for(const [width,height]of name==='lut'?sizes:[sizes[0],sizes[2],sizes[5]]){
    const input=pattern(format,width,height,width*31+height+format.length),file=join(root,'input.raw');writeFileSync(file,input);
    for(const [index,options]of expressions.entries()){
     const label=`${name}/${format}/${width}x${height}/${options}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(name,options),'-f','rawvideo','-'],{timeout:10000});
     expect(native.status,label+native.stderr).toBe(0);const chunks:Uint8Array[]=[];
     for(let n=0;n<3;n++){const output=lutVideoFrame(frameOf(format,width,height,input,n),steps[index]!,{maxFrameBytes:1<<16});expect(output.pixelFormat).toBe(storage(format));chunks.push(...output.planes);}
     expect(Buffer.concat(chunks),label).toEqual(native.stdout);count++;
    }
   }
  }
  expect(count).toBe(15*6*12+14*3*12);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native lut tables for every 8-bit value of every component',()=>{
 // A 256x1 ramp in every component isolates each table, including both ends of the limited YUV ranges.
 const root=mkdtempSync(join(tmpdir(),'edge-lut-tables-'));let count=0;
 try{
  for(const format of formats.lut){
   const layout=pixelLayout(storage(format),256,1),data=new Uint8Array(layout.bytes);
   for(const plane of layout.planes)for(let x=0;x<plane.bytes;x++)data[plane.offset+x]=Math.floor(x*256/plane.bytes);
   const file=join(root,'input.raw');writeFileSync(file,data);
   for(const options of expressions){
    const label=`${format}/${options}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s','256x1','-i',file,'-vf',filter('lut',options),'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label).toBe(0);expect(Buffer.concat(lutVideoFrame(frameOf(format,256,1,data,0),parseLutOptions('lut',options?options.replaceAll('\\,',','):null),{maxFrameBytes:1<<16}).planes),label).toEqual(native.stdout);count++;
   }
  }
  expect(count).toBe(15*12);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Representative filter, source and option triples for the CLI, stream and timed paths. */
const scoped=[['lut','gray',expressions[4]],['lut','yuva420p',expressions[5]],['lut','bgra',expressions[7]],['lut','yuv422p',expressions[6]],['lutrgb','rgb24',expressions[5]],['lutrgb','argb',expressions[11]],['lutrgb','gbrp',expressions[1]],['lutyuv','yuv420p',expressions[4]],['lutyuv','yuv444p',expressions[8]]] as const;
it('matches native lut CLI rawvideo and framecrc through -vf and -filter_complex, with and without -ss/-t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lut-cli-'));let count=0;
 try{
  for(const [name,source,options]of scoped){
   const input=pattern(source,7,5,source.length*7+1),file=join(root,'input.raw'),files=new Map([['/in',input]]);writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(name,options),`vflip,${filter(name,options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.08']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(9*16);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native replayed lut branches, joins and the multi-input CLI frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lut-stream-'));let checked=0;
 try{
  for(const [name,source,options]of scoped){
   const input=pattern(source,5,3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield frameOf(source,5,3,input,index);}}};}};
   for(const graph of [`[in]${filter(name,options)}[out]`,`[in]split[x][y];[x]${filter(name,options)}[l];[y]${filter(name,'')},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(name,options)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});expect(native.status).toBe(0);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   expect(compileVideoFilterGraph(`[0:v]${filter(name,options)}[out]`).plan({format:source,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe(source);
  }
  const left=pattern('yuv420p',6,4,3),right=pattern('yuv420p',6,4,4),files=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(path:string)=>['-f','rawvideo','-pixel_format','yuv420p','-s','6x4','-i',path],after=['-filter_complex','[0:v]lutyuv=y=negval[a];[1:v]lut=u=val*2:v=clip(val\\,100\\,140),vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...input(join(root,'a.raw')),...input(join(root,'b.raw')),...after,'-'],{timeout:10000}),sink=collectingOutput();expect(native.status).toBe(0);
   const result=await frontend(files,media(),()=>sink.output).exec([...input('/a'),...input('/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(native.stdout);checked++;
  }
  expect(checked).toBe(9*3+2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native lut framecrc and rawvideo through the actor and timed schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lut-timed-'));let count=0;
 try{
  for(const [name,source,options]of scoped){
   const input=pattern(source,5,3,source.length*11+3),file=join(root,'input.raw'),files=new Map([['/in',input]]);writeFileSync(file,input);
   for(const chain of [filter(name,options),`hflip,${filter(name,options)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['3','2']){
    const before=['-y','-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-filter_complex',`[0:v]${chain}[x]`,'-map','[x]','-frames:v',frames,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format],label=`${source}/${chain}/${format}/${frames}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);
    for(const scheduler of ['pull','activation','producer'] as TimedVideoScheduler[]){
     const sink=collectingOutput(),result=await frontend(files,timed(scheduler),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+scheduler+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label+scheduler).toEqual(native.stdout);count++;
    }
   }
  }
  expect(count).toBe(9*8*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('fails like native on unparsable and NaN expressions and refuses gammaval, unported functions, int overflow and timelines before any output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lut-reject-'));let count=0;
 try{
  const input=pattern('yuv420p',4,2,3),files=new Map([['/in',input]]),file=join(root,'input.raw');writeFileSync(file,input);
  // Native status 234 is AVERROR(EINVAL) from config_props; 0 means native accepts what is refused here as a scope limit.
  const cases=[['lut=clip(val)',234,'Invalid lut expression'],['lut=c0=0/0',234,'evaluates to NaN'],['lutyuv=y=if(gt(val\\,300)\\,0/0\\,val)',234,'evaluates to NaN'],['lutrgb=r=(val+1)/0',0,'outside the int range'],['lut=hypot(val\\,20)',0,'depends on the numeric profile'],
   ['lut=gammaval(0.5)',0,'gammaval() and gammaval709() are not implemented'],['lutyuv=u=gammaval709(2.2)',0,'gammaval() and gammaval709() are not implemented'],['lut=sin(val)',0,'function sin() is not implemented'],['lut=exp(1)*val',0,'function exp() is not implemented'],
   ['lut=val^2',0,'operator ^ is not implemented'],['lut=pow(val\\,1)',0,'function pow() is not implemented'],['lut=1e10',0,'outside the int range'],['lut=-1e10',0,'outside the int range'],['lut=time(0)',0,'function time() is not implemented'],
   ['lut=negval:enable=gt(t\\,0.04)',0,'Lut timeline expressions are not implemented'],['lutyuv=y=negval:enable=1',0,'Lutyuv timeline expressions are not implemented'],['lut=bogus=1',null,'Unsupported lut option']] as const;
  for(const [description,status,message]of cases){
   const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','yuv420p','-s','4x2','-i',file,'-vf',description,'-f','null','-'],{timeout:10000});
   if(status===null)expect(native.status,description).not.toBe(0);else expect(native.status,description).toBe(status);
   for(const [mode,backend]of [['vf',media()],['complex',media()],['pull',timed('pull')],['producer',timed('producer')]] as const){
    const graph=mode==='vf'?['-vf',description]:['-filter_complex',`[0:v]${description}[out]`,'-map','[out]'];let opened=0;
    const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','yuv420p','-s','4x2','-i','/in',...graph,'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,description+mode).not.toBe(0);expect(opened,description+mode).toBe(0);expect(JSON.stringify(result.diagnostics),description+mode).toContain(message);count++;
   }
  }
  expect(existsSync(join(root,'out'))).toBe(false);expect(count).toBe(17*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 const outcomes=[];for(const vf of ['lut=negval','lutrgb=r=negval:b=val*2','lutyuv=y=negval:u=clip(val*3\\,16\\,235)'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 // lut keeps every source but nv12/nv21 (yuv420p); lutrgb keeps packed RGB(A) and gbrp, takes rgb24 from YUV and gray and argb from yuva420p; lutyuv keeps
 // planar YUV and legacy yuvj links, takes yuv444p from RGB, and picks yuvj444p from gray and yuva444p from packed alpha (no storage: refused by name).
 const same=(...names:string[])=>Object.fromEntries(names.map(name=>[name,name]));
 expect(outcomes.map(outcome=>outcome.matched)).toEqual([{...same(...negotiationSources),nv12:'yuv420p',nv21:'yuv420p'},
  {yuv420p:'rgb24',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'rgb24',yuv444p:'rgb24',gray:'rgb24',nv12:'rgb24',nv21:'rgb24',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'gbrp',yuvj420p:'rgb24',yuvj422p:'rgb24',yuvj444p:'rgb24'},
  {yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'}]);
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([{},{},{gray:'yuvj444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'}]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([73,73,93]);
},180000);
