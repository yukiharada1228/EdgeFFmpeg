import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {compileVideoFilterGraph,compileMultiInputVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import {negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
const time={num:1n,den:25n},rate={num:25n,den:1n};
/** The sandbox build is accepted by provenance, never by a pinned digest. */
it('runs against the pinned-commit sandbox reference built without x86 assembly',()=>{
 const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(existsSync(ffmpeg)).toBe(true);
});
/** kind 0: LCG noise in both inputs. kind 1: source ramps with 0/255 edges, reference = source + (i%5)-2 clamped, with a
 * constant last plane in the reference. Distinct salts give distinct inputs. */
function pattern(format:string,width:number,height:number,frames:number,kind:number,salt:number):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);let seed=salt*7919+width*131+height*17+format.length;
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let i=0;i<plane.bytes;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const at=f*layout.bytes+plane.offset+i;
  if(kind===0){data[at]=seed>>>24;continue;}
  const ramp=i%9===0?0:i%9===4?255:(i*37+f*11+p*29)&255;
  data[at]=salt%2===0?ramp:p===layout.planes.length-1&&layout.planes.length>1?128:Math.max(0,Math.min(255,ramp+(i%5)-2+(i%13===0?40:0)));
 }
 return data;
}
const frame=(format:string,width:number,height:number,data:Uint8Array,n:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const tight=(value:VideoFrameData)=>{const layout=pixelLayout(value.pixelFormat,value.width,value.height),out=new Uint8Array(layout.bytes);for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)out.set(value.planes[index]!.subarray(y*value.linesizes[index]!,y*value.linesizes[index]!+plane.rowBytes),plane.offset+y*plane.rowBytes);return out;};
const variants=[0,1,255].flatMap(threshold=>(['abs','diff'] as const).flatMap(mode=>[15,1,10,0].map(planes=>`maskedthreshold=threshold=${threshold}:planes=${planes}:mode=${mode}`)));
it('matches native maskedthreshold for every mode, threshold 0/1/255 and plane mask over every format and size on the graph path',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-matrix-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of [0,1]){
   const a=pattern(format,width,height,3,kind,2),b=pattern(format,width,height,3,kind,3),fa=join(root,'a.raw'),fb=join(root,'b.raw');writeFileSync(fa,a);writeFileSync(fb,b);
   const input=(file:string)=>['-f','rawvideo','-framerate','25','-pixel_format',format,'-s',`${width}x${height}`,'-i',file];
   const graph=`[0:v]split=${variants.length}${variants.map((_,i)=>`[s${i}]`).join('')};[1:v]split=${variants.length}${variants.map((_,i)=>`[r${i}]`).join('')};`+variants.map((filter,i)=>`[s${i}][r${i}]${filter}[o${i}]`).join(';');
   execFileSync(ffmpeg,['-y','-v','error','-nostdin',...input(fa),...input(fb),'-filter_complex',graph,...variants.flatMap((_,i)=>['-map',`[o${i}]`,'-f','rawvideo',join(root,`${i}.raw`)])],{timeout:30000});
   for(const [i,filter]of variants.entries()){
    const plan=compileMultiInputVideoFilterGraph(`[0:v][1:v]${filter}[o]`).plan([{format,width,height},{format,width,height}],[null],{arithmetic:'scalar'});
    const outputs=[0,1,2].map(n=>{const sa=frame(format,width,height,a,n),sb=frame(format,width,height,b,n),before=[tight(sa),tight(sb)],[out]=plan.applyBatch([sa,sb],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22});expect([tight(sa),tight(sb)]).toEqual(before);expect(out!.pts).toEqual(sa.pts);return tight(out!);});
    expect(Buffer.concat(outputs),`${format} ${width}x${height} kind${kind} ${filter}`).toEqual(readFileSync(join(root,`${i}.raw`)));compared++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(formats.length*sizes.length*2*variants.length);
},300000);
const base=['-f','rawvideo','-framerate','25'];
const memory=(inputs:Map<string,Uint8Array>)=>{const published=new Map<string,Uint8Array>();let opened=0;const filesystem:VirtualFileSystem={async openRead(path){const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,61));}};},async openWrite(path){opened++;const parts:Uint8Array[]=[];return {async write(chunk){parts.push(chunk.slice());},async commit(){published.set(path,Uint8Array.from(parts.flatMap(part=>[...part])));},async abort(){parts.length=0;}};}};return {filesystem,published,get opened(){return opened;}};};
const budget={maxResidentBytes:1<<24,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(filesystem:VirtualFileSystem)=>new FFmpeg({filesystem,budget,backend:createMediaBackend({pixelArithmetic:'scalar'})});
const timedStore:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timed=(filesystem:VirtualFileSystem,scheduler:'pull'|'producer')=>new FFmpeg({filesystem,budget,backend:createTimedVideoBackend({storage:timedStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}})});
/** stream: media backend multi-input CLI (replay execution); actor: timed producer; timed: timed pull. */
const engines=['stream','actor','timed'] as const;
const engine=(mode:typeof engines[number],filesystem:VirtualFileSystem)=>mode==='stream'?media(filesystem):timed(filesystem,mode==='timed'?'pull':'producer');
const tail=(mode:string,muxer:string)=>[...(mode==='stream'||mode==='graph'?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',muxer];
it('matches native two-input maskedthreshold rawvideo and framecrc with unequal lengths and -ss/-t on the stream, actor and timed CLIs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-cli-'));let compared=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['yuva420p',8,6],['gbrp',2,2],['yuv422p',17,9],['yuv444p',1,1]] as const)for(const [na,nb]of [[3,3],[3,2],[2,3]] as const){
   const a=pattern(format,width,height,na,1,1),b=pattern(format,width,height,nb,0,4),fa=join(root,'a.raw'),fb=join(root,'b.raw');writeFileSync(fa,a);writeFileSync(fb,b);
   const before=[...base,'-pixel_format',format,'-s',`${width}x${height}`];
   for(const filter of ['maskedthreshold','maskedthreshold=threshold=40:mode=diff','maskedthreshold=0:5:abs'])for(const trim of [[],['-ss','0.04'],['-t','0.08']])for(const muxer of ['rawvideo','framecrc'])for(const mode of engines){
    const after=['-filter_complex',`[0:v][1:v]${filter}[o]`,'-map','[o]',...trim,...tail(mode,muxer)],label=`${mode} ${format} ${width}x${height} ${na}/${nb} ${filter} ${trim.join(' ')} ${muxer}`;
    const native=execFileSync(ffmpeg,['-v','error','-nostdin',...before,'-i',fa,...before,'-i',fb,...after,'-'],{timeout:10000});
    const io=memory(new Map([['/a',a],['/b',b]])),result=await engine(mode,io.filesystem).exec([...before,'-i','/a',...before,'-i','/b',...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);compared++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(6*3*3*3*2*3);
},300000);
const splitGraphs=['[0:v]split[a][b];[a][b]maskedthreshold[o]','[0:v]split[a][b];[a]hflip[c];[c][b]maskedthreshold=threshold=40:mode=diff[o]','[0:v]split[a][b];[b]vflip[c];[a][c]maskedthreshold=1:6[o]','[0:v]format=yuv444p,split[a][b];[a]hflip[c];[c][b]maskedthreshold=255:9:diff[o]'];
it('matches native split-from-one-source maskedthreshold graphs, with implicit conversions, on the graph, stream, actor and timed paths',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-split-'));let compared=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',8,6],['nv12',8,6],['rgb24',7,5],['yuva420p',2,2]] as const){
   const input=pattern(format,width,height,3,1,5),file=join(root,'in.raw'),before=[...base,'-pixel_format',format,'-s',`${width}x${height}`];writeFileSync(file,input);
   for(const graph of splitGraphs)for(const muxer of ['rawvideo','framecrc'])for(const mode of ['graph',...engines] as const){
    const stream=mode==='stream',description=stream?`${graph};[1:v]nullsink`:graph,after=['-filter_complex',description,'-map','[o]',...tail(mode,muxer)],label=`${mode} ${format} ${graph} ${muxer}`;
    const native=execFileSync(ffmpeg,['-v','error','-nostdin','-cpuflags','0',...before,'-i',file,...(stream?[...before,'-i',file]:[]),...after,'-'],{timeout:10000});
    const io=memory(new Map([['/in',input]])),result=await (mode==='graph'?media(io.filesystem):engine(mode,io.filesystem)).exec([...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);compared++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(5*splitGraphs.length*2*4);
},300000);
it('matches native maskedthreshold through replay execution, frame actors and the timed executor APIs with distinct inputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-api-'));let checked=0;
 try{
  for(const [format,width,height]of [['gray',5,3],['yuv420p',7,5],['gbrp',8,6]] as const){
   const a=pattern(format,width,height,3,0,6),b=pattern(format,width,height,2,1,7),fa=join(root,'a.raw'),fb=join(root,'b.raw');writeFileSync(fa,a);writeFileSync(fb,b);
   const shape={format,width,height},data=[a,b],counts=[3,2];
   for(const filter of ['maskedthreshold=threshold=1:mode=diff','maskedthreshold=40:3:abs']){
    const native=execFileSync(ffmpeg,['-v','error','-nostdin',...[fa,fb].flatMap(file=>[...base,'-pixel_format',format,'-s',`${width}x${height}`,'-i',file]),'-filter_complex',`[0:v][1:v]${filter}[o]`,'-map','[o]','-f','rawvideo','-']);
    const replay=(index:number):ReplayVideoSource=>({geometry:shape,timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<counts[index]!;n++){signal.throwIfAborted();yield frame(format,width,height,data[index]!,n);}}};}});
    const execution=createReplayVideoExecution(`[0:v][1:v]${filter}[o]`,[replay(0),replay(1)],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),stream:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const value of execution.outputs[0]!.frames){stream.push(tight(value));stamps.push(value.pts!.value*25n*value.pts!.timeBase.num/value.pts!.timeBase.den);}}finally{await execution.close();}
    expect(Buffer.concat(stream),`stream ${format} ${filter}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);checked++;
    const actors=createFrameActors(`[0:v][1:v]${filter}`,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[0,1].map(()=>({timeBase:time,frameRate:rate,geometry:shape}))});
    try{for(const index of [0,1]){for(let n=0;n<counts[index]!;n++)actors.sendFrameInput(index,{kind:'frame',duration:1n,frame:frame(format,width,height,data[index]!,n)});actors.endInput(index,-541478725,BigInt(counts[index]!));}
     const frames:Uint8Array[]=[];for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(-541478725);break;}frames.push(tight(result.event!.frame));}
     expect(Buffer.concat(frames),`actor ${format} ${filter}`).toEqual(native);checked++;}finally{actors.dispose();}
    const store=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){return values.get(index)!;},async discardBefore(){},async close(){values.clear();}};};
    const sources=[0,1].map(index=>()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<counts[index]!;n++)yield {kind:'frame',frame:frame(format,width,height,data[index]!,n),duration:1n};yield {kind:'end',status:'eof',pts:BigInt(counts[index]!),rawPts:BigInt(counts[index]!),inputPts:null,secondaryErrors:[]};}}));
    const timedFrames:Uint8Array[]=[];await executeTimedGraph(planTimedVideoGraph(`[0:v][1:v]${filter}`,[0,1].map(()=>({geometry:shape,timeBase:time,frameRate:rate})),[null]),sources,store,{numericProfile:'linux-x64',maxFrameBytes:1<<16,maxStateBytes:1<<20,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){timedFrames.push(tight(event.frame));}});
    expect(Buffer.concat(timedFrames),`timed ${format} ${filter}`).toEqual(native);checked++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(checked).toBe(18);
},120000);
it('refuses size mismatches, framesync options, enable= and out-of-range options like native before opening any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-reject-'));let count=0;
 try{
  const small=pattern('gray',4,4,2,0,1),large=pattern('gray',5,3,2,0,2),files=new Map([['/a',small],['/b',large]]);writeFileSync(join(root,'a'),small);writeFileSync(join(root,'b'),large);
  const input=(path:string,size:string)=>[...base,'-pixel_format','gray','-s',size,'-i',path];
  const cases=[
   ['two-input sizes','[0:v][1:v]maskedthreshold[o]','do not match the corresponding second input link reference parameters'],
   ['split sizes','[0:v]split[a][b];[a]scale=4:2[c];[c][b]maskedthreshold[o];[1:v]nullsink','do not match the corresponding second input link reference parameters'],
   ['shortest','[0:v][1:v]maskedthreshold=shortest=1[o]','Unsupported maskedthreshold option'],
   ['eof_action','[0:v][1:v]maskedthreshold=eof_action=repeat[o]','Unsupported maskedthreshold option'],
   ['repeatlast','[0:v][1:v]maskedthreshold=repeatlast=0[o]','Unsupported maskedthreshold option'],
   ['mode','[0:v][1:v]maskedthreshold=mode=2[o]','Invalid maskedthreshold mode'],
   ['threshold','[0:v][1:v]maskedthreshold=threshold=65536[o]','Invalid maskedthreshold threshold'],
   ['planes','[0:v][1:v]maskedthreshold=planes=all[o]','Invalid maskedthreshold planes'],
   ['shorthand','[0:v][1:v]maskedthreshold=1:2:abs:4[o]',''],
  ] as const;
  for(const [name,graph,message]of cases){
   const sizes=name==='two-input sizes'?['4x4','5x3']:['5x3','5x3'],paths=name==='two-input sizes'?['a','b']:['b','b'];
   const native=spawnSync(ffmpeg,['-y','-v','error','-nostdin',...input(join(root,paths[0]!),sizes[0]!),...input(join(root,paths[1]!),sizes[1]!),'-filter_complex',graph,'-map','[o]','-f','rawvideo',join(root,'out')],{timeout:10000});
   // Native opens its output file before the graph is configured; it stays empty.
   expect(native.status,name).not.toBe(0);expect(existsSync(join(root,'out'))?readFileSync(join(root,'out')).length:0,name).toBe(0);rmSync(join(root,'out'),{force:true});
   for(const mode of engines){
    const io=memory(files),result=await engine(mode,io.filesystem).exec(['-y',...input('/'+paths[0],sizes[0]!),...input('/'+paths[1],sizes[1]!),'-filter_complex',graph,'-map','[o]',...tail(mode,'rawvideo'),'/out']);
    expect(result.exitCode,`${name} ${mode}`).not.toBe(0);expect(io.opened,`${name} ${mode}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${name} ${mode}`).toContain(message);count++;
   }
  }
  // Single-input graph path (complex-video planner) for the split mismatch and enable=; native supports timeline enable=, refused here.
  for(const [graph,message,nativeFails]of [['[0:v]split[a][b];[a]scale=4:2[c];[c][b]maskedthreshold[o]','do not match',true],['[0:v]split[a][b];[a][b]maskedthreshold=enable=1[o]','timeline',false]] as const){
   const native=spawnSync(ffmpeg,['-y','-v','error','-nostdin',...input(join(root,'b'),'5x3'),'-filter_complex',graph,'-map','[o]','-f','rawvideo',join(root,'out')],{timeout:10000});expect(native.status!==0,graph).toBe(nativeFails);rmSync(join(root,'out'),{force:true});
   for(const mode of ['graph',...engines] as const){
    const stream=mode==='stream',io=memory(files),result=await (mode==='graph'?media(io.filesystem):engine(mode,io.filesystem)).exec(['-y',...input('/b','5x3'),...(stream?input('/b','5x3'):[]),'-filter_complex',stream?`${graph};[1:v]nullsink`:graph,'-map','[o]',...tail(mode,'rawvideo'),'/out']);
    expect(result.exitCode,`${graph} ${mode}`).not.toBe(0);expect(io.opened,`${graph} ${mode}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${graph} ${mode}`).toContain(message);count++;
   }
  }
  expect(count).toBe(9*3+2*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
/** Per-source negotiation for a join. tests/helpers/video-negotiation-cases.ts always runs a linear chain, which a join never has,
 * so this mirrors its graph, stream, actor and timed checks and CLI refusals here (legacy yuvj sources are linear-only and skipped). */
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every join path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskedthreshold-negotiation-')),graph='split[a][b];[a]vflip[c];[c][b]maskedthreshold=10:mode=diff',matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 try{
  for(const source of negotiationSources.filter(format=>!format.startsWith('yuvj'))){
   const data=pattern(source,8,6,2,0,source.length),file=join(root,'in.raw'),before=[...base,'-pixel_format',source,'-s','8x6'];writeFileSync(file,data);
   const shown=/ fmt:(\S+) /.exec(spawnSync(ffmpeg,['-v','info','-nostdin','-cpuflags','0',...before,'-i',file,'-filter_complex',`[0:v]${graph},showinfo[o]`,'-map','[o]','-f','null','-'],{encoding:'utf8',timeout:10000}).stderr)?.[1];
   expect(shown,source).toBeDefined();
   const executable=['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp'].includes(shown!);
   const native=executable?execFileSync(ffmpeg,['-v','error','-nostdin','-cpuflags','0',...before,'-i',file,'-filter_complex',`[0:v]${graph}[o]`,'-map','[o]','-f','rawvideo','-']):null;
   const shape={format:source,width:8,height:6},frames=[0,1].map(n=>frame(source,8,6,data,n));
   const runs={
    graph:async()=>{const plan=compileVideoFilterGraph(`[0:v]${graph}[o]`).plan(shape,[null],{arithmetic:'scalar'});return frames.map(value=>plan.apply(value,{maxFrameBytes:1<<16,maxStateBytes:1<<22,maxResidentBytes:1<<24})[0]!);},
    stream:async()=>{const execution=createReplayVideoExecution(`[0:v]${graph}[o]`,[{geometry:shape,timeBase:time,async *open(){yield* frames;}}],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<22,maxResidentBytes:1<<24,maxSourceTraversals:16},{arithmetic:'scalar'});try{const out:VideoFrameData[]=[];for await(const value of execution.outputs[0]!.frames)out.push(value);return out;}finally{await execution.close();}},
    actor:async()=>{const actors=createFrameActors(graph,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});try{for(const value of frames)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:value});actors.endInput(0,-541478725,2n);const out:VideoFrameData[]=[];for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0)return out;out.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
    timed:async()=>{const out:VideoFrameData[]=[],store=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){return values.get(index)!;},async discardBefore(){},async close(){values.clear();}};};
     await executeTimedGraph(planTimedVideoGraph(graph,[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(const value of frames)yield {kind:'frame',frame:value,duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}})],store,{numericProfile:'linux-x64',maxFrameBytes:1<<16,maxStateBytes:1<<22,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){out.push(event.frame);}});return out;},
   };
   for(const [path,run]of Object.entries(runs)){
    if(native){const out=await run();expect(out.map(value=>value.pixelFormat),`${source}/${path}`).toEqual([shown,shown]);expect(Buffer.concat(out.map(tight)),`${source}/${path}`).toEqual(native);}
    else await expect(run(),`${source}/${path}`).rejects.toThrow(`negotiates ${shown}, which is not implemented`);
    checks++;
   }
   if(!native)for(const mode of ['graph',...engines] as const){
    const stream=mode==='stream',io=memory(new Map([['/in',data]])),result=await (mode==='graph'?media(io.filesystem):engine(mode,io.filesystem)).exec(['-y',...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),'-filter_complex',`[0:v]${graph}[o]${stream?';[1:v]nullsink':''}`,'-map','[o]',...tail(mode,'rawvideo'),'/out']);
    expect(result.exitCode,`${source}/${mode}`).not.toBe(0);expect(io.opened,`${source}/${mode}`).toBe(0);expect(JSON.stringify(result.diagnostics),`${source}/${mode}`).toContain(`negotiates ${shown}, which is not implemented`);checks++;
   }
   (native?matched:refused)[source]=shown!;
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp'});
 expect(checks).toBe(14*4+4*4);
},180000);
