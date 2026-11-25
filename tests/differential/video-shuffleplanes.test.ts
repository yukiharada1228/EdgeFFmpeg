import {expect,it} from 'vitest';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {shuffleplanesFormats,shuffleVideoPlanes} from '../../packages/avfilter/src/video-ops/shuffleplanes.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),run=promisify(execFile);
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'];
const tuples=['0:1:2:3','3:1:2:0','1:2:0:0','0:0:0:0','0:2:1:0','0:1:1:0','0:2:1:3','3:2:1:0','2:0:1:0','0:1:2:0','1:1:1:1','2:2:2:2','0:2:2:3','3:1:1:3'];
const filter=(tuple:string)=>tuple==='0:1:2:3'?'shuffleplanes':`shuffleplanes=${tuple}`;
const noise=(length:number,seed:number)=>Uint8Array.from({length},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%7===0?(i*29)&255:seed>>>24;});
/** The format native negotiated for the first shuffleplanes input, from -v verbose auto_scale insertion. */
function negotiated(stderr:string,source:string):string{
 const inserted=/auto-inserting filter '(auto_scale_\d+)' between the filter '[^']*' and the filter 'Parsed_shuffleplanes_\d+'/.exec(stderr);if(!inserted)return source;
 const scaled=new RegExp(`\\[${inserted[1]} @ [^\\]]+\\] w:\\d+ h:\\d+ fmt:\\w+ .*-> w:\\d+ h:\\d+ fmt:(\\w+)`).exec(stderr);if(!scaled)throw new Error('Missing native auto_scale format');return scaled[1]!;
}
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,structuredClone(value));},async read(index:number){return structuredClone(records.get(index)) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const frontendFor=(input:Uint8Array,backend:ReturnType<typeof createMediaBackend>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
it('matches native shuffleplanes query_formats and picks for every map tuple, refusing picks without storage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-formats-')),jobs:(()=>Promise<void>)[]=[];let accepted=0,converted=0,refused=0;
 try{
  for(const format of formats)writeFileSync(join(root,format+'.raw'),noise(pixelLayout(format,4,2).bytes,7));
  for(let code=0;code<256;code++){
   const map=[code&3,code>>2&3,code>>4&3,code>>6&3] as const,list=shuffleplanesFormats(map);
   for(const format of formats)jobs.push(async()=>{
    const {stderr}=await run(ffmpeg,['-hide_banner','-v','verbose','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s','4x2','-i',join(root,format+'.raw'),'-vf',`shuffleplanes=${map.join(':')}`,'-f','null','-']);
    // Native converts exactly when the source format is outside its list, which is ours; ours picks native's conversion target,
    // or refuses that exact format when it has no frame storage here.
    const label=`${format}/${map.join(':')}`,nativeFormat=negotiated(stderr,format),direct=nativeFormat===format;expect(direct,label).toBe(list.includes(format));expect(list,label).toContain(nativeFormat);
    const chain=compileVideoFilterChain(`shuffleplanes=${map.join(':')}`);
    if(executableFormat(nativeFormat)){expect(chain.plan(format,4,2,{arithmetic:'scalar'}).stages.find(stage=>stage.operation==='shuffleplanes')!.pixelFormat,label).toBe(nativeFormat);if(direct)accepted++;else converted++;}
    else{expect(()=>chain.plan(format,4,2,{arithmetic:'scalar'}),label).toThrow(`Video filter shuffleplanes input negotiates ${nativeFormat}, which is not implemented`);refused++;}
   });
  }
  const queue=[...jobs];await Promise.all(Array.from({length:4},async()=>{while(queue.length)await queue.shift()!();}));
  expect([accepted,converted,refused]).toEqual([195,510,2879]);
  // Defaults, packed formats and nv12 as recorded in the specification, now as the members with frame storage of native's lists.
  const stored=(map:readonly [number,number,number,number])=>shuffleplanesFormats(map).filter(executableFormat);
  expect(stored([0,1,2,3])).toEqual(['yuva420p']);expect(stored([0,0,0,0])).toEqual(['rgb24','bgr24','yuv444p','gray','argb','rgba','abgr','bgra','gbrp']);expect(stored([0,1,1,0])).toEqual(['yuv420p','yuv422p','yuv444p','nv12','nv21','yuva420p','gbrp']);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native shuffleplanes plane copies for every accepted map tuple and table format',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[1,1],[5,3],[6,4],[17,9]] as const){
   const input=noise(pixelLayout(format,width,height).bytes,width*31+height),file=join(root,'input.raw');writeFileSync(file,input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});
   for(let code=0;code<256;code++){
    const map=[code&3,code>>2&3,code>>4&3,code>>6&3] as const;if(!shuffleplanesFormats(map).includes(format))continue;
    const label=`${format}/${width}x${height}/${map.join(':')}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',`shuffleplanes=${map.join(':')}`,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label).toBe(0);const actual=shuffleVideoPlanes(frame,{name:'shuffleplanes',map},{maxFrameBytes:65536});
    expect(Buffer.concat(actual.planes),label).toEqual(native.stdout);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(780);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native linear shuffleplanes chains, refusing conversions into formats without storage by name',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-linear-'));let accepted=0,outside=0;
 try{
  for(const source of formats){
   const input=noise(pixelLayout(source,6,4).bytes,source.length*13),file=join(root,'input.raw');writeFileSync(file,input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:3n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:6,height:4},{maxFrameBytes:65536});
   for(const tuple of tuples)for(const description of [filter(tuple),`hflip,${filter(tuple)},vflip`])for(const target of [null,'yuv420p','rgba','gray']){
    const label=`${source}/${description}/${target}`,native=spawnSync(ffmpeg,['-hide_banner','-v','verbose','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','6x4','-i',file,'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-'],{timeout:10000});
    expect(native.status,label).toBe(0);const nativeFormat=negotiated(native.stderr.toString(),source),map=tuple.split(':').map(Number) as unknown as readonly [number,number,number,number];expect(shuffleplanesFormats(map),label).toContain(nativeFormat);
    // Native may convert to formats without frame storage here (gbrap, yuva444p, yuvj444p...): refused at plan time naming that format.
    if(!(formats as readonly string[]).includes(nativeFormat)){expect(()=>compileVideoFilterChain(description).plan(source,6,4,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'}),label).toThrow(`Video filter shuffleplanes input negotiates ${nativeFormat}, which is not implemented`);outside++;continue;}
    const plan=compileVideoFilterChain(description).plan(source,6,4,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'}),stage=plan.stages.find(entry=>entry.operation==='shuffleplanes')!;
    expect(stage.pixelFormat,label).toBe(nativeFormat);const output=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});
    expect(Buffer.concat(output.planes),label).toEqual(native.stdout);expect(output.pts).toEqual(frame.pts);accepted++;
   }
  }
  expect([accepted,outside]).toEqual([802,766]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
/** Sources and tuples whose native negotiation stays inside the table: direct, or yuv420p and nv21 to yuva420p. */
const scoped=[['yuva420p','0:1:2:3'],['yuv420p','3:1:2:0'],['nv12','0:1:1:0'],['nv21','0:2:1:3'],['yuv444p','1:2:0:0'],['gbrp','2:0:1:0'],['rgba','0:0:0:0'],['gray','0:0:0:0'],['yuv422p','0:2:1:0'],['bgr24','0:0:0:0']] as const;
it('matches native shuffleplanes CLI rawvideo and framecrc through -vf and -filter_complex',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const [source,tuple]of scoped){
   const input=noise(pixelLayout(source,5,3).bytes*4,source.length*7+1),file=join(root,'input.raw');writeFileSync(file,input);
   for(const complex of [false,true])for(const chain of [filter(tuple),`${filter(tuple)},hflip`])for(const target of [null,'yuv420p'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','2']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],graph=complex?['-filter_complex',`[0:v]${chain}[out]`,'-map','[out]']:['-vf',chain],after=[...graph,...(target?['-pix_fmt',target]:[]),...time,'-bitexact','-f',format],label=`${source}/${chain}/${complex}/${target}/${format}/${time}`;
    const native=spawnSync(ffmpeg,['-v','error',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);const sink=collectingOutput();
    const result=await frontendFor(input,createMediaBackend({pixelArithmetic:arithmetic}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(320);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native replayed shuffleplanes branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-stream-'));let checked=0;
 try{
  for(const [source,tuple]of scoped){
   const frameBytes=pixelLayout(source,5,3).bytes,input=noise(frameBytes*3,source.length*3+5),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of [`[in]${filter(tuple)}[out]`,`[in]split[x][y];[x]${filter(tuple)}[l];[y]${filter(tuple)},vflip[r];[l][r]hstack[out]`,`[in]split[x][y];[x]transpose=clock,${filter(tuple)}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});
    expect(Buffer.concat(chunks),`${source}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
   const plan=compileVideoFilterGraph(`[0:v]${filter(tuple)}[out]`).plan({format:source,width:5,height:3},[null]);expect(plan.negotiated.nodes[0]!.inputs[0]!.format,source).toBe(['yuv420p','nv21'].includes(source)?'yuva420p':source);
  }
  expect(checked).toBe(30);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native shuffleplanes framecrc and rawvideo through the actor and timed schedulers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-shuffleplanes-timed-'));let count=0;
 try{
  for(const [source,tuple]of scoped){
   const input=noise(pixelLayout(source,5,3).bytes*4,source.length*11+3),file=join(root,'input.raw');writeFileSync(file,input);
   for(const chain of [filter(tuple),`hflip,${filter(tuple)},transpose`])for(const format of ['rawvideo','framecrc'])for(const frames of ['4','2']){
    const before=['-y','-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-filter_complex',`[0:v]${chain}[x]`,'-map','[x]','-frames:v',frames,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format],label=`${source}/${chain}/${format}/${frames}`;
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],{timeout:10000});expect(native.status,label).toBe(0);
    for(const scheduler of ['pull','activation','producer'] as TimedVideoScheduler[]){
     const sink=collectingOutput(),backend=createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
     const result=await frontendFor(input,backend,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,label+scheduler+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label+scheduler).toEqual(native.stdout);count++;
    }
   }
  }
  expect(count).toBe(240);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses shuffleplanes timelines, unimplemented values and picks without storage before opening CLI outputs',async()=>{
 const input=noise(pixelLayout('gray',4,2).bytes*2,3);let count=0;
 for(const description of ['shuffleplanes=0:0:0:0:enable=1','shuffleplanes=map0=1+0','shuffleplanes=3:3:3:3','shuffleplanes=1:0:0:0:threads=1'])for(const complex of [false,true])for(const timed of [false,true]){
  // Native accepts all of these; the refusals are scope limits. Native converts gray to a four-plane format for 3:3:3:3, refused by name.
  const graph=complex?['-filter_complex',`[0:v]${description}[out]`,'-map','[out]']:['-vf',description],argv=['-f','rawvideo','-pixel_format','gray','-s','4x2'],native=spawnSync(ffmpeg,['-v','verbose',...argv,'-i','-',...graph,'-f','null','-'],{input,timeout:10000});
  if(!description.includes('threads'))expect(native.status,description).toBe(0);
  let opened=0;const backend=timed?createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:32,scheduler:'pull'}}):createMediaBackend({pixelArithmetic:'scalar'}),result=await frontendFor(input,backend,()=>{opened++;return collectingOutput().output;}).exec([...argv,'-i','/in',...graph,'-f','rawvideo','/out']);
  expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
  if(description==='shuffleplanes=3:3:3:3'){const pick=negotiated(native.stderr.toString(),'gray');expect(pick).toBe('gbrap');expect(result.diagnostics.at(-1)?.message,description).toContain(`negotiates ${pick}, which is not implemented`);}
 }
 expect(count).toBe(16);
},60000);
it('negotiates every accepted source as native does for three maps and refuses picks without storage before output on every path',async({signal})=>{
 // Each source runs byte-exact on every path (legacy yuvj sources on linear chains) or is refused naming native's pick on every path and
 // CLI backend with no output opened. The default map takes four-plane formats only: native adds alpha (yuva422p, yuva444p, gbrap).
 const outcomes=[];for(const vf of ['shuffleplanes','shuffleplanes=0:0:0:0','shuffleplanes=0:2:1:0'])outcomes.push(await nativeNegotiationOutcome(vf,negotiationSources,signal));
 expect(outcomes.map(outcome=>outcome.refused)).toEqual([
  {rgb24:'gbrap',bgr24:'gbrap',yuv422p:'yuva422p',yuv444p:'yuva444p',gray:'gbrap',argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap',gbrp:'gbrap',yuvj422p:'yuva422p',yuvj444p:'yuva444p'},
  {yuva420p:'yuva444p'},
  {gray:'yuvj444p',argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'},
 ]);
 expect(outcomes.map(outcome=>outcome.matched)).toEqual([
  {yuv420p:'yuva420p',nv12:'yuva420p',nv21:'yuva420p',yuva420p:'yuva420p',yuvj420p:'yuva420p'},
  {yuv420p:'yuv444p',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'yuv444p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv444p',nv21:'yuv444p',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',gbrp:'gbrp',yuvj420p:'yuvj444p',yuvj422p:'yuvj444p',yuvj444p:'yuvj444p'},
  {yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'},
 ]);
 expect(outcomes.map(outcome=>outcome.checks)).toEqual([113,77,93]);
},120000);
