import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,videoStoragePixelFormat as storage} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {negotiationSources} from '../helpers/video-negotiation-cases.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
/** The executable members of the native list. */
const formats=['yuv444p','yuv422p','yuva420p','yuv420p','gbrp','gray'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const reference=()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');};
/** Structured ramps, edges and constant runs in even bytes, LCG noise in odd bytes; kind 1 is a constant plane, kind 2 a ramp. */
const pattern=(bytes:number,salt:number,kind=0)=>{let seed=salt*7919+17;return Uint8Array.from({length:bytes},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return kind===1?(salt*41)&255:kind===2?(i*salt*3)&255:i%2?seed>>>24:i%10===0?0:i%10===2?255:i%10===4?128:(i*37+salt*13)&255;});};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<23,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:30000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=<T,>():Store<T>=>{const records=new Map<number,T>();return {async append(index,value){records.set(index,value);},async read(index){if(!records.has(index))throw new Error('Missing spool event');return records.get(index)!;},async discardBefore(index){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>memoryStore(),limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
const decode=(data:Uint8Array,format:string,width:number,height:number,n:number,timeBase=time)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.flatMap((plane,p)=>Array.from({length:plane.height},(_,row)=>frame.planes[p]!.subarray(row*frame.linesizes[p]!,row*frame.linesizes[p]!+plane.rowBytes))));};
/** Split-from-one-source graphs: distinct branches, ties (in == threshold), constant min/max and plane masks. */
const splitGraphs=['split=4[a][b][c][d];[b]hflip[t];[c]vflip[l];[a][t][l][d]threshold','split=4[a][b][c][d];[b]vflip[t];[d]hflip[h];[a][t][c][h]threshold=planes=1','split=4[a][b][c][d];[c]hflip[l];[d]vflip[h];[a][b][l][h]threshold','split=4[a][b][c][d];[a]hflip,vflip[i];[i][b][c][d]threshold=planes=5','split=4[a][b][c][d];[b]hflip[t];[c]vflip[l];[a][t][l][d]threshold=planes=0','split=4[a][b][c][d];[a]vflip[i];[d]hflip[h];[i][b][c][h]threshold=10'] as const;
it('matches native split-from-one-source threshold on the graph path across every executable format, size, tie and plane mask',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-graph-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const bytes=pixelLayout(format,width,height).bytes,input=pattern(bytes*3,width*17+height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of splitGraphs){
    const label=`${format}/${width}x${height}/${description}`,native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',description,'-f','rawvideo','-']);
    const plan=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'}),actual=Buffer.concat([0,1,2].map(n=>tight(plan.apply(decode(input,format,width,height,n),{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!)));
    expect(actual,label).toEqual(native);count++;
   }
  }
  expect(count).toBe(216);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native split-from-one-source threshold CLI rawvideo and framecrc on the media backend graph path, with and without -ss/-t',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-graph-cli-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[8,6]] as const){
   const input=pattern(pixelLayout(format,width,height).bytes*3,width*3+format.length),files=new Map([['/in',input]]);writeFileSync(join(root,'in.raw'),input);
   for(const description of splitGraphs)for(const output of ['rawvideo','framecrc'])for(const trim of [[],['-ss','0.04','-t','0.04']] as const){
    if(output==='rawvideo'&&trim.length)continue;
    const before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`],after=['-filter_complex',`[0:v]${description}[out]`,'-map','[out]',...trim,'-bitexact','-f',output],label=`${format}/${width}x${height}/${description}/${output}/${trim.join(' ')}`;
    const expected=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',join(root,'in.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(216);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
/** Four distinct rawvideo inputs of one format and size; lengths in frames. */
const quad=(root:string,format:string,width:number,height:number,lengths:readonly number[],salt:number)=>{
 const bytes=pixelLayout(format,width,height).bytes,files=new Map<string,Uint8Array>(),native:string[]=[],edge:string[]=[];
 lengths.forEach((length,index)=>{const data=pattern(bytes*length,salt+index*5,index===2&&salt%3===0?1:index===3&&salt%3===1?2:0),name=`in${index}.raw`;writeFileSync(join(root,name),data);files.set('/'+name,data);
  const before=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i'];native.push(...before,join(root,name));edge.push(...before,'/'+name);});
 return {files,native,edge};
};
const lengthCases=[[3,3,3,3],[3,2,3,3],[1,3,3,3],[3,3,3,2],[4,3,2,4]] as const;
it('matches native four-input threshold CLI rawvideo and framecrc on the stream path, ending with the shortest input, with and without -ss/-t',async()=>{
 reference();let count=0;const root=mkdtempSync(join(tmpdir(),'edge-threshold-cli-'));
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['yuv422p',8,6],['yuv444p',2,2],['yuva420p',17,9],['gbrp',1,1]] as const)for(const [index,lengths]of lengthCases.entries()){
   const {files,native,edge}=quad(root,format,width,height,lengths,width*height+index);
   for(const description of ['[0:v][1:v][2:v][3:v]threshold[out]','[0:v]hflip[i];[1:v]vflip[t];[i][t][2:v][3:v]threshold=planes=6[out]'])for(const format2 of ['rawvideo','framecrc'])for(const trim of [[],['-ss','0.04','-t','0.08']] as const){
    const after=['-filter_complex',description,'-map','[out]',...trim,'-bitexact','-f',format2],label=`${format}/${lengths.join(',')}/${description}/${format2}/${trim.join(' ')}`;
    const expected=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...native,...after,'-'],{timeout:10000});
    expect(expected.status,label+expected.stderr).toBe(0);
    const sink=collectingOutput(),result=await frontend(files,media(),()=>sink.output).exec([...edge,...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(240);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native threshold through createReplayVideoExecution with four distinct sources of unequal lengths and split graphs',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-stream-'));let count=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['gbrp',2,2],['yuva420p',8,6]] as const)for(const lengths of lengthCases){
   const bytes=pixelLayout(format,width,height).bytes,inputs=lengths.map((length,index)=>pattern(bytes*length,index*3+width));
   const sources:ReplayVideoSource[]=inputs.map((data,index)=>({geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<lengths[index]!;n++){signal.throwIfAborted();yield decode(data,format,width,height,n);}}};}}));
   for(const graph of ['[0:v][1:v][2:v][3:v]threshold=planes=3[out]','[0:v]split=4[a][b][c][d];[1:v]nullsink;[2:v]nullsink;[d]nullsink;[b]hflip[t];[a][t][c][3:v]threshold[out]']){
    const execution=createReplayVideoExecution(graph,sources,[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:16},{arithmetic:'scalar'}),frames:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){frames.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const nativeInputs=inputs.flatMap((data,index)=>{const file=join(root,`s${index}.raw`);writeFileSync(file,data);return ['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file];});
    const expected=execFileSync(ffmpeg,['-v','error',...nativeInputs,'-filter_complex',graph,'-map','[out]','-f','rawvideo','-']);const label=`${format}/${lengths.join(',')}/${graph}`;
    const shortest=Math.min(...(graph.includes('split')?[lengths[0],lengths[3]]:lengths));
    expect(Buffer.concat(frames),label).toEqual(expected);expect(stamps,label).toEqual(Array.from({length:shortest},(_,n)=>BigInt(n)));count++;
   }
  }
  expect(count).toBe(40);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native threshold through the timed backend on the actor and timed paths in rawvideo and framecrc, with unequal lengths',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-timed-'));let count=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['gbrp',2,2],['yuva420p',17,9]] as const){
   for(const lengths of [[3,3,3,3],[3,2,3,3],[2,3,3,1]] as const){
    const {files,native,edge}=quad(root,format,width,height,lengths,width+height);
    for(const description of ['[0:v][1:v][2:v][3:v]threshold[out]','[0:v][1:v][2:v][3:v]threshold=planes=2,hflip[out]'])for(const output of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
     const after=['-filter_complex',description,'-map','[out]','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',output],label=`${format}/${lengths.join(',')}/${description}/${output}/${scheduler}`;
     const expected=execFileSync(ffmpeg,['-v','error',...native,...after,'-']),sink=collectingOutput();
     const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...edge,...after,'/out']);
     expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed,label).toBe(true);count++;
    }
   }
   const input=pattern(pixelLayout(format,width,height).bytes*3,width*7),files=new Map([['/in',input]]);writeFileSync(join(root,'one.raw'),input);
   for(const description of splitGraphs.slice(0,3))for(const scheduler of ['producer','pull'] as const){
    const before=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-vf',description,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f','framecrc'],label=`${format}/${description}/${scheduler}`;
    const expected=execFileSync(ffmpeg,['-v','error',...before,'-i',join(root,'one.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
   }
  }
  expect(count).toBe(120);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('agrees with native under default threads and -filter_threads 1',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-threads-'));let count=0;
 try{
  for(const format of formats){const file=join(root,'in.raw');writeFileSync(file,pattern(pixelLayout(format,17,9).bytes*3,format.length));
   for(const description of splitGraphs.slice(0,2)){const args=(threads:readonly string[])=>['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s','17x9','-i',file,'-filter_complex',description,'-f','framecrc','-'];
    expect(execFileSync(ffmpeg,args([])),`${format}/${description}`).toEqual(execFileSync(ffmpeg,args(['-filter_threads','1'])));count++;}}
  expect(count).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('refuses size mismatches and unsupported options that native refuses before opening any output on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-reject-'));let count=0;
 try{
  const small=pattern(pixelLayout('gray',4,2).bytes*2,3),big=pattern(pixelLayout('gray',5,3).bytes*2,4),files=new Map([['/a',big],['/b',big],['/c',big],['/d',small]]);writeFileSync(join(root,'a.raw'),big);writeFileSync(join(root,'d.raw'),small);
  const input=(path:string,size:string)=>['-f','rawvideo','-pixel_format','gray','-video_size',size,'-framerate','25','-i',path];
  const mixed=(prefix:string,d:string)=>[...input(prefix+'a'+(prefix?'.raw':''),'5x3'),...input(prefix+'a'+(prefix?'.raw':''),'5x3'),...input(prefix+'a'+(prefix?'.raw':''),'5x3'),...input(prefix+d,'4x2')];
  const cases:readonly (readonly [string,string,readonly string[],ExecutionBackend,number|'any',string])[]=[
   ['size/stream','mixed',['-filter_complex','[0:v][1:v][2:v][3:v]threshold[out]','-map','[out]','-f','rawvideo'],media(),234,'Threshold input sizes differ'],
   ['size/actor','mixed',['-filter_complex','[0:v][1:v][2:v][3:v]threshold[out]','-map','[out]','-c:v','rawvideo','-f','framecrc'],timed('producer'),234,'Threshold input sizes differ'],
   ['size/timed','mixed',['-filter_complex','[0:v][1:v][2:v][3:v]threshold[out]','-map','[out]','-c:v','rawvideo','-f','framecrc'],timed('pull'),234,'Threshold input sizes differ'],
   ['size/graph','one',['-filter_complex','[0:v]split=4[a][b][c][d];[d]scale=4:2[e];[a][b][c][e]threshold[out]','-map','[out]','-f','rawvideo'],media(),234,'Threshold input sizes differ'],
   ['shortest/graph','one',['-filter_complex','[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=shortest=1[out]','-map','[out]','-f','rawvideo'],media(),'any','Unsupported threshold option'],
   ['planes/actor','one',['-filter_complex','[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=planes=16[out]','-map','[out]','-c:v','rawvideo','-f','framecrc'],timed('producer'),'any','Invalid threshold planes'],
   ['shortest/timed','one',['-filter_complex','[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=shortest=0[out]','-map','[out]','-c:v','rawvideo','-f','framecrc'],timed('pull'),'any','Unsupported threshold option'],
   ['linear','one',['-vf','threshold','-f','rawvideo'],media(),'any','Unsupported video filter'],
  ];
  for(const [label,kind,after,backend,status,message]of cases){
   const out=join(root,'out.bin'),native=spawnSync(ffmpeg,['-y','-v','error',...(kind==='mixed'?mixed(root+'/','d.raw'):input(join(root,'a.raw'),'5x3')),...after,out],{timeout:10000});
   if(status==='any')expect(native.status,label).not.toBe(0);else expect(native.status,label+native.stderr).toBe(status);
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...(kind==='mixed'?mixed('/','d'):input('/a','5x3')),...after,'/out']);
   // Native exits with AVERROR(EINVAL) (234) for the size mismatch; filter refusals here surface as execution failures with status 1.
   expect(result.exitCode,label).toBe(1);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message);rmSync(out,{force:true});count++;
  }
  expect(existsSync(join(root,'out.bin'))).toBe(false);expect(count).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
/** Two frames through each join path from one source; every planner runs before the first frame is produced. */
function joinPaths(format:string,width:number,height:number,data:Uint8Array){
 const frame=(n:number)=>decode(data,format,width,height,n),shape={format,width,height},budget={maxFrameBytes:1<<18,maxStateBytes:1<<22,maxResidentBytes:1<<24};
 return {
  async graph(vf:string){const plan=compileVideoFilterGraph(`[0:v]${vf}[o]`).plan(shape,[null],{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),budget)[0]!);},
  async stream(vf:string){const execution=createReplayVideoExecution(`[0:v]${vf}[o]`,[{geometry:shape,timeBase:time,async *open(){for(let n=0;n<2;n++)yield frame(n);}}],[null],{...budget,maxSourceTraversals:16},{arithmetic:'scalar'});
   try{const frames:VideoFrameData[]=[];for await(const value of execution.outputs[0]!.frames)frames.push(value);return frames;}finally{await execution.close();}},
  async actor(vf:string){const actors=createFrameActors(vf,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:budget.maxFrameBytes,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});
   try{for(let n=0;n<2;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:frame(n)});actors.endInput(0,EOF,2n);const frames:VideoFrameData[]=[];
    for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
  async timed(vf:string){const frames:VideoFrameData[]=[],source=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<2;n++)yield {kind:'frame',frame:frame(n),duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}});
   await executeTimedGraph(planTimedVideoGraph(vf,[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[source],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){frames.push(event.frame);}});return frames;},
 };
}
it('negotiates every accepted source as native does and refuses picks without frame storage by name before output on every join path',async()=>{
 // The shared helper also drives linear chains, which a join never flags; this is the same per-source check over the four join paths.
 reference();const root=mkdtempSync(join(tmpdir(),'edge-threshold-negotiation-')),matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 const vf='split=4[a][b][c][d];[b]hflip[t];[c]vflip[l];[a][t][l][d]threshold';
 try{
  for(const source of negotiationSources.filter(source=>storage(source)===source)){
   const data=pattern(pixelLayout(source,8,6).bytes*2,source.length*131),file=join(root,`${source}.raw`),input=['-f','rawvideo','-pixel_format',source,'-s','8x6','-i',file];writeFileSync(file,data);
   const log=spawnSync(ffmpeg,['-hide_banner','-v','info','-cpuflags','0',...input,'-filter_complex',`${vf},showinfo`,'-f','null','-'],{encoding:'utf8'}).stderr,shown=/ fmt:(\S+) /.exec(log)?.[1];expect(shown,source).toBeDefined();
   const execute=joinPaths(source,8,6,data);
   if(executableFormat(shown!)){
    const expected=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input,'-filter_complex',vf,'-f','rawvideo','-']);
    for(const [path,frames]of Object.entries(execute)){const output=await frames(vf);expect(output.map(frame=>frame.pixelFormat),`${source}/${path}`).toEqual([shown,shown]);expect(Buffer.concat(output.map(tight)),`${source}/${path}`).toEqual(expected);checks++;}
    matched[source]=shown!;continue;
   }
   for(const [path,frames]of Object.entries(execute)){await expect(frames(vf),`${source}/${path}`).rejects.toThrow(`negotiates ${shown}, which is not implemented`);checks++;}
   for(const backend of [media(),timed('producer'),timed('pull')]){let opened=0;const result=await frontend(new Map([['/in',data]]),backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format',source,'-video_size','8x6','-i','/in','-filter_complex',`[0:v]${vf}[x]`,'-map','[x]','-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,source).not.toBe(0);expect(opened,source).toBe(0);expect(result.diagnostics.at(-1)?.message,source).toContain(`negotiates ${shown}, which is not implemented`);checks++;}
   refused[source]=shown!;
  }
  expect(refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
  expect(matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp'});
  expect(checks).toBe(68);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
