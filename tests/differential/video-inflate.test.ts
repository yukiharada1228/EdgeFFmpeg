import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp'] as const;
/** Structured planes (noise, ramps, checkers, impulses, saturated flats) frame by frame. */
function patterned(format:string,width:number,height:number,frames:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,result=new Uint8Array(bytes*frames);let state=seed>>>0;
 for(let frame=0;frame<frames;frame++)for(let i=0;i<bytes;i++){
  state=(Math.imul(state,1664525)+1013904223)>>>0;const noise=state>>>24;
  result[frame*bytes+i]=[noise,(i*29)&255,(i&1)^((i/width|0)&1)?250:3,i%7===3?255:i%5===1?0:128,250+(noise&5),(i*37+13)&255][(frame+seed)%6]!;
 }
 return result;
}
const descriptions=['inflate','inflate=0','inflate=threshold0=3','inflate=1:2:3:4','inflate=threshold1=0:threshold2=40:threshold3=9','inflate=threshold0=255:threshold3=0','inflate=2.5:max/2:min','inflate=65535:65534:1'];
it('matches native inflate kernels across formats, sizes, thresholds, patterns and borders',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[2,1],[3,1],[4,3],[7,5],[17,9],[2,6],[1,4]] as const){
   const chroma=['yuv420p','yuv422p','yuva420p'].includes(format)&&width<=2,frames=6,input=patterned(format,width,height,frames,width*31+height),file=join(root,'input.raw'),bytes=pixelLayout(format,width,height).bytes;writeFileSync(file,input);
   for(const description of width===1?['inflate=0:0:0:0','inflate=threshold0=0:threshold1=0:threshold2=0:threshold3=0']:chroma?['inflate=threshold1=0:threshold2=0','inflate=5:0:0:7']:descriptions){
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),actual:Uint8Array[]=[];
    for(let index=0;index<frames;index++){const frame=plan.apply(decodeRawVideo({streamIndex:0,data:input.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}),{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});actual.push(...frame.planes);}
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);
    expect(Buffer.concat(actual),`${format}/${width}x${height}/${description}`).toEqual(native);count++;
   }
  }
  expect(count).toBe(240+12+12);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
const frontendFor=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:'scalar'}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000}});
it('matches native inflate CLI rawvideo and framecrc outputs across conversions and timing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-cli-'));let count=0;
 try{
  for(const [source,target]of [['yuv420p',null],['gbrp','rgb24'],['yuva420p','rgba'],['nv12','gray'],['gray','yuv444p'],['bgr24',null],['yuv422p','nv21']] as const){
   const input=patterned(source,7,5,4,source.length*7),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['inflate','inflate=threshold0=4:threshold1=0','hflip,inflate=9:9:9:9,scale=13:7','format=yuv444p,inflate=2,vflip'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-frames:v','2']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5',...inputTime!],after=['-vf',description,...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',format],sink=collectingOutput();
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']);
    const result=await frontendFor(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,description,format,result})).toBe(0);
    expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${format}/${inputTime}`).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(7*4*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native complex inflate graphs on the frame-graph path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-graph-'));let cases=0;
 try{
  for(const [source,left,right]of [['yuva420p','yuva420p','gray'],['gbrp','gbrp','yuv420p'],['gray','gray','gray'],['yuv444p','rgba','yuv444p']] as const){
   const input=patterned(source,6,5,3,source.length),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['[0:v]split[a][b];[a]inflate[left];[b]hflip,inflate=threshold0=6[right]','[0:v]inflate=3:0,split[left][right]','[0:v]split[a][b];[a]inflate,inflate[l];[b]transpose=clock,inflate=1[r];[l]null[left];[r]vflip[right]'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s','6x5'],outputs=(prefix:string)=>[['left',left],['right',right]].flatMap(([label,target],index)=>['-map',`[${label}]`,'-pix_fmt',target!,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',file,'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontendFor(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({source,description,format,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${description}/${format}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}cases++;
   }
  }
  expect(cases).toBe(4*3*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native replayed inflate streams frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-stream-'));let checked=0;
 try{
  for(const source of formats){
   const frameBytes=pixelLayout(source,5,4).bytes,input=patterned(source,5,4,3,9),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:4},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]inflate[out]','[in]inflate=8:0:20,hflip[out]','[in]split[x][y];[x]inflate[l];[y]inflate=0[r];[l][r]hstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x4','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(6*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
async function timedRun(scheduler:TimedVideoScheduler,input:Uint8Array,argv:readonly string[]){
 const published=new Map<string,Uint8Array>();let opened=0;
 const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(input.length),async readAt(offset,length,signal){signal?.throwIfAborted();return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){opened++;const chunks:Uint8Array[]=[];return {async write(bytes){chunks.push(bytes.slice());},async commit(){published.set(path,Buffer.concat(chunks));},async abort(){chunks.length=0;}};}};
 const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing fixture event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
 const result=await new FFmpeg({filesystem,backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128,scheduler}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:4096,maxPendingPackets:32,maxCpuTimeMs:10000}}).exec([...argv]);
 return {result,published,opened};
}
it('matches native inflate through the timed backend actor and pull schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-timed-'));let count=0;
 try{
  for(const source of formats){
   const input=patterned(source,6,4,4,17),file=join(root,'input.raw');writeFileSync(file,input);
   for(const filter of ['inflate','inflate=threshold0=5:threshold2=0','hflip,inflate=1:2:3:4','split[a][b];[a]inflate[c];[b]nullsink;[c]null'])for(const format of ['rawvideo','framecrc']){
    const tail=['-map','[x]','-frames:v','3','-fps_mode','passthrough','-c:v','rawvideo','-bitexact','-f',format];
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',source,'-video_size','6x4','-framerate','25','-i',file,'-filter_complex',`[0:v]${filter}[x]`,...tail,join(root,'native.out')]);const native=readFileSync(join(root,'native.out'));
    for(const scheduler of ['producer','activation','pull'] as const){
     const {result,published}=await timedRun(scheduler,input,['-y','-f','rawvideo','-pixel_format',source,'-video_size','6x4','-framerate','25','-i','/input/one','-filter_complex',`[0:v]${filter}[x]`,...tail,'/output/out']);
     expect(result.exitCode,JSON.stringify({source,filter,format,scheduler,result})).toBe(0);expect(Buffer.from(published.get('/output/out')!),`${source}/${filter}/${format}/${scheduler}`).toEqual(native);count++;
    }
   }
  }
  expect(count).toBe(6*4*2*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for unknown and out-of-range inflate options and refuses filtered width-1 planes before opening outputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inflate-reject-'));let count=0;
 try{
  const found=(key:string)=>`Error applying option '${key}' to filter 'inflate': Option not found`,range=(key:string)=>`Error applying option '${key}' to filter 'inflate': Numerical result out of range`,narrow='Inflate needs filtered planes at least two pixels wide';
  for(const [source,width,description,nativeMessage,message]of [['gray',4,'inflate=coordinates=3',found('coordinates'),found('coordinates')],['gray',4,'inflate=bogus=1',found('bogus'),found('bogus')],['gray',4,'inflate=threshold4=1',found('threshold4'),found('threshold4')],['yuv420p',4,'inflate=threshold0=65536',range('threshold0'),range('threshold0')],['yuv420p',4,'inflate=threshold1=-1',range('threshold1'),range('threshold1')],['gray',4,'inflate=1:2:3:4:5',"No option name near '5'",'Missing filter option name'],['gray',4,'inflate=threshold0=nan',"Error applying option 'threshold0' to filter 'inflate': Invalid argument","Error applying option 'threshold0' to filter 'inflate'"],['gray',1,'inflate',null,narrow],['yuv420p',2,'inflate',null,narrow],['yuva420p',2,'inflate=4:0:3',null,narrow],['gray',4,'inflate=enable=1',null,'Inflate timeline expressions are not implemented']] as const){
   const input=patterned(source,width,3,2,5),file=join(root,'input.raw');writeFileSync(file,input);
   const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x3`],native=spawnSync(ffmpeg,['-y','-v','error',...before,'-i',file,'-vf',description,'-f','rawvideo',join(root,'out.raw')],{timeout:10000});
   // Native accepts width-1 planes (reading past the row) and enable=; both are refused here by scope.
   if(nativeMessage===null)expect(native.status,description).toBe(0);else{expect(native.status,description).not.toBe(0);expect(native.stderr.toString(),description).toContain(nativeMessage);}
   const diagnostic=(result:{diagnostics:readonly {message:string}[]})=>result.diagnostics.map(entry=>entry.message).join('\n');
   let opened=0;const result=await frontendFor(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in','-vf',description,'-f','rawvideo','/out']);
   expect(result.exitCode,description).not.toBe(0);expect(diagnostic(result),description).toContain(message);expect(opened,description).toBe(0);
   const graph=await frontendFor(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in','-filter_complex',`[0:v]${description}[x]`,'-map','[x]','-f','rawvideo','/out']);
   expect(graph.exitCode,description).not.toBe(0);expect(diagnostic(graph),description).toContain(message);expect(opened,description).toBe(0);
   for(const scheduler of ['producer','pull'] as const){const timed=await timedRun(scheduler,input,['-y',...before,'-framerate','25','-i','/input/one','-filter_complex',`[0:v]${description}[x]`,'-map','[x]','-c:v','rawvideo','-f','rawvideo','/output/out']);expect(timed.result.exitCode,`${description}/${scheduler}`).not.toBe(0);expect(diagnostic(timed.result),`${description}/${scheduler}`).toContain(message);expect(timed.opened,`${description}/${scheduler}`).toBe(0);}
   count++;
  }
  expect(count).toBe(11);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 // Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('inflate=threshold0=12:threshold1=0',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
