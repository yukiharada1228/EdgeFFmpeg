import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,constants} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileMultiInputVideoFilterGraph,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
import {parseXstackOptions} from '../../packages/avfilter/src/video-ops/xstack.js';
import {xstackGeometry} from '../../packages/avfilter/src/video-xstack.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
/** Structured ramps, edges and constant runs in even bytes, LCG noise in odd bytes. */
const pattern=(bytes:number,salt:number)=>{let seed=salt*7919+17;return Uint8Array.from({length:bytes},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%2?seed>>>24:i%10===0?0:i%10===2?255:i%10===4?128:(i*37+salt*13)&255;});};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frameOf=(format:string,width:number,height:number,data:Uint8Array,index:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const raw=(format:string,width:number,height:number)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'];
/** Equal-size exact tilings: the default 2x1 grid, w0 and the 2x2 mosaic, grids, + sums and reordered placements.
 * The two overlapping layouts are always refused (native copies inputs on parallel slice threads). */
const layouts=['','layout=0_0|w0_0','inputs=4:layout=0_0|0_h0|w0_0|w0_h0','grid=2x2','grid=3x1','grid=1x3','inputs=3:layout=0_0|w0_0|w0+w1_0','inputs=4:layout=0_h1|0_0|w1_h1|w1_0','inputs=3:layout=0_h1+h2|0_0|0_h1','inputs=3:layout=w1+w2_0|0_0|w1_0','inputs=4:layout=0_0|2_0|0_2|2_2','inputs=3:layout=0_0|w0_0|0_0'] as const;
/** null when our geometry refuses (overlaps, gaps, or chroma native writes outside the plane); then native is not compared. */
const accepted=(options:string,format:string,width:number,height:number)=>{const step=parseXstackOptions(options||null);try{xstackGeometry(Array.from({length:step.inputs},()=>({format,width,height})),step.layout);return step;}catch{return null;}};
it('runs against the sandbox reference built from commit 946fcce0 with --disable-x86asm',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(existsSync(ffmpeg)).toBe(true);
});
it('matches native xstack rawvideo across formats, sizes, grids and layouts with distinct inputs on the graph path',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-kernel-'));let count=0,refused=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const bytes=pixelLayout(format,width,height).bytes,data=[0,1,2,3].map(index=>index===3?new Uint8Array(bytes*3).fill(index*60+7):pattern(bytes*3,width*height+index*101));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const run=layouts.map(options=>[options,accepted(options,format,width,height)] as const).filter(([,step])=>step!==null||(refused++,false));if(!run.length)continue;
   const used=Math.max(...run.map(([,step])=>step!.inputs)),graph=[...Array.from({length:used},(_,index)=>{const pads=run.flatMap(([,step],l)=>step!.inputs>index?[`[i${index}l${l}]`]:[]);return `[${index}:v]split=${pads.length}${pads.join('')}`;}),
    ...run.map(([options,step],l)=>`${Array.from({length:step!.inputs},(_,index)=>`[i${index}l${l}]`).join('')}xstack${options?'='+options:''}[x${l}]`)].join(';');
   execFileSync(ffmpeg,['-y','-v','error',...Array.from({length:used},(_,index)=>[...raw(format,width,height),'-i',join(root,`${index}.raw`)]).flat(),'-filter_complex',graph,...run.flatMap((_,l)=>['-map',`[x${l}]`,'-f','rawvideo',join(root,`out${l}.raw`)])]);
   for(const [l,[options,step]]of run.entries()){
    const names=Array.from({length:step!.inputs},(_,index)=>`[s${index}]`).join(''),compiled=compileMultiInputVideoFilterGraph(`${names}xstack${options?'='+options:''}[out]`),order=compiled.graph.inputs.map(pad=>Number(pad.label!.slice(1))),plan=compiled.plan(order.map(()=>({format,width,height})),[null],{arithmetic:'scalar'});
    const chunks=[0,1,2].flatMap(n=>{const frames=order.map(source=>frameOf(format,width,height,data[source]!,n)),before=frames.map(frame=>Buffer.concat(frame.planes)),output=plan.applyBatch(frames,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes,maxResidentBytes:1<<20});expect(frames.map(frame=>Buffer.concat(frame.planes))).toEqual(before);expect(output[0]!.pts!.value).toBe(BigInt(n));expect(output[0]!.metadata).toEqual({});return output[0]!.planes;});
    expect(Buffer.concat(chunks),`${format}/${width}x${height}/${options}`).toEqual(readFileSync(join(root,`out${l}.raw`)));count++;
   }
  }
  expect({count,refused}).toEqual({count:662,refused:346});
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
/** Per format: a base size whose offsets keep chroma inside every plane, and mixed sizes that tile exactly. */
const cliFormats=[['gray',5,3],['yuv420p',4,2],['yuv422p',6,3],['yuv444p',3,3],['yuva420p',8,6],['nv12',2,2],['nv21',4,4],['rgba',5,3],['rgb24',7,5],['bgr24',1,1],['gbrp',7,5],['argb',2,3]] as const;
type CliCase=readonly [name:string,before:readonly string[],after:readonly string[],sizes:readonly (readonly [number,number])[],lengths:readonly number[]];
const cliCases=(w:number,h:number):readonly CliCase[]=>[
 ['split-grid',[],['-filter_complex','[0:v]split=4[a][b][c][d];[a]hflip[x];[d]vflip[y];[x][b][c][y]xstack=grid=2x2[out]','-map','[out]'],[[w,h]],[3]],
 ['split-ss',['-ss','0.04'],['-filter_complex','[0:v]split=3[a][b][c];[a][b][c]xstack=grid=3x1[out]','-map','[out]','-t','0.04'],[[w,h]],[3]],
 ['mixed-layout',[],['-filter_complex','[0:v][1:v][2:v]xstack=inputs=3:layout=0_0|0_h0|w1_h0[out]','-map','[out]'],[[2*w,h],[w,h+2],[w,h+2]],[3,3,3]],
 ['mixed-grid',[],['-filter_complex','[0:v][1:v][2:v][3:v]xstack=grid=2x2[out]','-map','[out]'],[[2*w,h],[w,h],[w,h+2],[2*w,h+2]],[3,3,3,3]],
 ['unequal',[],['-filter_complex','[0:v][1:v][2:v]xstack=grid=1x3[out]','-map','[out]'],[[w,h],[w,h],[w,h]],[3,2,4]],
 ['shortest',[],['-filter_complex','[0:v][1:v][2:v]xstack=grid=3x1:shortest=1[out]','-map','[out]'],[[w,h],[w,h],[w,h]],[3,2,4]],
 ['layout-ss-t',['-ss','0.04'],['-filter_complex','[1:v][0:v]xstack=layout=w1_0|0_0[out]','-map','[out]','-t','0.08'],[[w,h],[w+2,h]],[4,3]],
];
const cliInputs=(format:string,root:string|null,sizes:CliCase[3],lengths:CliCase[4])=>{const data=sizes.map(([width,height],index)=>pattern(pixelLayout(format,width,height).bytes*lengths[index]!,index*101+width*7+height));if(root)for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);return data;};
it('matches native xstack CLI rawvideo and framecrc on the graph and stream paths, with mixed sizes, -ss, -t, unequal lengths and shortest',async()=>{
 let count=0;const root=mkdtempSync(join(tmpdir(),'edge-xstack-cli-'));
 try{
  for(const [format,w,h]of cliFormats)for(const [name,before,after,sizes,lengths]of cliCases(w,h)){
   const data=cliInputs(format,root,sizes,lengths),files=new Map(data.map((value,index)=>[`/${index}`,value]));
   for(const output of ['rawvideo','framecrc']){
    const args=(path:(index:number)=>string)=>[...sizes.flatMap(([width,height],index)=>[...before,...raw(format,width,height),'-i',path(index)]),...after,'-bitexact','-f',output];
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...args(index=>join(root,`${index}.raw`)),'-']),sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...args(index=>`/${index}`),'/out']);const label=`${format}/${name}/${output}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(native.length,label).toBeGreaterThan(0);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(168);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native xstack on the stream path through replay execution with distinct sources of unequal length and shortest',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-stream-'));let checked=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuva420p',6,4],['gbrp',7,5],['nv12',4,2]] as const)for(const lengths of [[3,3,3],[3,1,2],[1,3,2]] as const)for(const options of ['grid=3x1','grid=3x1:shortest=1','inputs=3:layout=0_h1+h2|0_0|0_h1']){
   const bytes=pixelLayout(format,width,height).bytes,data=lengths.map((frames,index)=>pattern(bytes*frames,index*37+width));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const source=(index:number):ReplayVideoSource=>({geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<lengths[index]!;n++){signal.throwIfAborted();yield frameOf(format,width,height,data[index]!,n);}}};}});
   const graph=`[s0][s1][s2]xstack=${options}[out]`,order=compileMultiInputVideoFilterGraph(graph).graph.inputs.map(pad=>Number(pad.label!.slice(1)));
   const execution=createReplayVideoExecution(graph,order.map(source),[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:8},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
   try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
   execFileSync(ffmpeg,['-y','-v','error',...[0,1,2].flatMap(index=>[...raw(format,width,height),'-i',join(root,`${index}.raw`)]),'-filter_complex',graph.replace('[s0][s1][s2]','[0:v][1:v][2:v]'),'-map','[out]','-fps_mode','passthrough','-f','rawvideo',join(root,'native.raw')]);
   const label=`${format}/${lengths}/${options}`,frames=options.includes('shortest')?Math.min(...lengths):Math.max(...lengths);
   expect(Buffer.concat(chunks),label).toEqual(readFileSync(join(root,'native.raw')));expect(stamps,label).toEqual(Array.from({length:frames},(_,n)=>BigInt(n)));checked++;
  }
  expect(checked).toBe(36);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native xstack through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-timed-'));let count=0;
 try{
  for(const [format,w,h]of [['gray',5,3],['yuv420p',4,2],['gbrp',5,3],['yuva420p',8,6],['nv21',2,2]] as const){
   const cases=[['[0:v]split=4[a][b][c][d];[a]hflip[x];[x][b][c][d]xstack=grid=2x2[out]',[[w,h]],[3]],['[0:v][1:v][2:v]xstack=inputs=3:layout=0_0|0_h0|w1_h0[out]',[[2*w,h],[w,h+2],[w,h+2]],[3,2,4]],
    ['[1:v][2:v][0:v]xstack=grid=3x1:shortest=1[out]',[[w,h],[w,h],[w,h]],[3,2,4]]] as const;
   for(const [graph,sizes,lengths]of cases){
    const data=cliInputs(format,root,sizes,lengths),files=new Map(data.map((value,index)=>[`/${index}`,value]));
    for(const output of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
     const args=(path:(index:number)=>string)=>[...sizes.flatMap(([width,height],index)=>[...raw(format,width,height),'-i',path(index)]),'-filter_complex',graph,'-map','[out]','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',output];
     const native=execFileSync(ffmpeg,['-v','error',...args(index=>join(root,`${index}.raw`)),'-']),sink=collectingOutput();
     const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...args(index=>`/${index}`),'/out']);const label=`${format}/${graph}/${output}/${scheduler}`;
     expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
    }
   }
  }
  expect(count).toBe(60);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('agrees with native xstack under default threads and single-threaded filtergraphs for every accepted layout',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[8,6],[17,9]] as const){
   const bytes=pixelLayout(format,width,height).bytes;for(const index of [0,1,2,3])writeFileSync(join(root,`${index}.raw`),pattern(bytes*3,index+5));
   for(const options of layouts){
    const step=accepted(options,format,width,height);if(!step)continue;
    const args=[...Array.from({length:step.inputs},(_,index)=>[...raw(format,width,height),'-i',join(root,`${index}.raw`)]).flat(),'-filter_complex',`${Array.from({length:step.inputs},(_,index)=>`[${index}:v]`).join('')}xstack${options?'='+options:''}[out]`,'-map','[out]','-f','rawvideo','-'];
    const threaded=execFileSync(ffmpeg,['-v','error',...args]),single=execFileSync(ffmpeg,['-v','error','-filter_threads','1','-filter_complex_threads','1',...args]);expect(single,`${format}/${width}x${height}/${options}`).toEqual(threaded);expect(threaded.length).toBeGreaterThan(0);count++;
   }
  }
  expect(count).toBe(232);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses fill colours, layout with grid, gaps, overlaps, out-of-plane chroma and native EINVAL layouts before opening any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-reject-'));let count=0;const statuses:Record<string,number>={};
 try{
  const sources:Record<string,readonly [string,number,number]>={g:['gray',8,8],s:['gray',4,4],t:['gray',8,4],y:['yuv420p',5,3]},files=new Map<string,Uint8Array>();
  for(const [name,[format,width,height]]of Object.entries(sources)){const value=pattern(pixelLayout(format,width,height).bytes*2,name.charCodeAt(0));files.set('/'+name,value);writeFileSync(join(root,`${name}.raw`),value);}
  const refusals:readonly (readonly [string,readonly string[],string,string])[]=[
   ['fill-red',['g','g'],'[0:v][1:v]xstack=layout=0_0|w0_0:fill=red[out]','Xstack fill colours are not implemented'],
   ['fill-bogus',['g','g'],'[0:v][1:v]xstack=fill=bogus[out]','Xstack fill colours are not implemented'],
   ['layout-grid',['g','g'],'[0:v][1:v]xstack=layout=0_0|w0_0:grid=2x1[out]','Both layout and grid were specified'],
   ['no-layout',['g','g','g'],'[0:v][1:v][2:v]xstack=inputs=3[out]','No xstack layout or grid specified'],
   ['gap',['g','g'],'[0:v][1:v]xstack=layout=0_0|w0_h0[out]','uncovered'],
   ['gap-mixed',['g','s'],'[0:v][1:v]xstack=layout=0_0|w0_0[out]','uncovered'],
   ['overlap',['g','g'],'[0:v][1:v]xstack=layout=0_0|4_0[out]','overlap in plane 0'],
   ['overwrite',['g'],'[0:v]split=3[a][b][c];[a][b][c]xstack=inputs=3:layout=0_0|w0_0|0_0[out]','overlap in plane 0'],
   ['chroma',['y','y'],'[0:v][1:v]xstack=grid=2x1[out]','exceeds the output plane'],
   ['grid-height',['g','g','t','g'],'[0:v][1:v][2:v][3:v]xstack=grid=2x2[out]',"does not match current row's height"],
   ['grid-width',['g','g','s','s'],'[0:v][1:v][2:v][3:v]xstack=grid=2x2[out]','does not match previous row width'],
   ['self',['g','g'],'[0:v][1:v]xstack=layout=0_0|w1_0[out]','Invalid xstack layout reference w1'],
   ['enable',['g','g'],'[0:v][1:v]xstack=enable=1[out]','Xstack timeline expressions are not implemented'],
   ['eof_action',['g','g'],'[0:v][1:v]xstack=eof_action=pass[out]','Unsupported xstack option'],
   ['repeatlast',['g','g'],'[0:v][1:v]xstack=repeatlast=0[out]','Unsupported xstack option'],
   ['ts_sync_mode',['g','g'],'[0:v][1:v]xstack=ts_sync_mode=nearest[out]','Unsupported xstack option'],
  ];
  for(const [name,inputs,graph,message]of refusals){
   const native=spawnSync(ffmpeg,['-y','-v','error',...inputs.flatMap(input=>[...raw(...sources[input]!),'-i',join(root,`${input}.raw`)]),'-filter_complex',graph,'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});statuses[name]=native.status!;
   for(const [backend,label]of [[media(),'media'],[timed('producer'),'actor'],[timed('pull'),'timed']] as const){
    let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...inputs.flatMap(input=>[...raw(...sources[input]!),'-i','/'+input]),'-filter_complex',graph,'-map','[out]','-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,`${name}/${label}`).not.toBe(0);expect(opened,`${name}/${label}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${name}/${label}`).toContain(message);count++;
   }
  }
  // Native accepts fill strings, gaps (uninitialised bytes), overlaps (racy slice copies) and out-of-plane chroma writes, which are refused here.
  // EINVAL comes from init and config_output as the host reports it; AVERROR_OPTION_NOT_FOUND and AVERROR_PATCHWELCOME are not errno values.
  const einval=256-constants.errno.EINVAL;
  expect(statuses).toEqual({'fill-red':0,'fill-bogus':0,'layout-grid':einval,'no-layout':einval,gap:0,'gap-mixed':0,overlap:0,overwrite:0,chroma:0,'grid-height':einval,'grid-width':einval,self:einval,enable:176,eof_action:8,repeatlast:8,ts_sync_mode:8});
  expect(count).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
const sources=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const;
const graphPaths=(format:string,width:number,height:number,data:Uint8Array)=>{
 const shape={format,width,height},time={num:1n,den:25n},rate={num:25n,den:1n},budget={maxFrameBytes:1<<18,maxStateBytes:1<<22,maxResidentBytes:1<<24},frame=(n:number)=>frameOf(format,width,height,data,n);
 const timedSource=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<2;n++)yield {kind:'frame',frame:frame(n),duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}});
 const store=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
 return {
  async graph(vf:string){const plan=compileVideoFilterGraph(`[0:v]${vf}[o]`).plan(shape,[null],{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),budget)[0]!);},
  async stream(vf:string){const execution=createReplayVideoExecution(`[0:v]${vf}[o]`,[{geometry:shape,timeBase:time,async *open(){for(let n=0;n<2;n++)yield frame(n);}}],[null],{...budget,maxSourceTraversals:16},{arithmetic:'scalar'});
   try{const frames:VideoFrameData[]=[];for await(const value of execution.outputs[0]!.frames)frames.push(value);return frames;}finally{await execution.close();}},
  async actor(vf:string){const actors=createFrameActors(vf,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:budget.maxFrameBytes,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});
   try{for(let n=0;n<2;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:frame(n)});actors.endInput(0,-541478725,2n);const frames:VideoFrameData[]=[];
    for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(-541478725);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
  async timed(vf:string){const frames:VideoFrameData[]=[];await executeTimedGraph(planTimedVideoGraph(vf,[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[timedSource],store,{numericProfile:'linux-x64',maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){frames.push(event.frame);}});return frames;},
 };
};
it('negotiates every source as native does on the join paths',async()=>{
 // tests/helpers/video-negotiation-cases.ts always runs a linear chain, which a join never has; this is its join form on graph, stream, actor and timed.
 // Every source format is in the native list, so native and every path keep the source format; none needs a by-name refusal.
 const root=mkdtempSync(join(tmpdir(),'edge-xstack-negotiation-')),vf='split=3[a][b][c];[a]hflip[x];[x][b][c]xstack=grid=3x1',matched:Record<string,string>={};let checks=0;
 try{
  for(const source of sources){
   const data=pattern(pixelLayout(source,8,6).bytes*2,source.length*131),file=join(root,`${source}.raw`),input=['-f','rawvideo','-pixel_format',source,'-s','8x6','-i',file];writeFileSync(file,data);
   const log=spawnSync(ffmpeg,['-hide_banner','-nostats','-cpuflags','0','-v','info',...input,'-vf',`${vf},showinfo`,'-f','null','-'],{encoding:'utf8'}).stderr,shown=/ fmt:(\S+) /.exec(log)?.[1];expect(shown,source).toBeDefined();
   const expected=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input,'-vf',vf,'-f','rawvideo','-']);
   for(const [path,run]of Object.entries(graphPaths(source,8,6,data))){const output=await run(vf);expect(output.map(frame=>frame.pixelFormat),`${source}/${path}`).toEqual([shown,shown]);expect(Buffer.concat(output.flatMap(frame=>frame.planes)),`${source}/${path}`).toEqual(expected);checks++;}
   matched[source]=shown!;
  }
  expect(matched).toEqual(Object.fromEntries(sources.map(source=>[source,source])));
  expect(checks).toBe(56);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
