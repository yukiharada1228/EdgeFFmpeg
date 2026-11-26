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
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[15,15]] as const;
const filters=['median','median=radius=2','median=radius=7','median=radius=1:radiusV=3','median=radius=3:radiusV=1','median=percentile=0','median=percentile=0.3','median=percentile=1','median=2:1','median=2:6:0:0.7','median=1:9:2','median=planes=0','median=radius=4:radiusV=2:percentile=0.25','median=127:15:127:0.5'];
/** Frame n%3: 0 is LCG noise, 1 is ramps with a vertical edge and impulses, 2 is a constant plane. */
function pattern(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);let seed=width*977+height*131+format.length;
 for(let frame=0;frame<frames;frame++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  const at=frame*layout.bytes+plane.offset+y*plane.rowBytes+x;seed=seed*1103515245+12345>>>0;
  data[at]=frame%3===0?seed>>>16&255:frame%3===1?((x*2+y)%7===3?250:(x*y)%11===5?3:x<plane.width>>1?(x*37+y*11+index*29)&255:200-y*9-index*13&255):60+index*41;
 }
 return data;
}
const base=['-f','rawvideo','-framerate','25'];
const memory=(inputs:Map<string,Uint8Array>)=>{const published=new Map<string,Uint8Array>();let opened=0;const filesystem:VirtualFileSystem={async openRead(path){const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,61));}};},async openWrite(path){opened++;const parts:Uint8Array[]=[];return {async write(chunk){parts.push(chunk.slice());},async commit(){published.set(path,Uint8Array.from(parts.flatMap(part=>[...part])));},async abort(){parts.length=0;}};}};return {filesystem,published,get opened(){return opened;}};};
const budget={maxResidentBytes:1<<24,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(filesystem:VirtualFileSystem)=>new FFmpeg({filesystem,budget,backend:createMediaBackend()});
const timedStore:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timed=(filesystem:VirtualFileSystem,scheduler:'pull'|'activation'|'producer')=>new FFmpeg({filesystem,budget,backend:createTimedVideoBackend({storage:timedStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}})});
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),out=new Uint8Array(layout.bytes);for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)out.set(frame.planes[index]!.subarray(y*frame.linesizes[index]!,y*frame.linesizes[index]!+plane.rowBytes),plane.offset+y*plane.rowBytes);return out;};
const decode=(format:string,width:number,height:number,input:Uint8Array,frames:number)=>{const frameBytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
it('runs the sandbox reference build of commit 946fcce0 without x86 assembly',()=>{
 const build=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
 expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');
});
it('matches native median for every format, radius, vertical radius, percentile, plane mask and small size on the linear and graph planners',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-median-matrix-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=pattern(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);const frames=decode(format,width,height,input,3);
   const graph=`[0:v]split=${filters.length}${filters.map((_,i)=>`[s${i}]`).join('')};`+filters.map((filter,i)=>`[s${i}]${filter}[o${i}]`).join(';');
   execFileSync(ffmpeg,['-y','-v','error','-nostdin','-filter_complex_threads','1',...base,'-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph,...filters.flatMap((_,i)=>['-map',`[o${i}]`,'-f','rawvideo',join(root,`${i}.raw`)])],{timeout:30000});
   const plan=compileVideoFilterGraph(graph).plan({format,width,height},filters.map(()=>null),{arithmetic:'scalar'}),graphOutputs=frames.map(frame=>plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<22,maxResidentBytes:1<<24}));
   for(const [i,filter]of filters.entries()){
    const native=new Uint8Array(readFileSync(join(root,`${i}.raw`))),linear=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});
    expect(Buffer.concat(frames.map(frame=>tight(linear.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:0})))),`linear ${format} ${width}x${height} ${filter}`).toEqual(Buffer.from(native));
    expect(Buffer.concat(graphOutputs.map(outputs=>tight(outputs[i]!))),`graph ${format} ${width}x${height} ${filter}`).toEqual(Buffer.from(native));compared+=2;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(2*formats.length*sizes.length*filters.length);
},300000);
const threadFilters=['median','median=radius=7','median=radius=2:radiusV=5:percentile=0.3','median=3:5:1:1','median=1:15:4:0'];
it('matches native median with default filter threads and with -filter_threads 1 on sliced frames',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-median-threads-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of [[64,48],[97,90]] as const){
   const input=pattern(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);const frames=decode(format,width,height,input,3);
   for(const filter of threadFilters){
    const run=(threads:readonly string[])=>execFileSync(ffmpeg,['-v','error','-nostdin',...threads,...base,'-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter,'-f','rawvideo','-'],{timeout:30000,maxBuffer:1<<24});
    const sliced=run([]),single=run(['-filter_threads','1']);expect(sliced,`${format} ${width}x${height} ${filter} threads`).toEqual(single);
    const linear=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});
    expect(Buffer.concat(frames.map(frame=>tight(linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:0})))),`${format} ${width}x${height} ${filter}`).toEqual(sliced);compared+=2;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(2*formats.length*2*threadFilters.length);
},300000);
const cliFilters=['median','median=radius=2:radiusV=1:percentile=0.3','median=3:5:0:1','median=planes=1,median=radius=1:radiusV=2:planes=14'];
const timings=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]] as const;
it('matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs with and without -ss and -t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-median-cli-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[17,9]] as const){
   const input=pattern(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   for(const filter of cliFilters)for(const muxer of ['rawvideo','framecrc'])for(const mode of ['linear','graph','stream','actor','producer','timed'] as const)for(const [inputTime,outputTime]of timings){
    const before=[...base,'-pixel_format',format,'-s',`${width}x${height}`],stream=mode==='stream';
    // The replay stream path is the multi-input CLI; the second input is erased by nullsink.
    const graph=stream?`[0:v]${filter}[o];[1:v]nullsink`:`[0:v]${filter}[o]`,after=mode==='linear'?['-vf',filter]:['-filter_complex',graph,'-map','[o]'],tail=[...outputTime,...(mode==='linear'||mode==='graph'||stream?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error','-nostdin','-filter_complex_threads','1',...before,...inputTime,'-i',file,...(stream?[...before,'-i',file]:[]),...after,...tail,'-'],{timeout:10000});
    const io=memory(new Map([['/in',input]])),engine=mode==='linear'||mode==='graph'||stream?media(io.filesystem):timed(io.filesystem,mode==='timed'?'pull':mode==='actor'?'activation':'producer');
    const result=await engine.exec([...before,...inputTime,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...tail,'/out']);expect(result.exitCode,JSON.stringify({format,filter,muxer,mode,inputTime,outputTime,diagnostics:result.diagnostics})).toBe(0);
    expect(Buffer.from(io.published.get('/out')!),`${mode} ${format} ${width}x${height} ${filter} ${muxer} ${inputTime.join(' ')} ${outputTime.join(' ')}`).toEqual(native);compared++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(formats.length*2*cliFilters.length*2*6*timings.length);
},300000);
it('matches native replayed median branches frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-median-stream-'));let checked=0;
 try{
  for(const format of formats){
   const frameBytes=pixelLayout(format,7,5).bytes,input=pattern(format,7,5,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width:7,height:5},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:7,height:5},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]median[out]','[in]median=radius=2:percentile=0.3,hflip[out]','[in]split[x][y];[x]median=3:5[l];[y]median=planes=0[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,median=1:15:2:1[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=execFileSync(ffmpeg,['-v','error','-nostdin',...base,'-pixel_format',format,'-s','7x5','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-']);
    expect(Buffer.concat(chunks),`${format} ${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(checked).toBe(24);
},120000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 const outcome=await nativeNegotiationOutcome('median=radius=2:radiusV=1:percentile=0.3',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
