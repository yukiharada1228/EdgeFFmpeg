import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,ops=['maskedmin','maskedmax'] as const;
/** The sandbox reference: the pinned commit built without x86 assembly. The binary hash is not pinned. */
function reference(){const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');}
/** AVERROR(e) exits with (-e) & 255 on the reference host. */
const errnoStatus=(name:'EINVAL'|'ERANGE')=>(256-constants.errno[name]!)&255,optionNotFound=8;
const lcg=(seed:number)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
/** Source, filter1 and filter2 bytes mixing ramps, LCG noise, 0/255 extremes, exact ties (|s-f1| == |s-f2| with f1 != f2), equal filters and, when constant, flat planes. */
function triple(bytes:number,salt:number,constant=false):[Uint8Array,Uint8Array,Uint8Array]{
 const next=lcg(salt*7919+bytes),s=new Uint8Array(bytes),a=new Uint8Array(bytes),b=new Uint8Array(bytes);
 for(let i=0;i<bytes;i++){
  if(constant){s[i]=100+salt%3;a[i]=90;b[i]=salt%2?110+salt%3:105;continue;}
  const kind=i%6;s[i]=kind===0?(i*37+salt*13)&255:next();a[i]=next();b[i]=next();
  if(kind===2){s[i]=i%4?255:0;a[i]=i%3?0:255;}
  else if(kind===3){const twice=2*s[i]!-a[i]!;if(twice>=0&&twice<=255)b[i]=twice;else{a[i]=s[i]!>>1;b[i]=s[i]!+(s[i]!>>1);if(b[i]!>255)b[i]=s[i]!;}}
  else if(kind===4)b[i]=a[i]!;
  else if(kind===5)a[i]=s[i]!;
 }
 return [s,a,b];
}
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
/** Runs one command natively (@name files in root, - for stdout) and through EdgeFFmpeg (/name files, /out), with -cpuflags 0 natively and scalar arithmetic here. */
async function both(root:string,files:ReadonlyMap<string,Uint8Array>,args:readonly string[],backend:ExecutionBackend,label:string,threads:readonly string[]=[]){
 const native=spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0',...threads,...args.map(value=>value.startsWith('@')?join(root,value.slice(1)):value)],{timeout:20000,maxBuffer:1<<24});expect(native.error,label).toBeUndefined();expect(native.status,label+native.stderr.toString()).toBe(0);
 const sink=collectingOutput(),result=await frontend(files,backend,()=>sink.output).exec(['-y',...args.map(value=>value.startsWith('@')?'/'+value.slice(1):value==='-'?'/out':value)]);
 expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(native.stdout);return native.stdout;
}
const raw=(format:string,width:number,height:number,path:string,extra:readonly string[]=[])=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...extra,'-i',path];
function stage(root:string,format:string,width:number,height:number,frames:readonly number[],salt:number,constant=false){
 const bytes=pixelLayout(format,width,height).bytes,files=new Map<string,Uint8Array>(),[s,a,b]=triple(bytes*Math.max(...frames),salt,constant);
 for(const [index,data]of [s,a,b].entries()){const value=data.subarray(0,bytes*frames[index]!);files.set(`/in${index}`,value);writeFileSync(join(root,`in${index}`),value);}return files;
}
it('matches native maskedmin and maskedmax on three distinct inputs across formats, sizes, plane masks and ties',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-inputs-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const constant of [false,true]){
   const files=stage(root,format,width,height,[3,3,3],width*height+format.length,constant);
   for(const op of ops)for(const planes of constant?[null]:[null,0,1,6,15]){
    const description=`[0:v][1:v][2:v]${op}${planes===null?'':`=${planes}`}[out]`,muxer=(width+height+(planes??3))%2?'framecrc':'rawvideo';
    await both(root,files,[...[0,1,2].flatMap(index=>raw(format,width,height,`@in${index}`)),'-filter_complex',description,'-map','[out]','-bitexact','-f',muxer,'-'],media(),`${format}/${width}x${height}/${constant}/${description}/${muxer}`);count++;
   }
  }
  expect(count).toBe(6*6*(2*5+2));
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskedmin and maskedmax split=3 graphs on the graph path, with implicit conversions, -ss/-t and both thread settings',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-graph-'));let count=0;
 try{
  for(const [source,width,height]of [['gray',5,3],['yuv420p',7,5],['yuv422p',8,6],['yuv444p',2,2],['yuva420p',17,9],['gbrp',5,3],['nv12',8,6],['rgb24',7,5],['nv21',1,1]] as const){
   const bytes=pixelLayout(source,width,height).bytes,[input]=triple(bytes*3,width*7+height),files=new Map([['/in',input]]);writeFileSync(join(root,'in'),input);
   for(const graph of ['[0:v]split=3[a][b][c];[a][b][c]maskedmin[out]','[0:v]split=3[a][b][c];[a]hflip[x];[b]vflip[y];[x][y][c]maskedmax=planes=5[out]','[0:v]split=3[a][b][c];[a]vflip[x];[c]hflip,vflip[z];[x][b][z]maskedmin=planes=10,split[out][unused];[unused]nullsink'])
    for(const time of [[],['-ss','0.04','-t','0.05']])for(const muxer of ['rawvideo','framecrc']){
     const label=`${source}/${graph}/${time}/${muxer}`,args=[...raw(source,width,height,'@in'),'-filter_complex',graph,'-map','[out]',...time,'-bitexact','-f',muxer,'-'];
     const expected=await both(root,files,args,media(),label);
     const single=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-filter_threads','1',...args.map(value=>value==='@in'?join(root,'in'):value)],{timeout:20000});expect(single.status,label).toBe(0);expect(single.stdout,label+'/threads').toEqual(expected);count++;
    }
  }
  expect(count).toBe(9*3*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskedmin and maskedmax on the stream path through replay execution and unequal-length multi-input CLI runs',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-stream-'));let count=0;
 try{
  for(const [format,width,height]of [['yuv420p',7,5],['gbrp',5,3],['yuva420p',8,6],['gray',17,9]] as const){
   const bytes=pixelLayout(format,width,height).bytes,files=stage(root,format,width,height,[3,3,3],bytes);
   const replay=(index:number):ReplayVideoSource=>({geometry:{format,width,height},timeBase:{num:1n,den:25n},open(signal){const data=files.get(`/in${index}`)!;return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:data.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});}}};}});
   for(const [graph,sources]of [['[in]split=3[a][b][c];[a]hflip[x];[x][b][c]maskedmin[out]',1],['[i0][i1][i2]maskedmax=planes=3[out]',3],['[i0][i1][i2]maskedmin,hflip[out]',3]] as const){
    const execution=createReplayVideoExecution(graph,Array.from({length:sources},(_,index)=>replay(index)),[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:8},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    let nativeGraph=graph.replace('[in]','[0:v]');for(let index=0;index<3;index++)nativeGraph=nativeGraph.replace(`[i${index}]`,`[${index}:v]`);
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...Array.from({length:sources},(_,index)=>raw(format,width,height,join(root,`in${index}`))).flat(),'-filter_complex',nativeGraph,'-map','[out]','-f','rawvideo','-'],{timeout:20000});
    expect(native.status,graph).toBe(0);expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(native.stdout);expect(stamps).toEqual([0n,1n,2n]);count++;
   }
   // Unequal lengths: every input is sync=1 with EXT_INFINITY after, so ended inputs repeat their last frame until the longest one ends.
   for(const lengths of [[3,2,4],[1,3,2],[4,4,1]])for(const muxer of ['rawvideo','framecrc']){
    const unequal=stage(root,format,width,height,lengths,lengths[0]!*5+lengths[2]!);
    await both(root,unequal,[...[0,1,2].flatMap(index=>raw(format,width,height,`@in${index}`)),'-filter_complex','[0:v][1:v][2:v]maskedmax[out]','-map','[out]','-bitexact','-f',muxer,'-'],media(),`${format}/${lengths}/${muxer}`);count++;
   }
  }
  expect(count).toBe(4*(3+6));
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskedmin and maskedmax through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-timed-'));let count=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['gbrp',8,6],['yuva420p',2,2]] as const){
   const files=stage(root,format,width,height,[3,2,4],width+height),after=['-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact'];
   for(const scheduler of ['producer','pull'] as const)for(const muxer of ['rawvideo','framecrc']){
    for(const graph of ['[0:v]split=3[a][b][c];[a]hflip[x];[b]vflip[y];[x][y][c]maskedmin=planes=7[out]','[0:v]split=3[a][b][c];[a][b][c]maskedmax[out]'])for(const time of [[],['-ss','0.04','-t','0.05']]){
     await both(root,files,[...raw(format,width,height,'@in0'),'-filter_complex',graph,'-map','[out]',...time,...after,'-f',muxer,'-'],timed(scheduler),`${format}/${scheduler}/${graph}/${time}/${muxer}`);count++;
    }
    for(const op of ops){await both(root,files,[...[0,1,2].flatMap(index=>raw(format,width,height,`@in${index}`)),'-filter_complex',`[0:v][1:v][2:v]${op}=planes=13[out]`,'-map','[out]',...after,'-f',muxer,'-'],timed(scheduler),`${format}/${scheduler}/${op}/3in/${muxer}`);count++;}
   }
  }
  expect(count).toBe(4*2*2*(4+2));
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses maskedmin and maskedmax size mismatches, framesync options, out-of-range planes and enable= before opening any output on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-reject-'));let count=0;
 try{
  const files=stage(root,'gray',5,3,[2,2,2],9),small=triple(pixelLayout('gray',4,3).bytes*2,3)[0];files.set('/small',small);writeFileSync(join(root,'small'),small);
  const three=[...raw('gray',5,3,'@in0'),...raw('gray',5,3,'@in1'),...raw('gray',4,3,'@small')],one=raw('gray',5,3,'@in0');
  const cases:readonly (readonly [string,readonly string[],number|null,string])[]=[
   ['size/split',[...one,'-filter_complex','[0:v]split=3[a][b][c];[c]scale=4:3[z];[a][b][z]maskedmin[out]'],errnoStatus('EINVAL'),'maskedmin input sizes differ'],
   ['size/inputs',[...three,'-filter_complex','[0:v][1:v][2:v]maskedmax[out]'],errnoStatus('EINVAL'),'maskedmax input sizes differ'],
   ['size/first',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a]transpose[x];[x][b][c]maskedmin[out]'],errnoStatus('EINVAL'),'maskedmin input sizes differ'],
   ['shortest',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmin=shortest=1[out]'],optionNotFound,'Unsupported maskedmin option'],
   ['eof_action',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmax=eof_action=endall[out]'],optionNotFound,'Unsupported maskedmax option'],
   ['repeatlast',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmin=repeatlast=0[out]'],optionNotFound,'Unsupported maskedmin option'],
   ['ts_sync_mode',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmax=ts_sync_mode=nearest[out]'],optionNotFound,'Unsupported maskedmax option'],
   ['planes',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmin=16[out]'],errnoStatus('ERANGE'),'Invalid maskedmin planes'],
   ['planes/negative',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmax=planes=-1[out]'],errnoStatus('ERANGE'),'Invalid maskedmax planes'],
   // Native supports the generic timeline; it is refused explicitly here.
   ['enable',[...one,'-filter_complex','[0:v]split=3[a][b][c];[a][b][c]maskedmin=enable=gte(t\\,0.04)[out]'],0,'maskedmin timeline expressions are not implemented'],
  ];
  for(const [label,args,status,message]of cases)for(const [path,backend]of [['graph/stream',media()],['actor',timed('producer')],['timed',timed('pull')]] as const){
   const full=[...args,'-map','[out]','-c:v','rawvideo','-f','rawvideo'],native=spawnSync(ffmpeg,['-y','-v','error',...full.map(value=>value.startsWith('@')?join(root,value.slice(1)):value),join(root,'out.raw')],{timeout:20000});
   // Native opens its output before config_output fails; EdgeFFmpeg refuses before opening any.
   expect(native.status,label).toBe(status);if(!status)expect(existsSync(join(root,'out.raw')),label).toBe(true);rmSync(join(root,'out.raw'),{force:true});
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...full.map(value=>value.startsWith('@')?'/'+value.slice(1):value),'/out']);
   expect(result.exitCode,`${label}/${path}`).not.toBe(0);expect(opened,`${label}/${path}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${label}/${path}`).toContain(message);count++;
  }
  expect(count).toBe(30);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Join counterpart of tests/helpers/video-negotiation-cases.ts, whose linear path a join cannot take: native's pick on the maskedmin link (showinfo) from each executable source,
 * then byte equality on graph (single-input -filter_complex), stream (three-input CLI), actor (timed producer) and timed (timed pull), or the named plan-time refusal with no output opened. */
it('negotiates every executable source as native does and refuses the packed-alpha gbrap picks before output on every join path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedminmax-negotiation-')),matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 try{
  for(const source of ['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const){
   const bytes=pixelLayout(source,8,6).bytes,[input]=triple(bytes*2,source.length*131),files=new Map([['/in0',input],['/in1',input],['/in2',input]]);for(const name of ['in0','in1','in2'])writeFileSync(join(root,name),input);
   const graph='[0:v]split=3[a][b][c];[a]hflip[x];[b]vflip[y];[x][y][c]maskedmin[out]',multi='[0:v]hflip[x];[1:v]vflip[y];[x][y][2:v]maskedmin[out]';
   const log=spawnSync(ffmpeg,['-v','info','-cpuflags','0',...raw(source,8,6,join(root,'in0')),'-filter_complex',graph.replace('[out]',',showinfo[out]'),'-map','[out]','-f','null','-'],{timeout:20000}).stderr.toString(),shown=/ fmt:(\S+) /.exec(log)?.[1];if(!shown)throw new Error('showinfo printed no format for '+source);
   const runs=[['graph',media(),raw(source,8,6,'@in0'),graph],['stream',media(),[0,1,2].flatMap(index=>raw(source,8,6,`@in${index}`)),multi],['actor',timed('producer'),raw(source,8,6,'@in0'),graph],['timed',timed('pull'),raw(source,8,6,'@in0'),graph]] as const;
   const after=['-map','[out]','-fps_mode','passthrough','-c:v','rawvideo','-bitexact','-f','rawvideo','-'];
   if(['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp'].includes(shown)){
    for(const [path,backend,inputs,description]of runs){await both(root,files,[...inputs,'-filter_complex',description,...after],backend,`${source}/${path}`);checks++;}matched[source]=shown;continue;
   }
   for(const [path,backend,inputs,description]of runs){
    let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...inputs.map(value=>value.startsWith('@')?'/'+value.slice(1):value),'-filter_complex',description,...after.slice(0,-1),'/out']);
    expect(result.exitCode,`${source}/${path}`).not.toBe(0);expect(opened,`${source}/${path}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${source}/${path}`).toContain(`negotiates ${shown}, which is not implemented`);checks++;
   }
   refused[source]=shown;
  }
  expect(refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
  expect(matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp'});
  expect(checks).toBe(14*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
