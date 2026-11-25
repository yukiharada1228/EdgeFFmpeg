import {it,expect} from 'vitest';
import {execFile,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,videoStoragePixelFormat as storage} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {negotiateVideoFormats} from '../../packages/avfilter/src/video-format-negotiation.js';
import type {NegotiationStep} from '../../packages/avfilter/src/video-format-negotiation.js';
import {negotiationOrder,negotiableFormats,scaleOutputFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {collectingOutput} from '../helpers/output.js';
const native=resolve('.build/reference/ffmpeg'),refusal=/negotiates (\S+), which is not implemented$/;
/** Native stderr at info level, where showinfo prints the negotiated format of the link it sits on. */
const nativeLog=(args:readonly string[],signal:AbortSignal)=>new Promise<string>((done,fail)=>{execFile(native,['-hide_banner','-nostats','-v','info',...args],{encoding:'utf8',maxBuffer:1<<20,signal},(error,_stdout,stderr)=>{if(error)fail(new Error(`${args.join(' ')}: ${stderr}`));else done(stderr);});});
const shown=(log:string)=>{const match=/ fmt:(\S+) /.exec(log);if(!match)throw new Error('showinfo printed no format');return match[1]!;};
const bytes=(format:string,width:number,height:number,frames:number,seed:number)=>Uint8Array.from({length:pixelLayout(storage(format),width,height).bytes*frames},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
const list=(names:string)=>names.split(' ');
/** Operator lists transcribed from the pinned sources in their declared order, native-endian names. */
const neighbor=list('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le');
const nativeLists:readonly (readonly [string,readonly string[]])[]=[
 // vf_limiter.c, vf_neighbor.c (erosion) and vf_fillborders.c share one list: planar YUV, YUVA, GBR(A)P and gray.
 ['limiter',neighbor],['erosion',neighbor],['fillborders',neighbor],
 ['pixelize',list('gray gray9le gray10le gray12le gray14le gray16le yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le gbrap gbrap10le gbrap12le gbrap16le')],
 // vf_chromashift.c: chromashift takes planar YUV and YUVA only, rgbashift GBRP and GBRAP only.
 ['chromashift',list('yuva444p yuva422p yuva420p yuvj444p yuvj440p yuvj422p yuvj420p yuvj411p yuv444p yuv440p yuv422p yuv420p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuva420p10le yuva422p10le yuva444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuva422p12le yuva444p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p16le yuva422p16le yuva444p16le')],
 ['rgbashift',list('gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le')],
 // vf_swapuv.c is_planar_yuv and vf_shuffleplanes.c with the default map, both over every AVPixelFormat.
 ['swapuv',list('yuv420p yuv422p yuv444p yuv410p yuv411p yuvj420p yuvj422p yuvj444p yuv440p yuvj440p yuva420p yuv420p16le yuv420p16be yuv422p16le yuv422p16be yuv444p16le yuv444p16be yuv420p9be yuv420p9le yuv420p10be yuv420p10le yuv422p10be yuv422p10le yuv444p9be yuv444p9le yuv444p10be yuv444p10le yuv422p9be yuv422p9le yuva422p yuva444p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva444p9be yuva444p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva444p10be yuva444p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva444p16be yuva444p16le yuv420p12be yuv420p12le yuv420p14be yuv420p14le yuv422p12be yuv422p12le yuv422p14be yuv422p14le yuv444p12be yuv444p12le yuv444p14be yuv444p14le yuvj411p yuv440p10le yuv440p10be yuv440p12le yuv440p12be yuva422p12be yuva422p12le yuva444p12be yuva444p12le')],
 ['shuffleplanes',list('yuva420p yuva422p yuva444p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva444p9be yuva444p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva444p10be yuva444p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva444p16be yuva444p16le gbrap gbrap16be gbrap16le gbrap12be gbrap12le gbrap10be gbrap10le gbrapf32be gbrapf32le yuva422p12be yuva422p12le yuva444p12be yuva444p12le gbrap14be gbrap14le gbrapf16be gbrapf16le gbrap32be gbrap32le')],
];
/** Representative format= lists: planar YUV only, planar YUV with alpha, gbrp/gbrap and mixed families. */
const formatLists=['yuv420p|yuv422p|yuv444p','yuv410p|yuv411p|yuv440p|yuvj420p|yuvj422p|yuvj444p','yuv420p10le|yuv444p16le','yuva420p|yuva422p|yuva444p','yuva422p|yuva444p','gbrp|gbrap','gbrap','gbrp10le|gbrap16le','yuvj444p','gbrap|yuva444p|yuva420p','ya8|yuvj444p|gbrp','rgb0|bgr0|0rgb','nv16|nv24|p010le','yuyv422|uyvy422|yuv422p','pal8|rgb8|bgr4_byte'].map(value=>value.split('|'));
const formatStep=(pixelFormats:readonly string[]):NegotiationStep=>({name:'format',pixelFormat:pixelFormats.length===1?pixelFormats[0]!:null,pixelFormats:Object.freeze([...pixelFormats])});
const marker=compileVideoFilterChain('hflip').steps[0]! as NegotiationStep;
/** The format EdgeFFmpeg negotiates on the operator's links, read from an hflip marker (an every-format frame operator
 * standing where native's showinfo stands), or the format named by the plan-time refusal. */
function negotiated(source:string,steps:readonly NegotiationStep[],target:string|undefined):{format:string;refused:boolean}{
 try{const stages=negotiateVideoFormats(source,[...steps,marker],target);return {format:stages.find(stage=>stage.operation==='hflip')!.pixelFormat,refused:false};}
 catch(error){const match=refusal.exec((error as Error).message);if(!match)throw error;return {format:match[1]!,refused:true};}
}
/** Accepted inputs: the executable table and, on linear chains only, the legacy JPEG-range sources whose links store planar YUV.
 * A yuvj pick runs only when its producer reads a yuvj link, so it is executable from yuvj sources and refused from any other. */
const sources=[...negotiationOrder,'yuvj420p','yuvj422p','yuvj444p'],legacy=(format:string)=>storage(format)!==format;
const runs=(source:string,format:string)=>executableFormat(storage(format))&&(!legacy(format)||legacy(source));
it('picks the format native picks, or refuses that exact format, for every accepted input and operator list',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-video-negotiation-')),counts={matched:0,refused:0},refusedFormats=new Set<string>(),seen=new Map<string,string>();let seed=0x9e3779b9;
 // The divergences that deferred ten wave 1 video branches: native converts into a format the old table lacked, now refused by name.
 const notable=new Map([['rgba/limiter/undefined','gbrap'],['rgba/erosion/undefined','gbrap'],['rgba/fillborders/undefined','gbrap'],['rgba/pixelize/undefined','gbrap'],['gray/chromashift/undefined','yuvj444p'],['gray/swapuv/undefined','yuvj444p'],['rgba/swapuv/undefined','yuva444p'],['rgba/chromashift/undefined','yuva444p'],['rgba/shuffleplanes/undefined','gbrap'],['yuv420p/shuffleplanes/undefined','yuva420p'],['yuv444p/shuffleplanes/undefined','yuva444p'],['yuv422p/shuffleplanes/undefined','yuva422p'],['gbrp/rgbashift/undefined','gbrp'],['rgb24/rgbashift/undefined','gbrp'],['argb/rgbashift/undefined','gbrap'],
  // Legacy sources keep their JPEG-range names: transpose and negate stay full range, an exact list ranks yuv like RGB.
  ['yuvj422p/transpose=1/undefined','yuvj444p'],['yuvj444p/negate/undefined','yuvj444p'],['yuvj420p/format=yuv420p|yuv422p|yuv444p/undefined','yuv420p'],['yuvj444p/epx/undefined','argb']]);
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 // Seeded lists of two to five vf_scale output formats exercise the whole loss scoring through the native format filter.
 const random=Array.from({length:24},()=>{const picked=new Set<string>(),size=2+next()%4;while(picked.size<size)picked.add(scaleOutputFormats[next()%scaleOutputFormats.length]!);return [...picked];});
 const operators:readonly {readonly vf:string;readonly steps:readonly NegotiationStep[]}[]=[
  // EdgeFFmpeg operators with their own lists, and null with every format.
  ...['null','negate','transpose=1','epx'].map(vf=>({vf,steps:compileVideoFilterChain(vf).steps as readonly NegotiationStep[]})),
  // Registered operators negotiate through their own descriptors; rgbashift, not implemented, through a format step with its list.
  ...nativeLists.map(([vf,formats])=>({vf,steps:videoOperator(vf)?compileVideoFilterChain(vf).steps as readonly NegotiationStep[]:[formatStep(formats)]})),
  ...[...formatLists,...random].map(formats=>({vf:`format=${formats.join('|')}`,steps:[formatStep(formats)]})),
 ];
 try{
  expect(negotiableFormats.length).toBe(251);expect(nativeLists.flatMap(([,formats])=>formats).every(format=>negotiableFormats.includes(format))).toBe(true);
  // Each registered operator declares exactly the transcribed list; vf_neighbor.c's list is also dilation's, deflate's and inflate's.
  for(const [vf,formats]of [...nativeLists,['dilation',neighbor],['deflate',neighbor],['inflate',neighbor]] as const){if(vf==='rgbashift'){expect(videoOperator(vf)).toBeUndefined();continue;}expect(videoOperator(vf)!.formats!(compileVideoFilterChain(vf).steps[0]! as never),vf).toEqual(formats);}
  for(const source of sources)writeFileSync(join(root,source+'.raw'),bytes(source,4,4,1,source.length));
  function* cases(){for(const source of sources)for(const operator of operators)for(const target of [undefined,'yuv420p','rgba'])yield {source,operator,target};}
  await runBoundedCases(cases(),4,signal,async({source,operator,target},caseSignal)=>{
   const log=await nativeLog(['-f','rawvideo','-pixel_format',source,'-s','4x4','-i',join(root,source+'.raw'),'-vf',`${operator.vf},showinfo`,...(target?['-pix_fmt',target]:[]),'-f','null','-'],caseSignal),expected=shown(log),actual=negotiated(source,operator.steps,target),label=`${source}/${operator.vf}/${target}`;
   expect(actual.format,label).toBe(actual.refused?expected:storage(expected));expect(actual.refused,label).toBe(!runs(source,expected));counts[actual.refused?'refused':'matched']++;if(actual.refused)refusedFormats.add(expected);if(notable.has(label))seen.set(label,expected);
  });
  expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(notable));expect([...refusedFormats].sort().join(' ')).toBe('0rgb ayuv bgr48le gbrap gbrap10le gbrap16le gbrapf32le gbrp10le gbrp10msbbe gbrp12msbbe gbrp14be gray12be nv16 nv24 p010be p016be p212be p212le p412le p416be pal8 rgb8 x2rgb10le xv36le ya16be ya8 yuv420p10be yuv420p10le yuv420p12be yuv422p14le yuv422p9le yuv444p12le yuv444p14le yuv444p16le yuv444p9be yuva420p9be yuva420p9le yuva422p yuva422p16be yuva422p9le yuva444p yuva444p10be yuva444p12be yuva444p9be yuvj420p yuvj422p yuvj444p yuyv422');expect(counts).toEqual({matched:830,refused:1771});
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
const concat=(chunks:readonly Uint8Array[])=>Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)));
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725,budget={maxFrameBytes:1<<18,maxStateBytes:1<<22,maxResidentBytes:1<<24};
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
/** Each path through its public entry point, two 4x4 frames; every planner runs before the first frame is produced. */
function paths(format:string,data:Uint8Array){
 const shape={format,width:4,height:4},size=pixelLayout(format,4,4).bytes,frame=(n:number)=>decodeRawVideo({streamIndex:0,data:data.subarray(n*size,(n+1)*size),pts:BigInt(n),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width:4,height:4},{maxFrameBytes:1<<16});
 const source={geometry:shape,timeBase:time,frameRate:rate},timedSource=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<2;n++)yield {kind:'frame',frame:frame(n),duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}});
 return {
  async linear(vf:string){const plan=compileVideoFilterChain(vf).plan(format,4,4,{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),budget));},
  async graph(vf:string){const plan=compileVideoFilterGraph(`[0:v]${vf}[o]`).plan(shape,[null],{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),budget)[0]!);},
  async stream(vf:string){const execution=createReplayVideoExecution(`[0:v]${vf}[o]`,[{geometry:shape,timeBase:time,async *open(){for(let n=0;n<2;n++)yield frame(n);}}],[null],{...budget,maxSourceTraversals:16},{arithmetic:'scalar'});
   try{const frames:VideoFrameData[]=[];for await(const value of execution.outputs[0]!.frames)frames.push(value);return frames;}finally{await execution.close();}},
  async actor(vf:string){const actors=createFrameActors(vf,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:budget.maxFrameBytes,arithmetic:'scalar',numericProfile:'darwin-arm64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});
   try{for(let n=0;n<2;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:frame(n)});actors.endInput(0,EOF,2n);const frames:VideoFrameData[]=[];
    for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
  async timed(vf:string){const frames:VideoFrameData[]=[];await executeTimedGraph(planTimedVideoGraph(vf,[source],[null]),[timedSource],memoryStore,{numericProfile:'darwin-arm64',maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){frames.push(event.frame);}});return frames;},
 };
}
const timedBackend=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>memoryStore(),limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:()=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(){return open();}},backend,budget:{maxResidentBytes:8*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
it('refuses a negotiated format without storage on every path before output, and runs executable picks as native does',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-video-negotiation-paths-'));let refused=0,matched=0;
 try{
  // Formats with frame layouts but no conversion here, and lists where native's pick is executable although the list is not.
  for(const [source,vf]of [['gray','format=rgb555le'],['rgb24','format=monob'],['yuv420p','format=pal8|bgr8'],['gray','format=rgb0|bgr0|rgb555le'],['rgba','format=rgb565le|rgb555le|rgb444le'],['rgba','format=rgb0|rgb24'],['yuv420p','format=rgb0|yuv444p'],['rgba','hflip,format=bgr0|yuva420p']] as const){
   const data=bytes(source,4,4,2,vf.length),file=join(root,'input.raw');writeFileSync(file,data);
   const expected=shown(await nativeLog(['-f','rawvideo','-pixel_format',source,'-s','4x4','-i',file,'-vf',`${vf},showinfo`,'-f','null','-'],signal)),run=paths(source,data);
   if(executableFormat(expected)){
    const output=spawnSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','4x4','-i',file,'-vf',vf,'-f','rawvideo','-'],{timeout:10000});expect(output.status,vf).toBe(0);
    for(const [path,execute]of Object.entries(run)){const frames=await execute(vf);expect(frames.map(frame=>frame.pixelFormat),`${source}/${vf}/${path}`).toEqual([expected,expected]);expect(concat(frames.map(tight)),`${source}/${vf}/${path}`).toEqual(output.stdout);matched++;}
    continue;
   }
   for(const [path,execute]of Object.entries(run)){await expect(execute(vf),`${source}/${vf}/${path}`).rejects.toThrow(`negotiates ${expected}, which is not implemented`);refused++;}
   // The CLI refuses at plan time: no output is opened, on the linear chain and on the frame-graph and timed backends.
   for(const [backend,args]of [[createMediaBackend({pixelArithmetic:'scalar'}),['-vf',vf]],[createMediaBackend({pixelArithmetic:'scalar'}),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],[timedBackend('producer'),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],[timedBackend('pull'),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']]] as const){
    let opened=0;const result=await frontend(data,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format',source,'-video_size','4x4','-i','/in',...args,'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,`${source}/${vf}/${args[0]}`).not.toBe(0);expect(opened,`${source}/${vf}/${args[0]}`).toBe(0);expect(result.diagnostics.at(-1)?.message,`${source}/${vf}/${args[0]}`).toMatch(`negotiates ${expected}, which is not implemented`);refused++;
   }
  }
  expect({matched,refused}).toEqual({matched:15,refused:45});
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('converts legacy JPEG-range sources into the format native negotiates for them on linear chains',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-video-negotiation-jpeg-'));let checked=0;
 try{
  // Negotiated from the storage name, chains one, two, three, five and seven picked yuv444p, yuv420p, yuv420p, nv12 and yuv444p instead.
  for(const [source,vf]of [['yuvj420p','format=rgb24|yuv444p'],['yuvj422p','format=rgb24|yuv420p'],['yuvj444p','format=gbrp|yuv420p'],['yuvj420p','format=gray|yuva420p'],['yuvj444p','format=nv12|yuv422p|bgr24'],['yuvj422p','transpose=1'],['yuvj420p','negate,format=yuv444p|rgb24']] as const){
   const layout=pixelLayout(storage(source),4,4),data=bytes(source,4,4,1,vf.length),file=join(root,'input.raw');writeFileSync(file,data);
   const expected=shown(await nativeLog(['-f','rawvideo','-pixel_format',source,'-s','4x4','-i',file,'-vf',`${vf},showinfo`,'-f','null','-'],signal)),output=spawnSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','4x4','-i',file,'-vf',vf,'-f','rawvideo','-'],{timeout:10000});expect(output.status,vf).toBe(0);
   const frame:VideoFrameData={width:4,height:4,pixelFormat:source,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};
   const plan=compileVideoFilterChain(vf).plan(source,4,4,{arithmetic:'scalar'}),actual=plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes});
   expect(plan.pixelFormat,`${source}/${vf}`).toBe(storage(expected));expect(tight(actual),`${source}/${vf}`).toEqual(output.stdout);expect(actual.metadata.colorRange).toBe(2);checked++;
  }
  expect(checked).toBe(7);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
