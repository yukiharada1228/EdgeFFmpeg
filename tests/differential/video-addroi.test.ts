import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const reference=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,scopes:readonly (readonly [readonly string[],readonly string[]])[]=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-t','0.05']]];
/** The spec cases: half-size region with qoffset -1/5, a width clamped past the frame with qoffset 1, clear, chained twice, with hflip, and qoffset 0. */
const chains=['addroi=0:0:iw/2:ih/2:-1/5','addroi=x=iw/4:w=iw*2:qoffset=1','addroi=clear=1','addroi=0:0:iw/2:ih/2,addroi=1:1:iw-1:ih-1:qoffset=1/2:clear=0','addroi=0:0:iw:ih,hflip','addroi=qoffset=0'];
/** The pinned commit and the scalar build, read at test time; the binary itself is never pinned. */
const metadata=()=>{const value=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};expect(value.commit.startsWith('946fcce0')).toBe(true);expect(value.flags).toContain('--disable-x86asm');return value;};
/** Resolves with the exit status; spawn failures, signals and timeouts reject. */
const native=(args:readonly string[],signal:AbortSignal)=>new Promise<{status:number;stdout:Buffer;stderr:string}>((done,fail)=>{execFile(reference,['-hide_banner','-nostdin',...args],{encoding:'buffer',maxBuffer:1<<24,signal,timeout:20000},(error,stdout,stderr)=>{const code=(error as {code?:unknown}|null)?.code;if(error&&typeof code!=='number'){fail(error);return;}done({status:error?code as number:0,stdout,stderr:stderr.toString()});});});
/** Frame 0: ramps; frame 1: LCG noise; frame 2: edges (0/255 columns) over constant planes. */
const pattern=(format:string,width:number,height:number)=>{const layout=pixelLayout(format,width,height),bytes=layout.bytes;let seed=(width*131+height*17+format.length)>>>0;
 return Uint8Array.from({length:bytes*3},(_,i)=>{const frame=Math.floor(i/bytes),offset=i%bytes;if(frame===0)return (offset*7+(offset%width)*29)&255;if(frame===1){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}const plane=layout.planes.findIndex(p=>offset>=p.offset&&offset<p.offset+p.bytes),p=layout.planes[plane]!,column=(offset-p.offset)%p.rowBytes;return plane===0?(column===0||column===p.rowBytes-1?255:column===1?0:16):plane*60+40;});};
const memoryFiles=(files:ReadonlyMap<string,Uint8Array>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>({async openRead(path:string){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset:bigint,length:number){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path:string){return open(path);}});
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:memoryFiles(files,open),backend,budget});
const timedStores=()=>{const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];const storage:TimedVideoBackendOptions['storage']=()=>{const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};return {storage,closed:()=>stores.every(store=>store.closed===1&&store.values.size===0)};};
const timed=(scheduler:TimedVideoScheduler,storage:TimedVideoBackendOptions['storage'])=>createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128,scheduler}});
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>decodeRawVideo({streamIndex:0,data,pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.map((plane,index)=>Buffer.concat(Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));};
const cases=function*(){for(const format of negotiationOrder)for(const [width,height]of sizes)yield {format,width,height};};
it('matches native -vf addroi chains across all 14 formats, six sizes and timing scopes as rawvideo and framecrc',async({signal})=>{
 metadata();const root=mkdtempSync(join(tmpdir(),'edge-addroi-cli-'));let count=0,identities=0;
 try{
  await runBoundedCases(cases(),4,signal,async({format,width,height},caseSignal)=>{
   const input=pattern(format,width,height),file=join(root,`${format}-${width}x${height}.raw`),files=new Map([['/in',input]]);writeFileSync(file,input);
   for(const chain of chains)for(const [inputTime,outputTime]of scopes)for(const muxer of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25',...inputTime],after=['-vf',chain,...outputTime,'-bitexact','-f',muxer],label=`${format}/${width}x${height}/${chain}/${inputTime}/${outputTime}/${muxer}`;
    const expected=await native(['-v','error','-cpuflags','0',...before,'-i',file,...after,'-'],caseSignal);expect(expected.status,label+expected.stderr).toBe(0);
    const sink=collectingOutput(),result=await frontend(files,createMediaBackend({pixelArithmetic:'scalar'}),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);count++;
    // Identity: without hflip the native rawvideo output is the input itself.
    if(!chain.includes('hflip')&&muxer==='rawvideo'&&!inputTime.length&&!outputTime.length){expect(expected.stdout,label).toEqual(Buffer.from(input));identities++;}
   }
  });
  expect([count,identities]).toEqual([14*6*6*3*2,14*6*5]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native -filter_complex split and addroi branches across all 14 formats as rawvideo and framecrc',async({signal})=>{
 metadata();const root=mkdtempSync(join(tmpdir(),'edge-addroi-graph-'));let count=0;
 const graphs=['[0:v]split[a][b];[a]addroi=0:0:iw/2:ih/2:-1/5[left];[b]addroi=clear=1,hflip[right]','[0:v]addroi=x=iw/4:w=iw*2:qoffset=1,split[left][right]','[0:v]split[a][b];[a]addroi,addroi=qoffset=0[left];[b]vflip,addroi=1:1:1:1[right]'];
 try{
  await runBoundedCases(negotiationOrder.flatMap(format=>[[5,3],[17,9]].map(([width,height])=>({format,width:width!,height:height!}))),4,signal,async({format,width,height},caseSignal)=>{
   const input=pattern(format,width,height),dir=mkdtempSync(join(root,'case-')),file=join(dir,'input.raw'),files=new Map([['/in',input]]);writeFileSync(file,input);
   for(const graph of graphs)for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
    const before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...scope,'-bitexact','-f',muxer,prefix+index+'.out']);
    const expected=await native(['-y','-v','error','-cpuflags','0',...before,'-i',file,'-filter_complex',graph,...outputs(dir+'/')],caseSignal);expect(expected.status,expected.stderr).toBe(0);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontend(files,createMediaBackend({pixelArithmetic:'scalar'}),path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',graph,...outputs('/')]);expect(result.exitCode,JSON.stringify({format,graph,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${format}/${width}x${height}/${graph}/${muxer}/${scope}/${index}`).toEqual(readFileSync(join(dir,index+'.out')));}count++;
   }
  });
  expect(count).toBe(14*2*3*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed addroi graphs frame by frame across all 14 formats and six sizes',async({signal})=>{
 metadata();const root=mkdtempSync(join(tmpdir(),'edge-addroi-stream-'));let count=0;
 try{
  await runBoundedCases(cases(),4,signal,async({format,width,height},caseSignal)=>{
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height),file=join(root,`${format}-${width}x${height}.raw`);writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(sourceSignal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){sourceSignal.throwIfAborted();yield decode(input.slice(index*frameBytes,(index+1)*frameBytes),format,width,height,index);}}};}};
   for(const graph of ['[in]addroi=0:0:iw/2:ih/2:-1/5[out]','[in]addroi=x=iw/4:w=iw*2:qoffset=1,hflip[out]','[in]split[x][y];[x]addroi=clear=1[l];[y]addroi,nullsink;[l]addroi=qoffset=0[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const expected=await native(['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-'],caseSignal);expect(expected.status,expected.stderr).toBe(0);
    expect(Buffer.concat(chunks),`${format}/${width}x${height}/${graph}`).toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);if(!graph.includes('hflip'))expect(expected.stdout).toEqual(Buffer.from(input));count++;
   }
  });
  expect(count).toBe(14*6*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native addroi through activation actors and the timed backend producer and pull schedulers as rawvideo and framecrc',async({signal})=>{
 metadata();const root=mkdtempSync(join(tmpdir(),'edge-addroi-timed-'));let actorCount=0,timedCount=0;
 try{
  await runBoundedCases(negotiationOrder.flatMap(format=>[[1,1],[5,3],[17,9]].map(([width,height])=>({format,width:width!,height:height!}))),4,signal,async({format,width,height},caseSignal)=>{
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(format,width,height),file=join(root,`${format}-${width}x${height}.raw`),files=new Map([['/in',input]]);writeFileSync(file,input);
   for(const chain of ['addroi=0:0:iw/2:ih/2:-1/5','addroi=x=iw/4:w=iw*2:qoffset=1,hflip','addroi=clear=1,addroi=qoffset=0']){
    const expected=await native(['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',chain,'-f','rawvideo','-'],caseSignal);expect(expected.status,expected.stderr).toBe(0);
    const actors=createFrameActors(chain,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:{format,width,height}}]}),chunks:Buffer[]=[];
    try{for(let index=0;index<3;index++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input.slice(index*frameBytes,(index+1)*frameBytes),format,width,height,index)});actors.endInput(0,EOF,3n);
     for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${format}/${width}x${height}/${chain}`).toEqual(expected.stdout);actorCount++;
    for(const scheduler of ['producer','pull'] as const)for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
     const args=['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','/in','-vf',chain,...scope,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,'/out'],label=`timed ${scheduler} ${format}/${width}x${height}/${chain}/${muxer}/${scope}`;
     const reference=await native(['-v','error','-cpuflags','0',...args.slice(1,-1).map(value=>value==='/in'?file:value),'-'],caseSignal),sink=collectingOutput(),stores=timedStores(),result=await frontend(files,timed(scheduler,stores.storage),()=>sink.output).exec(args);
     expect(reference.status,label+reference.stderr).toBe(0);expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(sink.committed).toBe(true);expect(stores.closed()).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(reference.stdout);timedCount++;
    }
   }
  });
  expect([actorCount,timedCount]).toEqual([14*3*3,14*3*3*2*2*2]);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses addroi options before opening any output with native statuses, and refuses the natively accepted unproven forms',async({signal})=>{
 metadata();const root=mkdtempSync(join(tmpdir(),'edge-addroi-reject-'));let count=0;
 // AVERROR(e) exits with (-e) & 255 on the reference host's errno table; the tag errors are host-independent.
 const status=(errno:number)=>(256-errno)&255,erange=status(constants.errno.ERANGE),einval=status(constants.errno.EINVAL),patchWelcome=176,optionNotFound=8;
 const cases:readonly (readonly [string,number])[]=[['addroi=qoffset=2',erange],['addroi=qoffset=-3/2',erange],['addroi=qoffset=1/0',erange],['addroi=x=iw/',einval],['addroi=w=',einval],['addroi=h=bogus',einval],['addroi=qoffset=abc',einval],['addroi=qoffset=0/0',einval],['addroi=qoffset=nan',einval],['addroi=clear=auto',einval],['addroi=clear=2',einval],['addroi=enable=1',patchWelcome],['addroi=foo=1',optionNotFound],
  // Accepted natively, refused here: the generic threads option and expressions outside the NaN-free subset (0/0 makes native cast NaN to int).
  ['addroi=threads=1',0],['addroi=x=0/0',0],['addroi=w=sin(1)',0],['addroi=y=iw/(ih-1)',0],['addroi=x=1/(iw-2)',0],['addroi=h=hypot(iw\\,ih)',0]];
 try{
  const input=pattern('gray',5,3),file=join(root,'input.raw'),files=new Map([['/in',input]]);writeFileSync(file,input);
  for(const [filter,expectedStatus]of cases)for(const complex of [false,true]){
   const before=['-f','rawvideo','-pixel_format','gray','-s','5x3','-framerate','25'],after=complex?['-filter_complex',`[0:v]split[a][b];[a]${filter}[left];[b]null[right]`,'-map','[left]','-f','rawvideo','OUT0','-map','[right]','-f','rawvideo','OUT1']:['-vf',`null,${filter}`,'-f','rawvideo','OUT0'];
   const expected=await native(['-y','-v','error',...before,'-i',file,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],signal);expect(expected.status,`${filter} ${expected.stderr}`).toBe(expectedStatus);
   for(const name of ['OUT0','OUT1']){expect(existsSync(join(root,name)),filter).toBe(expectedStatus===0&&(name==='OUT0'||complex));rmSync(join(root,name),{force:true});}
   for(const backend of ['media','producer','pull'] as const){
    let opened=0;const open=()=>{opened++;return collectingOutput().output;},stores=timedStores(),engine=backend==='media'?createMediaBackend({pixelArithmetic:'scalar'}):timed(backend,stores.storage);
    const result=await frontend(files,engine,open).exec(['-y',...before,'-i','/in',...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);expect(result.exitCode,`${backend} ${filter}`).not.toBe(0);expect(opened,`${backend} ${filter}`).toBe(0);count++;
   }
  }
  expect(count).toBe(cases.length*2*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does with addroi on every path',async({signal})=>{
 metadata();const outcome=await nativeNegotiationOutcome('addroi=0:0:iw/2:ih/2:-1/5',negotiationSources,signal);
 expect(outcome.refused).toEqual({});
 expect(outcome.matched).toEqual(Object.fromEntries(negotiationSources.map(source=>[source,source])));
 expect(outcome.checks).toBe(14*5+3);
},120000);
