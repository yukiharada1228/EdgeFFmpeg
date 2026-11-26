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
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
/** Structured planes (noise, ramps, checkers, impulses, saturated flats, a constant plane) frame by frame. */
function patterned(format:string,width:number,height:number,frames:number,seed:number):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,result=new Uint8Array(bytes*frames);let state=seed>>>0;
 for(let frame=0;frame<frames;frame++)for(let i=0;i<bytes;i++){
  state=(Math.imul(state,1664525)+1013904223)>>>0;const noise=state>>>24;
  result[frame*bytes+i]=[noise,(i*29)&255,(i&1)^((i/width|0)&1)?250:3,i%7===3?255:i%5===1?0:128,250+(noise&5),(i*37+13)&255,77,noise&1?255:0][(frame+seed)%8]!;
 }
 return result;
}
it('runs the locally built native reference at the pinned commit without x86 assembly',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
const descriptions=['yaepblur','yaepblur=r=1','yaepblur=radius=1000','yaepblur=s=1','yaepblur=s=2147483647','yaepblur=p=7','yaepblur=p=15:r=2:s=5','yaepblur=0','yaepblur=2:15:30','yaepblur=r=0:p=15','yaepblur=planes=6:sigma=1000','yaepblur=4:p=0'];
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
it('matches native yaepblur kernels across formats, sizes, radii, sigmas, planes, patterns and native thread counts',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [...sizes,[64,48]] as const){
   const frames=width===64?2:8,input=patterned(format,width,height,frames,width*31+height),file=join(root,'input.raw'),bytes=pixelLayout(format,width,height).bytes;writeFileSync(file,input);
   for(const description of descriptions){
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),actual:Uint8Array[]=[];
    for(let index=0;index<frames;index++){const frame=plan.apply(decodeRawVideo({streamIndex:0,data:input.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}),{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});actual.push(...frame.planes);}
    const args=['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'];
    // [THREADS] Slice threading partitions rows and columns only; one filter thread and the default count must agree.
    const native=execFileSync(ffmpeg,args),single=execFileSync(ffmpeg,['-filter_threads','1',...args]);
    expect(single,`${format}/${width}x${height}/${description}/threads`).toEqual(native);
    expect(Buffer.concat(actual),`${format}/${width}x${height}/${description}`).toEqual(native);count++;
   }
  }
  expect(count).toBe(6*7*12);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
const frontendFor=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:'scalar'}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000}});
it('matches native yaepblur CLI rawvideo and framecrc outputs across conversions and timing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-cli-'));let count=0;
 try{
  for(const [source,target]of [['yuv420p',null],['gbrp','rgb24'],['yuva420p','rgba'],['nv12','gray'],['gray','yuv444p'],['bgr24',null],['yuv422p','nv21']] as const){
   const input=patterned(source,7,5,4,source.length*7),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['yaepblur','yaepblur=r=1:p=15:s=9','hflip,yaepblur=2:7:40,scale=13:7','format=yuv444p,yaepblur=s=2147483647:p=3,vflip'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.08']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','7x5',...inputTime!],after=['-vf',description,...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',format],sink=collectingOutput();
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']);
    const result=await frontendFor(input,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,description,format,result})).toBe(0);
    expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${format}/${inputTime}`).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(7*4*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native complex yaepblur graphs on the frame-graph path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-graph-'));let cases=0;
 try{
  for(const [source,left,right]of [['yuva420p','yuva420p','gray'],['gbrp','gbrp','yuv420p'],['gray','gray','gray'],['yuv444p','rgba','yuv444p']] as const){
   const input=patterned(source,6,5,3,source.length),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['[0:v]split[a][b];[a]yaepblur[left];[b]hflip,yaepblur=r=1:p=15[right]','[0:v]yaepblur=3:3:1,split[left][right]','[0:v]split[a][b];[a]yaepblur,yaepblur=s=7[l];[b]transpose=clock,yaepblur=radius=9[r];[l]null[left];[r]vflip[right]'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s','6x5'],outputs=(prefix:string)=>[['left',left],['right',right]].flatMap(([label,target],index)=>['-map',`[${label}]`,'-pix_fmt',target!,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',file,'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontendFor(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({source,description,format,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${description}/${format}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}cases++;
   }
  }
  expect(cases).toBe(4*3*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native replayed yaepblur streams frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-stream-'));let checked=0;
 try{
  for(const source of formats){
   const frameBytes=pixelLayout(source,5,4).bytes,input=patterned(source,5,4,3,9),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of ['[in]yaepblur[out]','[in]yaepblur=1:15:3,hflip[out]','[in]split[x][y];[x]yaepblur[l];[y]yaepblur=p=6[r];[l][r]hstack[out]']){
    const replay:ReplayVideoSource={geometry:{format:source,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:4},{maxFrameBytes:4096});}}};}};
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
it('matches native yaepblur through the timed backend actor and pull schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-timed-'));let count=0;
 try{
  for(const source of formats){
   const input=patterned(source,6,4,4,17),file=join(root,'input.raw');writeFileSync(file,input);
   for(const filter of ['yaepblur','yaepblur=r=1:p=15:s=4','hflip,yaepblur=2:5:300','split[a][b];[a]yaepblur[c];[b]nullsink;[c]null'])for(const format of ['rawvideo','framecrc']){
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
it('fails like native for unknown and out-of-range yaepblur options and refuses enable= and runtime commands before opening outputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-yaepblur-reject-'));let count=0;
 try{
  // av_err2str(AVERROR(ERANGE)) is the reference host's strerror: glibc's on Linux, Darwin's on macOS. EdgeFFmpeg always prints glibc's.
  const hostRange=process.platform==='darwin'?'Result too large':'Numerical result out of range';
  const found=(key:string)=>`Error applying option '${key}' to filter 'yaepblur': Option not found`,range=(key:string,text='Numerical result out of range')=>`Error applying option '${key}' to filter 'yaepblur': ${text}`;
  for(const [description,nativeMessage,message]of [['yaepblur=bogus=1',found('bogus'),found('bogus')],['yaepblur=rad=1',found('rad'),found('rad')],['yaepblur=planes=16',range('planes',hostRange),range('planes')],['yaepblur=p=-1',range('p',hostRange),range('p')],['yaepblur=s=0',range('s',hostRange),range('s')],['yaepblur=sigma=2147483648',range('sigma',hostRange),range('sigma')],['yaepblur=r=-1',range('r',hostRange),range('r')],['yaepblur=radius=2147483648',range('radius',hostRange),range('radius')],['yaepblur=1:2:3:4',"No option name near '4'",'Missing filter option name'],['yaepblur=r=abc',"Error applying option 'r' to filter 'yaepblur'","Error applying option 'r' to filter 'yaepblur'"],['yaepblur=enable=1',null,'Yaepblur timeline expressions are not implemented'],['yaepblur=threads=1',null,'Yaepblur option threads is not implemented']] as const){
   const input=patterned('gray',4,3,2,5),file=join(root,'input.raw');writeFileSync(file,input);
   const before=['-f','rawvideo','-pixel_format','gray','-s','4x3'],native=spawnSync(ffmpeg,['-y','-v','error',...before,'-i',file,'-vf',description,'-f','rawvideo',join(root,'out.raw')],{timeout:10000});
   // Native accepts enable= and the generic context options; both are refused here by scope.
   if(nativeMessage===null)expect(native.status,description).toBe(0);else{expect(native.status,description).not.toBe(0);expect(native.stderr.toString(),description).toContain(nativeMessage);}
   const diagnostic=(result:{diagnostics:readonly {message:string}[]})=>result.diagnostics.map(entry=>entry.message).join('\n');
   let opened=0;const result=await frontendFor(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in','-vf',description,'-f','rawvideo','/out']);
   expect(result.exitCode,description).not.toBe(0);expect(diagnostic(result),description).toContain(message);expect(opened,description).toBe(0);
   const graph=await frontendFor(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in','-filter_complex',`[0:v]${description}[x]`,'-map','[x]','-f','rawvideo','/out']);
   expect(graph.exitCode,description).not.toBe(0);expect(diagnostic(graph),description).toContain(message);expect(opened,description).toBe(0);
   for(const scheduler of ['producer','pull'] as const){const timed=await timedRun(scheduler,input,['-y',...before,'-framerate','25','-i','/input/one','-filter_complex',`[0:v]${description}[x]`,'-map','[x]','-c:v','rawvideo','-f','rawvideo','/output/out']);expect(timed.result.exitCode,`${description}/${scheduler}`).not.toBe(0);expect(diagnostic(timed.result),`${description}/${scheduler}`).toContain(message);expect(timed.opened,`${description}/${scheduler}`).toBe(0);}
   count++;
  }
  expect(count).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 // Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('yaepblur=r=2:p=15:s=20',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
