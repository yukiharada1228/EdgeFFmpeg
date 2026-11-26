import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),metadata=resolve('.build/reference/build-metadata.json'),EOF=-541478725;
/** Single-precision HSL and lerp: macOS arm64 contracts multiply-adds, the x86-64 baseline does not (see docs/contributing/colorize.md). */
const unfused=process.platform==='linux'&&process.arch==='x64';
const storageFormats=['yuv420p','yuv422p','yuv444p','yuva420p'] as const,linearFormats=[...storageFormats,'yuvj420p','yuvj422p','yuvj444p'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Frame n%4: noise, horizontal-vertical ramps, edges (0/255 checker with a bright border), a constant plane per component. */
function frames(format:string,width:number,height:number,count=3):Uint8Array{
 const layout=pixelLayout(videoStoragePixelFormat(format)!,width,height),output=new Uint8Array(layout.bytes*count);let seed=131+width*31+height*7;
 for(let n=0;n<count;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const kind=n%4;
  output[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=kind===0?seed>>>24:kind===1?(x*255/Math.max(1,plane.rowBytes-1)+y*13+index*41)&255:kind===2?(x===0||y===0||x===plane.rowBytes-1||y===plane.height-1?255:(x+y)%2===0?0:255):index*85+23;
 }
 return output;
}
const legacy=(format:string)=>videoStoragePixelFormat(format)!==format;
/** Planar frames: decodeRawVideo for storage formats, the legacy yuvj name over its planar storage for linear chains. */
function decode(data:Uint8Array,format:string,width:number,height:number,index:number):VideoFrameData{
 const layout=pixelLayout(videoStoragePixelFormat(format)!,width,height),bytes=data.slice(index*layout.bytes,(index+1)*layout.bytes);
 if(legacy(format))return {width,height,pixelFormat:format,planes:layout.planes.map(plane=>bytes.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:{value:BigInt(index),timeBase:{num:1n,den:25n}},metadata:{}};
 return decodeRawVideo({streamIndex:0,data:bytes,pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});
}
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const memory=(input:Uint8Array)=>{const sink=collectingOutput();const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(){return sink.output;}};return {sink,filesystem};};
const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:20000};
const linearCase=(root:string,format:string,width:number,height:number,description:string,input:Uint8Array,decoded:readonly VideoFrameData[])=>{
 const file=join(root,'input.raw'),plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});
 const actual=Buffer.concat(decoded.map(frame=>{const output=plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return tight(output);}));
 writeFileSync(file,input);expect(actual,`${format}/${width}x${height}/${description}`).toEqual(execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']));
};
/** Defaults, each option at 0, its maximum and a typical value, hue sectors and their edges, and joint extremes. */
const optionCases=['colorize','colorize=hue=0','colorize=hue=360','colorize=hue=200','colorize=saturation=0','colorize=saturation=1','colorize=saturation=0.3','colorize=lightness=0','colorize=lightness=1','colorize=lightness=0.7','colorize=mix=0','colorize=mix=1','colorize=mix=0.4','colorize=60:1:0.5:0','colorize=120:0.8:0.25:0.6','colorize=180:1:0.75:0.2','colorize=240:0.5:0.5:0.9','colorize=300:1:1:0','colorize=359.9:0.05:0.95:0.5','colorize=hue=30:saturation=1:lightness=0.4:mix=0.25'];
it('uses a native reference built from 946fcce0 with --disable-x86asm',()=>{
 const build=JSON.parse(readFileSync(metadata,'utf8')) as {commit:string;flags:string[]};expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');
});
it('matches native linear colorize rawvideo for black overlays, which no multiply-add contraction can change',()=>{
 // lightness=0 gives p=q=r=g=b=0 exactly, so c[] is (0,127,127) and lerpf(0,v1,mix) adds 0 to v1*mix: fused or not, the same bytes.
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-black-'));let count=0;
 try{
  for(const format of linearFormats)for(const [width,height]of sizes){
   const input=frames(format,width,height),decoded=[0,1,2].map(n=>decode(input,format,width,height,n));
   for(const description of ['colorize=lightness=0','colorize=0:0:0:0','colorize=137:1:0:0.37','colorize=360:0.5:0:1']){linearCase(root,format,width,height,description,input,decoded);count++;}
  }
  expect(count).toBe(168);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!unfused)('matches native linear colorize rawvideo across formats, sizes, options and noise, ramp, edge and constant inputs (Linux x64 unfused float)',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-linear-'));let count=0;
 try{
  for(const format of linearFormats)for(const [width,height]of sizes){
   const input=frames(format,width,height),decoded=[0,1,2].map(n=>decode(input,format,width,height,n));
   for(const description of optionCases){linearCase(root,format,width,height,description,input,decoded);count++;}
  }
  expect(count).toBe(840);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it.skipIf(!unfused)('matches native colorize c[] over a hue, saturation and lightness grid on constant 1x1 frames (Linux x64 unfused float)',()=>{
 // Structured colour ramp: one 1x1 yuv444p frame per grid point, its luma 0, 128 and 255 under mix 0.5.
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-ramp-')),file=join(root,'input.raw');let count=0;
 try{
  writeFileSync(file,Uint8Array.from([0,1,2,128,3,4,255,5,6]));const decoded=[0,1,2].map(n=>decode(Uint8Array.from([0,1,2,128,3,4,255,5,6]),'yuv444p',1,1,n));
  const hues=[0,15,30,45,59.99,60,60.01,90,119.99,120,150,179.99,180,210,239.99,240,270,299.99,300,330,359.99,360];
  // Plus points where double instead of float HSL would change c[] (lightness 1 puts luma next to 219).
  const points=[...hues.flatMap(hue=>[0.001,0.25,0.5,1].flatMap(saturation=>[0.1,0.4999,0.5,0.9,1].map(lightness=>`${hue}:${saturation}:${lightness}`))),'180.81:0.882:1','112.73:0.524:1','260.19:0.524:1','27.23:0.478:1','56.12:0.932:1','316.84:0.101:1'];
  for(const point of points){
   const description=`colorize=${point}:0.5`,plan=compileVideoFilterChain(description).plan('yuv444p',1,1,{arithmetic:'scalar'});
   const actual=Buffer.concat(decoded.map(frame=>tight(plan.apply(frame,{maxFrameBytes:64,maxStateBytes:plan.stateBytes}))));
   expect(actual,description).toEqual(execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','yuv444p','-s','1x1','-i',file,'-vf',description,'-f','rawvideo','-']));count++;
  }
  expect(count).toBe(446);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it.skipIf(!unfused)('matches native colorize -vf and -filter_complex CLI rawvideo and framecrc with time selection and implicit conversions (Linux x64 unfused float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-cli-'));let count=0;
 try{
  // Packed and planar RGB orders and semi-planar sources convert implicitly with -cpuflags 0 and scalar arithmetic.
  const cases:[string,string|null][]=[...storageFormats.map(format=>[format,null] as [string,null]),['rgb24',null],['bgr24','rgb24'],['gbrp',null],['nv12','yuv420p'],['nv21',null],['yuv420p','yuv444p']];
  for(const [source,target]of cases)for(const [width,height]of [[5,3],[8,6]] as const){
   const input=frames(source,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['colorize','colorize=200:0.8:0.35:0.5','hflip,colorize=hue=300:saturation=1:lightness=0.6:mix=0,vflip'])for(const graph of [false,true])for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,...inputTime!],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
    const result=await new FFmpeg({filesystem,backend:createMediaBackend({pixelArithmetic:'scalar'}),budget}).exec([...before,'-i','/in',...after,'/out']);
    const label=`${source}/${target}/${width}x${height}/${description}/${graph}/${muxer}/${inputTime}/${outputTime}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(720);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it.skipIf(!unfused)('matches native colorize frame graphs and replayed streams with split and stack branches (Linux x64 unfused float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-graph-'));let count=0;
 try{
  for(const format of storageFormats)for(const [width,height]of [[5,3],[8,6]] as const){
   const input=frames(format,width,height,3),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input,format,width,height,n));
   for(const graph of ['[in]colorize=hue=90:saturation=0.7[out]','[in]split[a][b];[a]colorize=10:1:0.5:0.2[l];[b]colorize=mix=0:lightness=0.8[r];[l][r]hstack[out]','[in]split[a][b];[a]colorize[t];[b]vflip,colorize=330:0.4:0.3:0.7[u];[t][u]vstack[out]','[in]split[a][b];[a]colorize=hue=45[o];[b]nullsink;[o]hflip[out]']){
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);const native=readFileSync(join(root,'native.raw'));
    const plan=compileVideoFilterGraph(graph.replace('[in]','[0:v]')).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(decoded.map(frame=>tight(plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!))),`graph ${format}/${width}x${height}/${graph}`).toEqual(native);count++;
    const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(const frame of decoded){signal.throwIfAborted();yield frame;}}};}};
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),`stream ${format}/${width}x${height}/${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);count++;
   }
  }
  expect(count).toBe(64);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.skipIf(!unfused)('matches native colorize through activation actors and the timed backend in rawvideo and framecrc (Linux x64 unfused float)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-timed-'));let count=0;
 try{
  for(const format of storageFormats)for(const [width,height]of [[5,3],[8,6]] as const){
   const input=frames(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2,3].map(n=>decode(input,format,width,height,n)),geometry={format,width,height};
   for(const description of ['colorize','colorize=250:0.9:0.45:0.3','hflip,colorize=hue=20:mix=0,vflip']){
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);
    const actors=createFrameActors(description,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry}]}),chunks:Buffer[]=[];
    try{for(const frame of decoded)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,4n);for(let attempt=0;;attempt++){expect(attempt).toBeLessThan(16);const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${format}/${width}x${height}/${description}`).toEqual(native);count++;
    for(const muxer of ['rawvideo','framecrc'])for(const time of [[],['-frames:v','2'],['-ss','0.04','-t','0.08']]){
     const argv=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-filter_complex',`[0:v]${description}[x]`,'-map','[x]',...time,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer];
     const expected=execFileSync(ffmpeg,['-v','error',...argv,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
     const result=await new FFmpeg({filesystem,backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}),budget}).exec(['-y',...argv,'-i','/in',...after,'/out']);
     const label=`timed ${format}/${width}x${height}/${description}/${muxer}/${time}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
    }
   }
  }
  expect(count).toBe(168);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it.skipIf(!unfused)('matches native colorize with default slice threads and -filter_threads 1 (Linux x64 unfused float)',()=>{
 // ff_filter_execute splits on planeheight[1]; every slice writes disjoint rows, so the thread count never changes the bytes.
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-threads-'));let count=0;
 try{
  for(const format of storageFormats)for(const [width,height]of [[17,9],[64,48]] as const){
   const input=frames(format,width,height,3),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input,format,width,height,n));
   for(const description of ['colorize','colorize=75:0.6:0.55:0.35']){
    const run=(threads:string[])=>execFileSync(ffmpeg,['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);
    const threaded=run([]),single=run(['-filter_threads','1']),plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});
    expect(threaded,`${format}/${width}x${height}/${description}`).toEqual(single);
    expect(Buffer.concat(decoded.map(frame=>tight(plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes})))),`${format}/${width}x${height}/${description}`).toEqual(threaded);count++;
   }
  }
  expect(count).toBe(16);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses colorize packed-alpha picks, out-of-range and unimplemented options and enable= before output where native accepts or fails them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-colorize-refuse-'));let count=0;
 try{
  for(const [source,description,nativeStatus,message]of [['rgba','colorize=hue=10',0,'Video filter colorize input negotiates yuva444p, which is not implemented'],['yuv420p','colorize=hue=361',1,'colorize hue must be within [0,360]'],['yuv420p','colorize=saturation=-0.1',1,'colorize saturation must be within [0,1]'],['yuv444p','colorize=lightness=1.01',1,'colorize lightness must be within [0,1]'],['yuv422p','colorize=mix=2',1,'colorize mix must be within [0,1]'],['yuv420p','colorize=hue=1+1',0,'Only decimal colorize hue values'],['yuv420p','colorize=mix=max',0,'Only decimal colorize mix values'],['yuv420p','colorize=enable=1',0,'Colorize timeline expressions are not implemented'],['yuv444p','colorize=h=1',1,'Unsupported colorize option']] as const){
   const input=frames(source,5,3,2),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of [false,true])for(const timed of [false,true]){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),'-c:v','rawvideo','-bitexact','-f','framecrc'];
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']);expect(native.status===0?0:1,`${source}/${description}`).toBe(nativeStatus);
    const {sink,filesystem}=memory(input),result=await new FFmpeg({filesystem,backend:timed?createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}):createMediaBackend({pixelArithmetic:'scalar'}),budget}).exec(['-y',...before,'-i','/in',...after,'/out']);
    const label=`${source}/${description}/${graph}/${timed}`;expect(result.exitCode,label).not.toBe(0);expect(result.diagnostics.map(entry=>entry.message).join('\n'),label).toContain(message);expect(sink.bytes().length,label).toBe(0);expect(sink.committed,label).toBe(false);count++;
   }
  }
  expect(count).toBe(36);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the picks without storage before output',async({signal})=>{
 // Native converts gray to yuvj444p and packed RGB with alpha to yuva444p, which have no frame storage here: refused by name on
 // every path and CLI backend. A black overlay keeps the byte comparison independent of multiply-add contraction, so this runs on every platform.
 const outcome=await nativeNegotiationOutcome('colorize=hue=100:saturation=0.9:lightness=0:mix=0.6',negotiationSources,signal);
 expect(outcome.refused).toEqual({gray:'yuvj444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(93);
},120000);
