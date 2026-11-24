import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
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
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// gray and packed RGB with alpha are excluded here: native converts them to yuvj444p and yuva444p, which are refused (last test).
// Every run uses -cpuflags 0 natively and the scalar profile here, so implicit swscale conversions stay on the scalar path.
const native=resolve('.build/reference/ffmpeg'),sources=['yuv420p','yuv422p','yuv444p','yuva420p','nv12','rgb24','gbrp'] as const,sizes=[[5,3],[7,5],[8,6]] as const,descriptions=['swapuv','swapuv,hflip','format=yuv422p,swapuv'];
/** Three frames: per-plane gradients and stripes mixed with LCG noise. */
function pattern(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=0x5eed^width*31^height;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const structured=(x*23+y*41+index*67+n*19)&255;out[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=(x+y+n)%3===0?seed>>>24:((x>>1)+y)&1?structured:255-structured;}
 return out;
}
const memoryFilesystem=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output']):VirtualFileSystem=>({async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}});
const budget={maxResidentBytes:16*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000};
const media=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFilesystem(input,open),backend:createMediaBackend({pixelArithmetic:'scalar'}),budget});
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timed=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFilesystem(input,open),backend:createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256}}),budget});
const decode=(input:Uint8Array,format:string,width:number,height:number,index:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:input.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});};
it('matches native -vf swapuv rawvideo and framecrc across formats sizes and time scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swapuv-cli-'));let count=0;
 try{
  for(const source of sources)for(const [width,height]of sizes){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of descriptions)for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']]]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-framerate','25',...inputTime!],after=['-vf',description,...outputTime!,'-bitexact','-f',format],expected=execFileSync(native,['-v','error',...before,'-i',file,...after,'-']),sink=collectingOutput(),label=`${source}/${width}x${height}/${description}/${format}/${inputTime}`;
    const result=await media(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(252);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native -filter_complex swapuv split branches through the media and timed backends',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swapuv-complex-'));let count=0;
 try{
  for(const source of sources)for(const [width,height]of sizes){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['[0:v]split[a][b];[a]swapuv[left];[b]hflip,swapuv[right]','[0:v]swapuv,split[left][right]','[0:v]format=yuv422p,split[a][b];[a]swapuv[left];[b]swapuv,vflip[right]'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...time,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(native,['-y','-v','error',...before,'-i',file,'-filter_complex',description,...outputs(root+'/')]);
    for(const [name,backend]of [['media',media],['timed',timed]] as const){
     const sinks=new Map<string,ReturnType<typeof collectingOutput>>(),label=`${name}/${source}/${width}x${height}/${description}/${format}/${time}`;
     const result=await backend(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec(['-y',...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);
     for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
    }
   }
  }
  expect(count).toBe(504);
 }finally{rmSync(root,{recursive:true,force:true});}
},480000);
it('matches native swapuv frame by frame through replay streams and activation actors',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swapuv-stream-')),EOF=-541478725;let count=0;
 try{
  for(const source of sources)for(const [width,height]of sizes){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input,source,width,height,index);}}};}};
   for(const filter of descriptions){
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',file,'-filter_complex',`[0:v]${filter}[out]`,'-map','[out]','-f','rawvideo',join(root,'native.raw')]);const expected=readFileSync(join(root,'native.raw')),label=`${source}/${width}x${height}/${filter}`;
    const execution=createReplayVideoExecution(`[in]${filter}[out]`,[replay],[null],{maxFrameBytes:65536,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),`stream/${label}`).toEqual(expected);expect(stamps).toEqual([0n,1n,2n]);
    const actors=createFrameActors(filter,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:65536,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:source,width,height}}]}),frames:VideoFrameData[]=[];
    try{for(let n=0;n<3;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input,source,width,height,n)});actors.endInput(0,EOF,3n);for(;;){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}frames.push(result.event!.frame);}}finally{actors.dispose();}
    const tight=frames.flatMap(frame=>pixelLayout(frame.pixelFormat,frame.width,frame.height).planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));
    expect(Buffer.concat(tight),`actor/${label}`).toEqual(expected);count++;
   }
  }
  expect(count).toBe(63);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses swapuv options and timeline before opening outputs on every backend',async()=>{
 const input=pattern('yuv420p',5,3);let count=0;
 for(const backend of [media,timed])for(const [flag,filter]of [['-vf','swapuv=enable=1'],['-vf','swapuv=threads=2'],['-filter_complex','[0:v]swapuv=enable=gte(t\\,0.04)[o]']] as const){
  let opened=0;const result=await backend(input,()=>{opened++;return collectingOutput().output;}).exec(['-f','rawvideo','-pixel_format','yuv420p','-s','5x3','-i','/in',flag,filter,...(flag==='-filter_complex'?['-map','[o]']:[]),'-f','rawvideo','/out']);
  expect(result.exitCode,filter).not.toBe(0);expect(opened,filter).toBe(0);count++;
 }
 expect(count).toBe(6);
});
it('negotiates every accepted source as native does and refuses the gray and packed-alpha picks without storage before output',async({signal})=>{
 // Native converts gray to yuvj444p and packed RGB with alpha to yuva444p, which have no frame storage here: refused by name on
 // every path. Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('swapuv',negotiationSources,signal);
 expect(outcome.refused).toEqual({gray:'yuvj444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(93);
},120000);
