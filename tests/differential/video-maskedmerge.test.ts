import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
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
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
/** Structured ramps and extremes in even bytes, LCG noise in odd bytes. */
const pattern=(bytes:number,salt:number)=>{let seed=salt*7919+17;return Uint8Array.from({length:bytes},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%2?seed>>>24:i%10===0?0:i%10===2?255:(i*37+salt*13)&255;});};
/** Constant 0, 128 and 255 masks, a ramp, a ramp with hard edges, and noise. */
const masks:Readonly<Record<string,(bytes:number)=>Uint8Array>>={zero:bytes=>new Uint8Array(bytes),half:bytes=>new Uint8Array(bytes).fill(128),full:bytes=>new Uint8Array(bytes).fill(255),ramp:bytes=>Uint8Array.from({length:bytes},(_,i)=>(i*29)&255),edges:bytes=>Uint8Array.from({length:bytes},(_,i)=>i%3===0?0:i%3===1?255:(i*7)&255),noise:bytes=>pattern(bytes,991)};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frameOf=(format:string,width:number,height:number,data:Uint8Array,index:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const raw=(format:string,width:number,height:number)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'];
it('runs against the sandbox reference built from commit 946fcce0 with --disable-x86asm',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(existsSync(ffmpeg)).toBe(true);
});
it('matches native maskedmerge rawvideo across formats, sizes, masks and planes 1, 7 and 15 on the graph path',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-kernel-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const [kind,mask]of Object.entries(masks)){
   const bytes=pixelLayout(format,width,height).bytes,data=[pattern(bytes*3,width*height+3),pattern(bytes*3,width+height*17),mask(bytes*3)];
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const planes=[1,7,15],graph=['[0:v]split=3[b0][b1][b2]','[1:v]split=3[o0][o1][o2]','[2:v]split=3[m0][m1][m2]',...planes.map((p,i)=>`[b${i}][o${i}][m${i}]maskedmerge=planes=${p}[x${i}]`)].join(';');
   execFileSync(ffmpeg,['-y','-v','error',...[0,1,2].flatMap(index=>[...raw(format,width,height),'-i',join(root,`${index}.raw`)]),'-filter_complex',graph,...planes.flatMap((_,i)=>['-map',`[x${i}]`,'-f','rawvideo',join(root,`out${i}.raw`)])]);
   for(const [i,p]of planes.entries()){
    const compiled=compileMultiInputVideoFilterGraph(`[b][o][m]maskedmerge=planes=${p}[out]`),order=compiled.graph.inputs.map(pad=>'bom'.indexOf(pad.label!)),plan=compiled.plan(order.map(()=>({format,width,height})),[null],{arithmetic:'scalar'});
    const chunks=[0,1,2].flatMap(n=>{const frames=order.map(source=>frameOf(format,width,height,data[source]!,n)),before=frames.map(frame=>Buffer.concat(frame.planes)),output=plan.applyBatch(frames,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes,maxResidentBytes:1<<20});expect(frames.map(frame=>Buffer.concat(frame.planes))).toEqual(before);expect(output[0]!.pts!.value).toBe(BigInt(n));return output[0]!.planes;});
    expect(Buffer.concat(chunks),`${format}/${width}x${height}/${kind}/${p}`).toEqual(readFileSync(join(root,`out${i}.raw`)));count++;
   }
  }
  expect(count).toBe(648);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskedmerge CLI rawvideo and framecrc on the graph and stream paths, with -ss, -t and unequal lengths',async()=>{
 let count=0;const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-cli-'));
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['yuv422p',8,6],['yuv444p',2,2],['yuva420p',17,9],['gbrp',1,1]] as const){
   const bytes=pixelLayout(format,width,height).bytes,lengths=[3,2,4],data=lengths.map((frames,index)=>index===2?masks.ramp!(bytes*frames):pattern(bytes*frames,index*101+width)),files=new Map(data.map((value,index)=>[`/${index}`,value]));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const cases:readonly (readonly [string,readonly string[],readonly string[],number])[]=[
    ['split',[],['-filter_complex','[0:v]split=3[a][b][c];[a]hflip[x];[c]vflip[z];[x][b][z]maskedmerge=planes=7[out]','-map','[out]'],1],
    ['split-ss',['-ss','0.04'],['-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmerge,negate[out]','-map','[out]','-t','0.04'],1],
    ['three',[],['-filter_complex','[0:v][1:v][2:v]maskedmerge[out]','-map','[out]'],3],
    ['three-planes',[],['-filter_complex','[2:v][0:v][1:v]maskedmerge=planes=1[out]','-map','[out]','-t','0.08'],3],
    ['three-ss',['-ss','0.04'],['-filter_complex','[0:v][1:v][2:v]maskedmerge=planes=15[out]','-map','[out]'],3],
   ];
   for(const [name,before,after,inputs]of cases)for(const output of ['rawvideo','framecrc']){
    const args=(path:(index:number)=>string)=>[...Array.from({length:inputs},(_,index)=>[...before,...raw(format,width,height),'-i',path(index)]).flat(),...after,'-bitexact','-f',output];
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...args(index=>join(root,`${index}.raw`)),'-']),sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...args(index=>`/${index}`),'/out']);const label=`${format}/${name}/${output}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(native.length,label).toBeGreaterThan(0);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(60);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native maskedmerge on the stream path through replay execution with three distinct sources of unequal length',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-stream-'));let checked=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuva420p',6,4],['gbrp',7,5]] as const)for(const lengths of [[3,3,3],[3,1,2],[1,3,2]] as const)for(const planes of [1,7,15]){
   const bytes=pixelLayout(format,width,height).bytes,data=lengths.map((frames,index)=>index===2?masks.edges!(bytes*frames):pattern(bytes*frames,index*37+planes));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const source=(index:number):ReplayVideoSource=>({geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<lengths[index]!;n++){signal.throwIfAborted();yield frameOf(format,width,height,data[index]!,n);}}};}});
   const graph=`[b][o][m]maskedmerge=planes=${planes}[out]`,order=compileMultiInputVideoFilterGraph(graph).graph.inputs.map(pad=>'bom'.indexOf(pad.label!));
   const execution=createReplayVideoExecution(graph,order.map(source),[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:8},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
   try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
   execFileSync(ffmpeg,['-y','-v','error',...[0,1,2].flatMap(index=>[...raw(format,width,height),'-i',join(root,`${index}.raw`)]),'-filter_complex',graph.replace('[b][o][m]','[0:v][1:v][2:v]'),'-map','[out]','-fps_mode','passthrough','-f','rawvideo',join(root,'native.raw')]);
   const label=`${format}/${lengths}/${planes}`;expect(Buffer.concat(chunks),label).toEqual(readFileSync(join(root,'native.raw')));expect(stamps,label).toEqual(Array.from({length:Math.max(...lengths)},(_,n)=>BigInt(n)));checked++;
  }
  expect(checked).toBe(27);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native maskedmerge through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-timed-'));let count=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',6,4],['gbrp',5,3],['yuva420p',7,5]] as const){
   const bytes=pixelLayout(format,width,height).bytes,lengths=[3,2,4],data=lengths.map((frames,index)=>index===2?masks.noise!(bytes*frames):pattern(bytes*frames,index*53+width)),files=new Map(data.map((value,index)=>[`/${index}`,value]));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   for(const [graph,inputs]of [['[0:v]split=3[a][b][c];[a]hflip[x];[x][b][c]maskedmerge=planes=5[out]',1],['[0:v][1:v][2:v]maskedmerge[out]',3],['[1:v][2:v][0:v]maskedmerge=planes=2[out]',3]] as const)for(const format_ of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
    const args=(path:(index:number)=>string)=>[...Array.from({length:inputs},(_,index)=>[...raw(format,width,height),'-i',path(index)]).flat(),'-filter_complex',graph,'-map','[out]','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format_];
    const native=execFileSync(ffmpeg,['-v','error',...args(index=>join(root,`${index}.raw`)),'-']),sink=collectingOutput();
    const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...args(index=>`/${index}`),'/out']);const label=`${format}/${graph}/${format_}/${scheduler}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('agrees with native maskedmerge under default threads and -filter_threads 1',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-threads-'));let count=0;
 try{
  for(const format of formats){
   const bytes=pixelLayout(format,17,9).bytes;for(const index of [0,1,2])writeFileSync(join(root,`${index}.raw`),index===2?masks.ramp!(bytes*3):pattern(bytes*3,index+5));
   const args=[...[0,1,2].flatMap(index=>[...raw(format,17,9),'-i',join(root,`${index}.raw`)]),'-filter_complex','[0:v][1:v][2:v]maskedmerge=planes=7[out]','-map','[out]','-f','rawvideo','-'];
   const threaded=execFileSync(ffmpeg,['-v','error',...args]),single=execFileSync(ffmpeg,['-v','error','-filter_threads','1',...args]);expect(single,format).toEqual(threaded);expect(threaded.length).toBe(bytes*3);count++;
  }
  expect(count).toBe(6);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('fails like native for maskedmerge size mismatches and refused options before opening any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-reject-'));let count=0;const statuses:Record<string,number>={};
 try{
  const input=pattern(pixelLayout('gray',8,8).bytes*2,1),small=pattern(pixelLayout('gray',4,4).bytes*2,2),files=new Map([['/a',input],['/b',input],['/s',small]]);
  writeFileSync(join(root,'a.raw'),input);writeFileSync(join(root,'b.raw'),input);writeFileSync(join(root,'s.raw'),small);
  const source=(name:string,path:string)=>[...raw('gray',name==='s'?4:8,name==='s'?4:8),'-i',path];
  const refusals:readonly (readonly [string,readonly string[],string,string])[]=[
   ['size-split',['a'],'[0:v]split=3[a][b][c];[c]scale=4:4[d];[a][b][d]maskedmerge[out]','Maskedmerge input sizes differ'],
   ['size-inputs',['a','s','b'],'[0:v][1:v][2:v]maskedmerge[out]','Maskedmerge input sizes differ'],
   ['shortest',['a','b','b'],'[0:v][1:v][2:v]maskedmerge=shortest=1[out]','Unsupported maskedmerge option'],
   ['eof_action',['a','b','b'],'[0:v][1:v][2:v]maskedmerge=eof_action=pass[out]','Unsupported maskedmerge option'],
   ['repeatlast',['a'],'[0:v]split=3[a][b][c];[a][b][c]maskedmerge=repeatlast=0[out]','Unsupported maskedmerge option'],
   ['ts_sync_mode',['a'],'[0:v]split=3[a][b][c];[a][b][c]maskedmerge=ts_sync_mode=nearest[out]','Unsupported maskedmerge option'],
   ['planes',['a'],'[0:v]split=3[a][b][c];[a][b][c]maskedmerge=planes=16[out]','Invalid maskedmerge planes'],
  ];
  for(const [name,inputs,graph,message]of refusals){
   const native=spawnSync(ffmpeg,['-y','-v','error',...inputs.flatMap(input=>source(input,join(root,`${input}.raw`))),'-filter_complex',graph,'-map','[out]','-f','rawvideo',join(root,'native.raw')],{timeout:10000});
   expect(native.status,name).not.toBe(0);statuses[name]=native.status!;
   for(const [backend,label]of [[media(),'media'],[timed('producer'),'actor'],[timed('pull'),'timed']] as const){
    let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...inputs.flatMap(input=>source(input,'/'+input)),'-filter_complex',graph,'-map','[out]','-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,`${name}/${label}`).not.toBe(0);expect(opened,`${name}/${label}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${name}/${label}`).toContain(message);count++;
   }
  }
  // EINVAL from config_output for sizes, AVERROR_OPTION_NOT_FOUND for unknown options, ERANGE for planes, as the host reports them.
  expect(statuses).toEqual({'size-split':234,'size-inputs':234,shortest:8,eof_action:8,repeatlast:8,ts_sync_mode:8,planes:222});
  expect(count).toBe(21);
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
it('negotiates every source as native does on the join paths and refuses picks without storage by name before output',async()=>{
 // tests/helpers/video-negotiation-cases.ts always runs a linear chain, which a join never has; this is its join form on graph, stream, actor and timed.
 const root=mkdtempSync(join(tmpdir(),'edge-maskedmerge-negotiation-')),vf='split=3[a][b][c];[a]hflip[x];[x][b][c]maskedmerge=planes=13',matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 try{
  for(const source of sources){
   const data=pattern(pixelLayout(source,8,6).bytes*2,source.length*131),file=join(root,`${source}.raw`),input=['-f','rawvideo','-pixel_format',source,'-s','8x6','-i',file];writeFileSync(file,data);
   const log=spawnSync(ffmpeg,['-hide_banner','-nostats','-cpuflags','0','-v','info',...input,'-vf',`${vf},showinfo`,'-f','null','-'],{encoding:'utf8'}).stderr,shown=/ fmt:(\S+) /.exec(log)?.[1];expect(shown,source).toBeDefined();
   const execute=graphPaths(source,8,6,data);
   if(['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'].includes(shown!)){
    const expected=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input,'-vf',vf,'-f','rawvideo','-']);
    for(const [path,run]of Object.entries(execute)){const output=await run(vf);expect(output.map(frame=>frame.pixelFormat),`${source}/${path}`).toEqual([shown,shown]);expect(Buffer.concat(output.flatMap(frame=>frame.planes)),`${source}/${path}`).toEqual(expected);checks++;}
    matched[source]=shown!;continue;
   }
   const message=`negotiates ${shown}, which is not implemented`;
   for(const [path,run]of Object.entries(execute)){await expect(run(vf),`${source}/${path}`).rejects.toThrow(message);checks++;}
   for(const backend of [media(),timed('producer'),timed('pull')]){
    let opened=0;const result=await frontend(new Map([['/in',data]]),backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format',source,'-video_size','8x6','-i','/in','-filter_complex',`[0:v]${vf}[x]`,'-map','[x]','-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,source).not.toBe(0);expect(opened,source).toBe(0);expect(result.diagnostics.at(-1)?.message,source).toContain(message);checks++;
   }
   refused[source]=shown!;
  }
  expect(refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
  expect(matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp'});
  expect(checks).toBe(68);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
