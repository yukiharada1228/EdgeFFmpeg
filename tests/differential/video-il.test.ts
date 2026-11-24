import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'] as const,sizes=[[8,8],[6,4],[16,12]] as const;
const modes=['none','i','d'] as const,triples=modes.flatMap(l=>modes.flatMap(c=>modes.map(a=>[l,c,a] as const))),swaps=[0,1,2,3,4,5,6,7];
/** Every mode triple with every swap-flag combination: 216 descriptions. */
const descriptions=triples.flatMap(([l,c,a])=>swaps.map(s=>`il=l=${l}:c=${c}:a=${a}:ls=${s&1}:cs=${s>>1&1}:as=${s>>2&1}`));
/** Row-structured pattern plus LCG noise so every row and plane is distinguishable. */
function pattern(format:string,width:number,height:number,frames:number,seed:number):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let state=seed>>>0;
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){state=(Math.imul(state,1664525)+1013904223)>>>0;out[f*layout.bytes+plane.offset+y*plane.rowBytes+x]=(y*29+p*61+f*7+((state>>>24)&7))&255;}
 return out;
}
const frontend=(input:Uint8Array,arithmetic:ReturnType<typeof referencePixelArithmetic>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:20000}});
function timedFrontend(input:Uint8Array,scheduler:'pull'|'activation',open:(path:string)=>ReturnType<typeof collectingOutput>['output']){
 const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
 return new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){return open(path);}},backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
}
it('matches native linear il for all 14 formats, every mode triple and every swap combination at even plane heights',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-il-linear-')),arithmetic=referencePixelArithmetic();let compared=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const frames=2,frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height,frames,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   // One native run per format and size: split into 216 branches, one rawvideo output each, no conversion.
   const graph=`[0:v]split=${descriptions.length}${descriptions.map((_,i)=>`[s${i}]`).join('')};`+descriptions.map((d,i)=>`[s${i}]${d}[o${i}]`).join(';');
   writeFileSync(join(root,'graph.txt'),graph);
   execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-/filter_complex',join(root,'graph.txt'),...descriptions.flatMap((_,i)=>['-map',`[o${i}]`,'-f','rawvideo','-pix_fmt',format,join(root,`o${i}.raw`)])],{maxBuffer:1<<24});
   for(const [i,description]of descriptions.entries()){
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic}),chunks:Uint8Array[]=[];
    for(let f=0;f<frames;f++){const frame=decodeRawVideo({streamIndex:0,data:input.slice(f*frameBytes,(f+1)*frameBytes),pts:BigInt(f),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}),output=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);chunks.push(...output.planes);}
    expect(Buffer.concat(chunks),`${format}/${width}x${height}/${description}`).toEqual(readFileSync(join(root,`o${i}.raw`)));compared++;
   }
  }
  expect(compared).toBe(14*3*216);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
const cliCases=['il','il=d:i:d','il=l=i:ls=1:c=d:cs=1:a=d:as=1','il=luma_mode=deinterleave:chroma_mode=interleave:alpha_mode=interleave:luma_swap=on','il=l=d,hflip,il=l=i:ls=1','vflip,il=a=d:as=1,transpose=clock'];
it('matches native il CLI rawvideo and framecrc through -vf and -filter_complex with timing scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-il-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const format of formats){
   const input=pattern(format,8,8,3,format.length*97),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of cliCases)for(const complex of [false,true])for(const muxer of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-f','rawvideo','-pixel_format',format,'-s','8x8'],after=[...(complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description]),'-pix_fmt',format,...time,'-bitexact','-f',muxer],native=execFileSync(ffmpeg,['-v','error',...before,'-i',file,...after,'-']),sink=collectingOutput();
    const label=`${format}/${description}/${complex}/${muxer}/${time}`,result=await frontend(input,arithmetic,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  // Negotiated conversion before il, with the scalar swscale profile on both sides.
  for(const [source,description,target]of [['rgb24','format=yuv420p,il=l=d:c=i','nv12'],['nv21','format=rgba,il=a=d:as=1','yuva420p']] as const){
   const input=pattern(source,8,8,2,3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const muxer of ['rawvideo','framecrc']){const before=['-f','rawvideo','-pixel_format',source,'-s','8x8'],after=['-vf',description,'-pix_fmt',target,'-bitexact','-f',muxer],native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']),sink=collectingOutput();
    const result=await frontend(input,'scalar',()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${description}/${muxer}`).toEqual(native);count++;}
  }
  expect(count).toBe(14*6*8+4);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native il graphs through replayed streams frame by frame',async()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-il-stream-'));let checked=0;
 try{
  for(const format of formats){
   const [width,height]=[6,4],frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height,3,format.length*13),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]il=l=d:c=d:a=d[out]','[in]il=i:i:i:1:1:1,hflip[out]','[in]split[x][y];[x]il=l=d[l];[y]il=ls=1:cs=1:as=1[r];[l][r]hstack[out]','[in]split[x][y];[x]il=c=i:a=i,vflip[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[format],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(14*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native il through the timed backend actor and pull schedulers in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-il-timed-'));let count=0;
 try{
  for(const format of formats){
   const [width,height]=[16,12],input=pattern(format,width,height,4,format.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const filter of ['il=l=d:c=i:a=d:ls=1','il=i:d:i:0:1:1,hflip','split[a][b];[a]il=l=d[p];[b]il=l=i:as=1[q];[p][q]vstack'])for(const muxer of ['rawvideo','framecrc'])for(const frames of ['4','2']){
    const argv=['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','IN','-filter_complex',`[0:v]${filter}[x]`,'-map','[x]','-frames:v',frames,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-pix_fmt',format,'-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error',...argv.map(value=>value==='IN'?file:value),'-']);
    for(const scheduler of ['activation','pull'] as const){
     const sink=collectingOutput(),label=`${format}/${filter}/${muxer}/${frames}/${scheduler}`,result=await timedFrontend(input,scheduler,()=>sink.output).exec([...argv.map(value=>value==='IN'?'/in':value),'/out']);
     expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);count++;
    }
   }
  }
  expect(count).toBe(14*3*2*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses odd processed plane heights on every flagged path before opening outputs, where native output is pool dependent',async()=>{
 const arithmetic=referencePixelArithmetic();let count=0;
 for(const [format,width,height]of [['gray',8,7],['yuv420p',8,6],['nv12',6,10],['rgba',4,5],['yuva420p',8,2],['gbrp',8,3]] as const){
  const input=pattern(format,width,height,2,5),before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`];
  for(const filter of ['-vf','-filter_complex']){let opened=0;const result=await frontend(input,arithmetic,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in',...(filter==='-vf'?['-vf','il=l=d']:['-filter_complex','[0:v]il[o]','-map','[o]']),'-f','rawvideo','/out']);expect(result.exitCode,`${format}/${filter}`).not.toBe(0);expect(opened).toBe(0);count++;}
  for(const scheduler of ['activation','pull'] as const){let opened=0;const result=await timedFrontend(input,scheduler,()=>{opened++;return collectingOutput().output;}).exec(['-y',...before,'-framerate','25','-i','/in','-filter_complex','[0:v]il=c=d[x]','-map','[x]','-fps_mode','passthrough','-c:v','rawvideo','-f','rawvideo','/out']);expect(result.exitCode,`${format}/${scheduler}`).not.toBe(0);expect(opened).toBe(0);count++;}
  const frameBytes=pixelLayout(format,width,height).bytes,replay:ReplayVideoSource={geometry:{format,width,height},timeBase:{num:1n,den:25n},open(){return {async *[Symbol.asyncIterator](){yield decodeRawVideo({streamIndex:0,data:input.slice(0,frameBytes),pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:4096}) as VideoFrameData;}};}};
  expect(()=>createReplayVideoExecution('[in]il[out]',[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),format).toThrow('even heights');count++;
 }
 expect(count).toBe(6*5);
},120000);
it('matches native il option aliases, shorthand and numeric forms, and refuses what native refuses',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-il-options-')),arithmetic=referencePixelArithmetic();let accepted=0,refused=0;
 try{
  for(const format of ['yuva420p','rgba','nv12'] as const){
   const input=pattern(format,8,8,1,17),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of ['l=2','l=02','ls=4294967297','ls=','i:d:i:1:0:1','d:c=1','l=interleave:luma_mode=d','luma_mode=deinterleave:chroma_mode=1:alpha_mode=i:luma_swap=yes:chroma_swap=off:alpha_swap=TRUE','c=d:cs=1','a=d:as=enabled']){
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s','8x8','-i',file,'-vf','il='+options,'-f','rawvideo','-']),frame=decodeRawVideo({streamIndex:0,data:input,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:8,height:8},{maxFrameBytes:4096});
    const plan=compileVideoFilterChain('il='+options).plan(format,8,8,{arithmetic});expect(Buffer.concat(plan.apply(frame,{maxFrameBytes:4096,maxStateBytes:0}).planes),`${format}/${options}`).toEqual(native);accepted++;
   }
   for(const options of ['l=3','l=-1','ls=2','ls=auto','l=x','l=i+d','l=','i:d:i:1:0:1:1']){
    expect(()=>execFileSync(ffmpeg,['-v','quiet','-f','rawvideo','-pixel_format',format,'-s','8x8','-i',file,'-vf','il='+options,'-f','rawvideo','-']),options).toThrow();expect(()=>compileVideoFilterChain('il='+options).plan(format,8,8),options).toThrow();refused++;
   }
  }
  expect([accepted,refused]).toEqual([30,24]);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
