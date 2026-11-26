import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {chromanrPixelFormats} from '../../packages/avfilter/src/video-ops/chromanr.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n},arithmetic='scalar' as const;
/** The members of native's list with frame storage here, in declared order. */
const formats=chromanrPixelFormats.filter(executableFormat);
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
it('runs against the sandbox reference build of the fixed commit without x86 assembly',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(formats).toEqual(['yuv420p','yuv422p','yuv444p','yuva420p']);
});
/** Four frames per clip: LCG noise; 5x3 tiles of saturated values, gradients and xor ramps; low-amplitude noise over per-plane ramps
 * (most window samples pass the default thresholds); constant planes split by a vertical edge. */
function clip(format:string,width:number,height:number,frames=4):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=0x6b43a9b5;
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const tile=(Math.floor(x/5)+Math.floor(y/3)+p)%4,kind=f%4;
  out[f*layout.bytes+plane.offset+y*plane.rowBytes+x]=kind===0?seed>>>24:kind===1?(tile===0?255:tile===1?0:tile===2?(x*29+y*7+p*41)&255:(x^y)*17&255):kind===2?Math.min(255,Math.max(0,60+p*50+x*3+y*2+(seed>>>27)-16)):(x<plane.width/2?40+p*60:200-p*30);
 }
 return out;
}
/** Padded positive strides filled with a sentinel, so a kernel that reads past the row differs. */
function padded(format:string,width:number,height:number,bytes:Uint8Array,index:number,padding:number):VideoFrameData{
 const layout=pixelLayout(format,width,height),base=index*layout.bytes;
 return {width,height,pixelFormat:format,planes:layout.planes.map(p=>{const data=new Uint8Array((p.rowBytes+padding)*p.height).fill(211);for(let row=0;row<p.height;row++)data.set(bytes.subarray(base+p.offset+row*p.rowBytes,base+p.offset+(row+1)*p.rowBytes),row*(p.rowBytes+padding));return data;}),linesizes:layout.planes.map(p=>p.rowBytes+padding),pts:{value:BigInt(index),timeBase:time},metadata:{}};
}
const optionSets=[null,'distance=euclidean','sizew=1:sizeh=1','sizew=100:sizeh=100','20:3:7','stepw=2:steph=3','stepw=50:steph=50','sizew=8:sizeh=2:stepw=3:steph=2:distance=euclidean','thres=1','thres=200','thres=200:distance=euclidean','threy=1','threu=1:threv=200','thres=60:threy=10:threu=20.9:threv=15','thres=30.99:distance=1','thres=45.5:threy=199.9:distance=euclidean','thres=200:threy=200:threu=200:threv=199'];
it('matches native chromanr across formats, distances, window sizes, steps, thresholds and edge sizes on the linear and graph planners, with default and single filter threads',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromanr-')),run=(args:string[])=>execFileSync(ffmpeg,['-v','error','-cpuflags','0',...args]);let count=0,threads=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=clip(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);
   for(const options of optionSets){
    const description=options===null?'chromanr':`chromanr=${options}`,label=`${format}/${width}x${height}/${description}`,args=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'];
    const native=run(args);expect(run(['-filter_threads','1',...args]),label).toEqual(native);threads++;
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[format],{arithmetic});
    const frames=[0,1,2,3].map(n=>padded(format,width,height,input,n,n*3)),budget={maxFrameBytes:1<<16,maxStateBytes:0};
    const viaLinear=frames.map(frame=>linear.apply(frame,budget)),viaGraph=frames.map(frame=>graph.apply(frame,{...budget,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!);
    expect(linear.stages.map(stage=>stage.operation)).toEqual(['chromanr']);
    expect(Buffer.concat(viaLinear.flatMap(frame=>frame.planes)),label).toEqual(native);expect(Buffer.concat(viaGraph.flatMap(frame=>frame.planes)),label).toEqual(native);
    expect(viaLinear.map(frame=>frame.pts?.value)).toEqual([0n,1n,2n,3n]);expect(frames[0]!.planes[0]![0]).toBe(input[0]);count++;
   }
  }
  expect([count,threads]).toEqual([408,408]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native chromanr on frames tall enough for several native slices, with default and single filter threads',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromanr-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[64,48],[33,41]] as const){
   const input=clip(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);
   for(const description of ['chromanr','chromanr=thres=80:sizew=9:sizeh=4:stepw=2:distance=euclidean','chromanr=thres=120:threy=40:threu=25:threv=30:steph=3']){
    const args=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'],label=`${format}/${width}x${height}/${description}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-threads','4','-filter_threads','4',...args]);expect(execFileSync(ffmpeg,['-v','error','-cpuflags','0','-filter_threads','1',...args]),label).toEqual(native);expect(execFileSync(ffmpeg,['-v','error','-cpuflags','0',...args]),label).toEqual(native);
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic});
    expect(Buffer.concat([0,1,2,3].flatMap(n=>plan.apply(padded(format,width,height,input,n,1),{maxFrameBytes:1<<16,maxStateBytes:0}).planes)),label).toEqual(native);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
const memory=(files:Map<string,Uint8Array>)=>{
 const published=new Map<string,Uint8Array>();let opened=0;
 const filesystem:VirtualFileSystem={async openRead(path){const bytes=files.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){opened++;const sink=collectingOutput();return {...sink.output,async commit(){await sink.output.commit();published.set(path,sink.bytes());}};}};
 return {filesystem,published,opened:()=>opened};
};
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const backendFor=(scheduler:TimedVideoScheduler|undefined)=>scheduler?createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}}):createMediaBackend({pixelArithmetic:arithmetic});
it('matches native chromanr rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths, with and without output -ss/-t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromanr-cli-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[17,9]] as const){
   const a=clip(format,width,height,3),b=clip(format,width,height,4).subarray(pixelLayout(format,width,height).bytes),files=new Map([['/a',a],['/b',b]]);writeFileSync(join(root,'a'),a);writeFileSync(join(root,'b'),b);
   const input=(path:string)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',path];
   const cases:readonly {path:string;args:(name:(p:string)=>string)=>string[];scheduler?:TimedVideoScheduler}[]=[
    {path:'linear',args:name=>[...input(name('a')),'-vf','chromanr=thres=60:sizew=3']},
    {path:'graph',args:name=>[...input(name('a')),'-filter_complex','[0:v]chromanr=distance=euclidean:thres=45:threu=20[x]','-map','[x]']},
    {path:'stream',args:name=>[...input(name('a')),...input(name('b')),'-filter_complex','[0:v]chromanr[l];[1:v]chromanr=200:2:1:2:1[r];[l][r]hstack[x]','-map','[x]']},
    {path:'actor',args:name=>[...input(name('a')),'-filter_complex','[0:v]chromanr=thres=90:threy=12:stepw=2[x]','-map','[x]'],scheduler:'producer'},
    {path:'timed',args:name=>[...input(name('a')),'-filter_complex','[0:v]split[s][t];[s]chromanr=thres=150:sizeh=1:distance=1[x];[t]nullsink','-map','[x]'],scheduler:'pull'},
   ];
   for(const entry of cases)for(const muxer of ['rawvideo','framecrc'])for(const window of [[],['-ss','0.04','-t','0.05']]){
    const after=[...window,...(entry.scheduler?['-fps_mode','passthrough']:[]),'-pix_fmt',format,'-c:v','rawvideo','-bitexact','-f',muxer],label=`${format}/${width}x${height}/${entry.path}/${muxer}/${window.join(' ')}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...entry.args(p=>join(root,p)),...after,'-']);
    const io=memory(files),result=await new FFmpeg({filesystem:io.filesystem,backend:backendFor(entry.scheduler),budget}).exec(['-y',...entry.args(p=>'/'+p),...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);count++;
   }
  }
  expect(count).toBe(160);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed chromanr branches frame by frame through createReplayVideoExecution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromanr-stream-'));let checked=0;
 try{
  for(const format of formats){
   const width=9,height=7,frameBytes=pixelLayout(format,width,height).bytes,input=clip(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield {...padded(format,width,height,input.subarray(n*frameBytes,(n+1)*frameBytes),0,0),pts:{value:BigInt(n),timeBase:time}};}}};}};
   for(const graph of ['[in]chromanr=thres=70[out]','[in]split[x][y];[x]chromanr=distance=euclidean:sizew=2[l];[y]chromanr=thres=200:threv=9[r];[l][r]vstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[format],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native chromanr option acceptance and outputs, refusing expressions, named constants and timeline options explicitly',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-chromanr-options-'));let accepted=0,rejected=0,scoped=0;
 try{
  const format='yuv420p',width=17,height=9,input=clip(format,width,height,4),file=join(root,'in.raw');writeFileSync(file,input);
  for(const options of ['','45','45:2','45:2:3:2:1','45:2:3:2:1:100:90:80:euclidean','thres=1','thres=200','thres=0.5','thres=200.5','thres=0','thres=1e2','thres=.5e1','thres=+77','thres=30.000001','sizew=1:sizeh=100','sizew=0','sizew=101','sizeh=0x10','stepw=50','stepw=51','steph=0','distance=0','distance=1','distance=2','distance=-1','threy=1:threu=1:threv=1','threv=201','thres=20*2','thres=max','sizew=2.5','distance=manhattan+1','sizew=default']){
   const description=options?`chromanr=${options}`:'chromanr',native=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
   let actual:Buffer|null=null;try{const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic});actual=Buffer.concat([0,1,2,3].map(n=>Buffer.concat(plan.apply(padded(format,width,height,input,n,3),{maxFrameBytes:1<<16,maxStateBytes:0}).planes)));}catch(error){expect(error,description).toBeInstanceOf(Error);}
   if(native.status!==0){expect(actual,description).toBeNull();rejected++;}else if(actual===null)scoped++;else{expect(actual,description).toEqual(native.stdout);accepted++;}
  }
  expect([accepted,rejected,scoped]).toEqual([17,10,5]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses chromanr enable= and runtime commands before any output is opened, which native accepts',async()=>{
 const input=clip('yuv420p',5,3,2),files=new Map([['/a',input]]),args=['-f','rawvideo','-pixel_format','yuv420p','-video_size','5x3','-framerate','25','-i','/a'];let count=0;
 for(const filter of [['-vf','chromanr=enable=1'],['-filter_complex','[0:v]chromanr=enable=gte(t\\,0)[x]','-map','[x]'],['-filter_complex','[0:v]sendcmd=c=0 chromanr thres 50,chromanr[x]','-map','[x]']])for(const scheduler of [undefined,'producer','pull'] as const){
  const io=memory(files),result=await new FFmpeg({filesystem:io.filesystem,backend:backendFor(scheduler),budget}).exec(['-y',...args,...filter,'-c:v','rawvideo','-f','rawvideo','/out']);
  expect(result.exitCode,`${filter.join(' ')}/${scheduler}`).not.toBe(0);expect(io.opened(),`${filter.join(' ')}/${scheduler}`).toBe(0);count++;
 }
 const file=join(mkdtempSync(join(tmpdir(),'edge-chromanr-enable-')),'a');writeFileSync(file,input);
 try{expect(spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','yuv420p','-s','5x3','-i',file,'-vf','chromanr=enable=1','-f','null','-']).status).toBe(0);}finally{rmSync(join(file,'..'),{recursive:true,force:true});}
 expect(count).toBe(9);
},60000);
it('negotiates every accepted source as native does and refuses picks without frame storage before output on every path',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('chromanr=thres=60',negotiationSources,signal);
 expect(outcome.refused).toEqual({gray:'yuvj444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(93);
},120000);
