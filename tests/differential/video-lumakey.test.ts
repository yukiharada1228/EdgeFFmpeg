import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// Integer keying after one double add and multiply per bound: every case runs on every platform. Every native run uses -cpuflags 0
// and the scalar profile here, so the implicit yuv420p -> yuva420p conversion stays on the scalar path.
const native=resolve('.build/reference/ffmpeg'),sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,time={num:1n,den:25n};
/** Defaults, the scoped option cases, softness 0.1 and 1, threshold 1, and bounds that clip or truncate. */
const cases=['lumakey','lumakey=0.5:0.2','lumakey=softness=0.1','lumakey=softness=1','lumakey=threshold=1','lumakey=0.5:0.2:0.1','lumakey=threshold=0.3:tolerance=0:softness=0.5','lumakey=1:1:1','lumakey=0.1:0.2:0.004','lumakey=tolerance=0.05:threshold=0.7:softness=0.3','lumakey=threshold=0.99:tolerance=0.001:softness=0.02'];
/** Three frames: per-plane gradients and stripes mixed with LCG noise; constant planes when `constant` is set. */
function pattern(format:string,width:number,height:number,frames=3,constant=false):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=0x1a3e^width*31^height;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const structured=(x*23+y*41+index*67+n*19)&255;out[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=constant?(index*60+n*90)&255:(x+y+n)%3===0?seed>>>24:((x>>1)+y)&1?structured:255-structured;}
 return out;
}
/** 16x16 yuva420p frames whose luma covers every 8-bit value (ascending, descending, shifted), with noisy alpha and chroma. */
function ramps():Uint8Array{
 const layout=pixelLayout('yuva420p',16,16),out=new Uint8Array(layout.bytes*3);let seed=99;
 for(let n=0;n<3;n++)for(const [index,plane]of layout.planes.entries())for(let i=0;i<plane.bytes;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;out[n*layout.bytes+plane.offset+i]=index===0?[i,255-i,(i*7+13)&255][n]!:seed>>>24;}
 return out;
}
const decode=(input:Uint8Array,format:string,width:number,height:number,index:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:input.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});};
const tight=(frames:readonly VideoFrameData[])=>Buffer.concat(frames.flatMap(frame=>pixelLayout(frame.pixelFormat,frame.width,frame.height).planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));
const files=(entries:ReadonlyMap<string,Uint8Array>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>({async openRead(path:string){const input=entries.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset:bigint,length:number){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path:string){return open(path);}});
const budget={maxResidentBytes:16*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000};
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
const frontend=(entries:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:files(entries,open),backend,budget});
it('runs against the reference build of commit 946fcce0 with x86 assembly disabled',()=>{
 const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:readonly string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(existsSync(native)).toBe(true);
});
it('matches native lumakey frames for every option case, size and luma ramp, with default and single filter threads',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-frame-'));let count=0;
 try{
  const inputs:(readonly [number,number,Uint8Array])[]=[...sizes.flatMap(([width,height])=>[[width,height,pattern('yuva420p',width,height)] as const,[width,height,pattern('yuva420p',width,height,3,true)] as const]),[16,16,ramps()]];
  for(const [width,height,input]of inputs){
   const file=join(root,'input.raw');writeFileSync(file,input);const frames=[0,1,2].map(n=>decode(input,'yuva420p',width,height,n));
   for(const description of cases){
    const before=['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format','yuva420p','-s',`${width}x${height}`,'-i',file],after=['-vf',description,'-f','rawvideo','-'],label=`${width}x${height}/${description}`;
    const threaded=execFileSync(native,[...before,...after]),single=execFileSync(native,['-filter_threads','1',...before,...after]);expect(single,`threads/${label}`).toEqual(threaded);
    const plan=compileVideoFilterChain(description).plan('yuva420p',width,height,{arithmetic:'scalar'});expect(plan.pixelFormat).toBe('yuva420p');
    const output=frames.map(frame=>plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}));expect(output.map(frame=>frame.pts!.value)).toEqual([0n,1n,2n]);
    expect(tight(output),label).toEqual(threaded);for(const [index,frame]of frames.entries())expect(Buffer.from(tight([frame])),`unmutated/${label}`).toEqual(Buffer.from(input.subarray(index*input.length/3,(index+1)*input.length/3)));count++;
   }
  }
  expect(count).toBe(143);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native -vf lumakey rawvideo and framecrc from yuva420p and yuv420p sources with and without time scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-cli-'));let count=0;
 try{
  for(const source of ['yuva420p','yuv420p'] as const)for(const [width,height]of sizes){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['lumakey','lumakey=0.5:0.2:0.1','lumakey=threshold=1:softness=1,hflip','vflip,lumakey=softness=0.1'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']]]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-framerate','25',...inputTime!],after=['-vf',description,...outputTime!,'-bitexact','-f',format],expected=execFileSync(native,['-v','error',...before,'-i',file,...after,'-']),sink=collectingOutput(),label=`${source}/${width}x${height}/${description}/${format}/${inputTime}`;
    const result=await frontend(new Map([['/in',input]]),media(),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native -filter_complex lumakey split branches on the graph path and the timed backend',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-complex-'));let count=0;
 try{
  for(const source of ['yuva420p','yuv420p'] as const)for(const [width,height]of [[5,3],[8,6],[17,9]] as const){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['[0:v]split[a][b];[a]lumakey=0.5:0.2[left];[b]hflip,lumakey=softness=1[right]','[0:v]lumakey=0.3:0.1:0.2,split[left][right]'])for(const format of ['rawvideo','framecrc'])for(const range of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...range,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(native,['-y','-v','error',...before,'-i',file,'-filter_complex',description,...outputs(root+'/')]);
    for(const [name,backend]of [['media',media()],['timed',timed('producer')]] as const){
     const sinks=new Map<string,ReturnType<typeof collectingOutput>>(),label=`${name}/${source}/${width}x${height}/${description}/${format}/${range}`;
     const result=await frontend(new Map([['/in',input]]),backend,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec(['-y',...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);
     for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
    }
   }
  }
  expect(count).toBe(96);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native lumakey on the stream path through replay execution, activation actors and the multi-input CLI',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-stream-')),EOF=-541478725;let count=0;
 try{
  for(const source of ['yuva420p','yuv420p'] as const)for(const [width,height]of sizes){
   const input=pattern(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decode(input,source,width,height,index);}}};}};
   for(const filter of ['lumakey=0.5:0.2:0.1','lumakey=softness=1,hflip','split[x][y];[x]lumakey=0.4:0.1[l];[y]lumakey=threshold=1[r];[l][r]hstack']){
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',file,'-filter_complex',`[0:v]${filter}[out]`,'-map','[out]','-f','rawvideo',join(root,'native.raw')]);const expected=readFileSync(join(root,'native.raw')),label=`${source}/${width}x${height}/${filter}`;
    const execution=createReplayVideoExecution(`[in]${filter}[out]`,[replay],[null],{maxFrameBytes:65536,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),frames:VideoFrameData[]=[];
    try{for await(const frame of execution.outputs[0]!.frames)frames.push(frame);}finally{await execution.close();}
    expect(tight(frames),`stream/${label}`).toEqual(expected);expect(frames.map(frame=>frame.pts!.value)).toEqual([0n,1n,2n]);count++;
    if(filter.includes(';'))continue;
    const actors=createFrameActors(filter,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:65536,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:source,width,height}}]}),actorFrames:VideoFrameData[]=[];
    try{for(let n=0;n<3;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input,source,width,height,n)});actors.endInput(0,EOF,3n);for(;;){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}actorFrames.push(result.event!.frame);}}finally{actors.dispose();}
    expect(tight(actorFrames),`actor/${label}`).toEqual(expected);count++;
   }
  }
  const left=pattern('yuva420p',5,3,3),right=pattern('yuva420p',5,3,3,true),entries=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(path:string)=>['-f','rawvideo','-pixel_format','yuva420p','-s','5x3','-i',path],after=['-filter_complex','[0:v]lumakey=0.5:0.2:0.1[a];[1:v]lumakey=threshold=0.3:softness=1,vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const expected=execFileSync(native,['-v','error','-cpuflags','0',...input(join(root,'a.raw')),...input(join(root,'b.raw')),...after,'-']),sink=collectingOutput();
   const result=await frontend(entries,media(),()=>sink.output).exec([...input('/a'),...input('/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(expected);count++;
  }
  expect(count).toBe(62);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native lumakey through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-timed-'));let count=0;
 try{
  for(const [source,width,height]of [['yuva420p',5,3],['yuva420p',17,9],['yuv420p',8,6]] as const){
   const input=pattern(source,width,height),entries=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
   for(const description of ['lumakey=0.5:0.2:0.1','lumakey=threshold=1:softness=1,hflip'])for(const format of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const)for(const range of [[],['-ss','0.04','-t','0.05']]){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-vf',description,...range,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format];
    const expected=execFileSync(native,['-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(entries,timed(scheduler),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${scheduler}/${range}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('fails like native for out-of-range lumakey options and refuses timeline and unscoped options before opening any output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-lumakey-reject-'));let count=0;
 try{
  const input=pattern('yuva420p',5,3,2),entries=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
  const source=(path:string)=>['-f','rawvideo','-pixel_format','yuva420p','-video_size','5x3','-framerate','25','-i',path];
  for(const [filter,message]of [['lumakey=threshold=1.5','Invalid lumakey threshold'],['lumakey=0:-0.5','Invalid lumakey tolerance'],['hflip,lumakey=softness=2','Invalid lumakey softness']] as const)
   for(const [flag,backend]of [['-vf',media()],['-filter_complex',media()],['-vf',timed('producer')],['-vf',timed('pull')]] as const){
    const graph=flag==='-vf'?['-vf',filter]:['-filter_complex',`[0:v]${filter}[o]`,'-map','[o]'],out=join(root,'out.raw');
    const status=spawnSync(native,['-y','-v','error',...source(join(root,'input.raw')),...graph,'-f','rawvideo',out],{timeout:10000});expect(status.status,filter).not.toBe(0);expect(existsSync(out),filter).toBe(false);
    let opened=0;const result=await frontend(entries,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...source('/in'),...graph,'-f','rawvideo','/out']);
    expect(result.exitCode,filter).not.toBe(0);expect(opened,filter).toBe(0);expect(JSON.stringify(result.diagnostics),filter).toContain(message);count++;
   }
  // Native supports these; they are outside the scope and fail here before output.
  for(const [filter,message]of [['lumakey=enable=1','timeline'],['lumakey=threads=2','Unsupported lumakey option'],['lumakey=threshold=1/2','Only constant decimal']] as const)for(const backend of [media(),timed('pull')]){
   let opened=0;const result=await frontend(entries,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...source('/in'),'-vf',filter,'-f','rawvideo','/out']);
   expect(result.exitCode,filter).not.toBe(0);expect(opened,filter).toBe(0);expect(JSON.stringify(result.diagnostics),filter).toContain(message);count++;
  }
  expect(count).toBe(18);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does and refuses the yuva422p and yuva444p picks without storage before output',async({signal})=>{
 // Native picks yuva420p from the 4:2:0 sources, which runs byte-exact on every path (the legacy yuvj420p source on linear chains).
 // Every other source picks yuva422p or yuva444p, which have no frame storage here: refused by name on every path and CLI backend.
 const outcome=await nativeNegotiationOutcome('lumakey=0.5:0.2:0.1',negotiationSources,signal);
 expect(outcome.matched).toEqual({yuv420p:'yuva420p',nv12:'yuva420p',nv21:'yuva420p',yuva420p:'yuva420p',yuvj420p:'yuva420p'});
 expect(outcome.refused).toEqual({rgb24:'yuva444p',bgr24:'yuva444p',yuv422p:'yuva422p',yuv444p:'yuva444p',gray:'yuva444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p',gbrp:'yuva444p',yuvj422p:'yuva422p',yuvj444p:'yuva444p'});
 expect(outcome.checks).toBe(113);
},240000);
