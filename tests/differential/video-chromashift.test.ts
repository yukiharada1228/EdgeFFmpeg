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
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['yuv420p','yuv422p','yuv444p'] as const,EOF=-541478725;
/** Noise and a per-plane gradient, one frame each. */
function frames(format:string,width:number,height:number,count=2):Uint8Array{
 const layout=pixelLayout(format,width,height),output=new Uint8Array(layout.bytes*count);let seed=97+width*31+height;
 for(let n=0;n<count;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;output[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=n%2===0?seed>>>24:(x*11+y*29+index*67+n*5)&255;}
 return output;
}
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const memory=(input:Uint8Array)=>{const sink=collectingOutput();const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(){return sink.output;}};return {sink,filesystem};};
const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:20000};
/** The shift set: 0, +/-1, +/-3, larger than the chroma plane, +/-255, on each option and combined. */
function shiftOptions(width:number,height:number):string[]{
 const large=Math.max(width,height)+2,values=[0,1,-1,3,-3,large,-large,255,-255],result:string[]=[];
 for(const v of values)result.push(`cbh=${v}:crv=${v}`,`cbv=${v}:crh=${-v}`,`${v}:${-v}:${v}:${v}`);
 return result;
}
it('matches native linear chromashift rawvideo across formats, shifts, edges, sizes and noise and gradient inputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-linear-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[9,7],[16,12]] as const){
   const input=frames(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1].map(n=>decode(input,format,width,height,n));
   for(const shift of shiftOptions(width,height))for(const edge of ['smear','wrap']){
    const description=`chromashift=${shift}:edge=${edge}`,plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});expect(plan.pixelFormat).toBe(format);
    const actual=Buffer.concat(decoded.map(frame=>{const output=plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return tight(output);}));
    expect(actual,`${format}/${width}x${height}/${description}`).toEqual(execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']));count++;
   }
  }
  expect(count).toBe(486);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native chromashift -vf and -filter_complex CLI rawvideo and framecrc including implicit conversions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  const cases:[string,string|null,boolean][]=[...formats.map(format=>[format,null,false] as [string,null,boolean]),['bgr24',null,true],['gbrp','gbrp',true],['nv12','yuv420p',true],['rgb24','rgb24',true],['yuv420p','yuv444p',true]];
  for(const [source,target,scalar]of cases)for(const [width,height]of [[5,3],[16,12]] as const){
   const input=frames(source,width,height,3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['chromashift','chromashift=cbh=1:crv=-1','chromashift=3:-3:-1:1:wrap','chromashift=cbh=255:cbv=-255:crh=-17:crv=17:edge=wrap','chromashift=crh=-3:edge=smear,hflip','vflip,chromashift=cbv=2:crh=2:edge=1','format=yuv422p,chromashift=cbh=-2:crv=1:edge=wrap'])for(const graph of [false,true])for(const muxer of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),...(target?['-pix_fmt',target]:[]),'-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error',...(scalar?['-cpuflags','0']:[]),...before,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
    const result=await new FFmpeg({filesystem,backend:createMediaBackend({pixelArithmetic:scalar?'scalar':arithmetic}),budget}).exec([...before,'-i','/in',...after,'/out']);
    const label=`${source}/${target}/${width}x${height}/${description}/${graph}/${muxer}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(448);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native chromashift frame graphs and replayed streams with split and stack branches',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-graph-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[9,7]] as const){
   const input=frames(format,width,height,3),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input,format,width,height,n));
   for(const graph of ['[in]chromashift=cbh=2:crv=-3:edge=wrap[out]','[in]split[a][b];[a]chromashift=cbh=-1:cbv=1[l];[b]chromashift=crh=255:crv=-255:edge=wrap[r];[l][r]hstack[out]','[in]split[a][b];[a]chromashift=3:3:3:3[t];[b]vflip,chromashift=-3:-3:-3:-3:wrap[u];[t][u]vstack[out]','[in]split[a][b];[a]chromashift=cbv=1[o];[b]nullsink;[o]hflip[out]']){
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);const native=readFileSync(join(root,'native.raw'));
    const plan=compileVideoFilterGraph(graph.replace('[in]','[0:v]')).plan({format,width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(decoded.map(frame=>tight(plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!))),`graph ${format}/${width}x${height}/${graph}`).toEqual(native);count++;
    const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(const frame of decoded){signal.throwIfAborted();yield frame;}}};}};
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),`stream ${format}/${width}x${height}/${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);count++;
   }
  }
  expect(count).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native chromashift through activation actors and the timed backend in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-timed-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[16,12]] as const){
   const input=frames(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2,3].map(n=>decode(input,format,width,height,n)),geometry={format,width,height};
   for(const description of ['chromashift','chromashift=cbh=1:cbv=-1:crh=-3:crv=3','chromashift=255:-255:13:-13:wrap','hflip,chromashift=crv=-2:edge=wrap,vflip']){
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);
    const actors=createFrameActors(description,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry}]}),chunks:Buffer[]=[];
    try{for(const frame of decoded)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,4n);for(let attempt=0;;attempt++){expect(attempt).toBeLessThan(16);const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${format}/${width}x${height}/${description}`).toEqual(native);count++;
    for(const muxer of ['rawvideo','framecrc'])for(const time of [[],['-frames:v','2']]){
     const argv=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-filter_complex',`[0:v]${description}[x]`,'-map','[x]',...time,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer];
     const expected=execFileSync(ffmpeg,['-v','error',...argv,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
     const result=await new FFmpeg({filesystem,backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}),budget}).exec(['-y',...argv,'-i','/in',...after,'/out']);
     const label=`timed ${format}/${width}x${height}/${description}/${muxer}/${time}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
    }
   }
  }
  expect(count).toBe(120);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses chromashift yuva420p and out-of-range options before output where native accepts or fails them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-refuse-'));let count=0;
 try{
  for(const [source,description,nativeStatus,message]of [['yuva420p','chromashift',0,'yuva420p is not implemented'],['rgba','chromashift=cbh=1',0,'yuva420p is not implemented'],['yuv420p','chromashift=cbh=256',1,'-255 to 255'],['yuv420p','chromashift=crv=-256',1,'-255 to 255'],['yuv444p','chromashift=edge=2',1,'edge smear, wrap'],['yuv422p','chromashift=rh=1',1,'Unsupported chromashift option']] as const){
   const input=frames(source,5,3,2),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of [false,true])for(const timed of [false,true]){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),'-c:v','rawvideo','-bitexact','-f','framecrc'];
    const native=spawnSync(ffmpeg,['-v','error',...before,'-i',file,...after,'-']);expect(native.status===0?0:1,`${source}/${description}`).toBe(nativeStatus);
    const {sink,filesystem}=memory(input),result=await new FFmpeg({filesystem,backend:timed?createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}):createMediaBackend({pixelArithmetic:'scalar'}),budget}).exec(['-y',...before,'-i','/in',...after,'/out']);
    const label=`${source}/${description}/${graph}/${timed}`;expect(result.exitCode,label).not.toBe(0);expect(result.diagnostics.map(entry=>entry.message).join('\n'),label).toContain(message);expect(sink.bytes().length,label).toBe(0);expect(sink.committed,label).toBe(false);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('records the native gray to yuvj444p negotiation that the shared negotiation table cannot express',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromashift-gray-'));
 try{
  const file=join(root,'input.raw');writeFileSync(file,frames('gray',5,3,1));const log=spawnSync(ffmpeg,['-v','verbose','-f','rawvideo','-pixel_format','gray','-s','5x3','-i',file,'-vf','chromashift','-f','null','-']).stderr.toString();
  expect(log).toMatch(/fmt:gray .*-> w:5 h:3 fmt:yuvj444p/);expect(compileVideoFilterChain('chromashift').plan('gray',5,3).stages.map(stage=>stage.pixelFormat)).toEqual(['yuv444p','yuv444p']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
