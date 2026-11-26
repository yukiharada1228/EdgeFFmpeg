import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
// noformat only restricts negotiation. Every run uses -cpuflags 0 natively and the scalar profile here, so the implicit swscale
// conversions it causes stay on the integer scalar path. Each case first reads native's pick on noformat's link from showinfo, then
// requires native's bytes when the pick has storage here, or the plan-time refusal naming exactly that pick with no output opened.
const native=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725,sources=negotiationOrder;
const allSizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,pathSizes=[[1,1],[5,3],[17,9]] as const;
const chains=['noformat=yuv420p,negate','format=rgb24,noformat=rgb24','noformat=gray|yuv420p,hflip'];
/** noformat=<source> and noformat=<source>|<other>, then the fixed chains. */
const descriptions=(source:string)=>[`noformat=${source}`,`noformat=pix_fmts=${source}|${source==='yuv420p'?'rgb24':'yuv420p'}`,...chains];
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
/** Three frames: ramps and edges, LCG noise, then constant planes. */
function pattern(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=(0x5eed^width*31^height*7^format.length)>>>0;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;out[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=n===0?(x===0||y===0?255:x+1===plane.rowBytes?0:(x*23+y*41+index*67)&255):n===1?seed>>>24:(index*85+17)&255;
 }
 return out;
}
const run=(args:readonly string[],signal:AbortSignal)=>new Promise<{stdout:Buffer;stderr:string}>((done,fail)=>{execFile(native,['-hide_banner','-nostats','-cpuflags','0',...args],{encoding:'buffer',maxBuffer:1<<24,signal},(error,stdout,stderr)=>{if(error)fail(new Error(`${args.join(' ')}: ${stderr.toString()}`));else done({stdout,stderr:stderr.toString()});});});
const raw=(source:string,width:number,height:number)=>['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'];
/** Inserts showinfo after the first noformat; showinfo shares one list between its pads, so native's pick is unchanged. */
const withShowinfo=(description:string)=>description.replace(/noformat(=[^,;\[]*)?/,match=>`${match},showinfo`);
/** One native run with showinfo after noformat: its output bytes and its pick on noformat's link, read from the same command. */
async function nativePick(args:readonly string[],signal:AbortSignal):Promise<{stdout:Buffer;shown:string}>{
 const result=await run(['-v','info',...args],signal),shown=/ fmt:(\S+) /.exec(result.stderr)?.[1];
 if(!shown)throw new Error(`showinfo printed no format for ${args.join(' ')}`);return {stdout:result.stdout,shown};
}
const executable=(format:string)=>(negotiationOrder as readonly string[]).includes(format);
const files=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output']):VirtualFileSystem=>({async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}});
const budget={maxResidentBytes:16*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000};
const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:files(input,open),backend:createMediaBackend({pixelArithmetic:'scalar'}),budget});
const timed=(scheduler:TimedVideoScheduler)=>(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:files(input,open),backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}}),budget});
const decode=(input:Uint8Array,format:string,width:number,height:number,index:number):VideoFrameData=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:input.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16});};
const tight=(frames:readonly VideoFrameData[])=>Buffer.concat(frames.flatMap(frame=>pixelLayout(frame.pixelFormat,frame.width,frame.height).planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes)))));
/** Runs the CLI here; with an expected refusal, requires the named diagnostic and no output opened. */
async function cli(backend:typeof media,input:Uint8Array,args:readonly string[],outputs:readonly string[],refusal:string|null,label:string):Promise<Map<string,Uint8Array>>{
 const sinks=new Map<string,ReturnType<typeof collectingOutput>>();let opened=0;
 const result=await backend(input,path=>{opened++;const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec(args as string[]);
 if(refusal!==null){expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);expect(result.diagnostics.at(-1)?.message,label).toContain(refusal);return new Map();}
 expect(result.exitCode,JSON.stringify({label,result})).toBe(0);
 return new Map(outputs.map(path=>{const sink=sinks.get(path)!;expect(sink.committed,label).toBe(true);return [path,sink.bytes()];}));
}
const refusalFor=(shown:string)=>executable(shown)?null:`negotiates ${shown}, which is not implemented`;
it('runs against the reference build of commit 946fcce0 configured with --disable-x86asm',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native -vf noformat rawvideo and framecrc, or refuses native\'s storage-less pick by name, across formats sizes and time scopes',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-noformat-cli-'));let count=0,refused=0;const picks:Record<string,string>={};
 try{
  await runBoundedCases(sources.flatMap(source=>allSizes.map(size=>[source,size] as const)),4,signal,async([source,[width,height]],caseSignal)=>{
   const input=pattern(source,width,height),file=join(root,`${source}-${width}x${height}.raw`);writeFileSync(file,input);
   for(const description of descriptions(source)){
    for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']]] as const){
     const before=[...raw(source,width,height),...inputTime],after=(vf:string)=>['-vf',vf,...outputTime,'-bitexact','-f',muxer],label=`${source}/${width}x${height}/${description}/${muxer}/${inputTime}`;
     const {stdout:expected,shown}=await nativePick([...before,'-i',file,...after(withShowinfo(description)),'-'],caseSignal),refusal=refusalFor(shown);if(width===8&&muxer==='rawvideo')picks[`${source}/${description}/${inputTime.join(' ')||'whole'}`]=shown;
     const outputs=await cli(media,input,[...before,'-i','/in',...after(description),'/out'],['/out'],refusal,label);
     if(refusal===null)expect(Buffer.from(outputs.get('/out')!),label).toEqual(expected);else{expect(expected.length,label).toBeGreaterThan(0);refused++;}count++;
    }
   }
  });
  expect([count,refused]).toEqual([14*6*5*4,384]);
  // Native's pick with the source itself excluded, and the only picks input -ss changes (its trim filter): both pinned exactly.
  expect(Object.fromEntries(sources.map(source=>[source,picks[`${source}/noformat=${source}/whole`]]))).toEqual({yuv420p:'yuvj420p',rgb24:'bgr24',bgr24:'rgb24',yuv422p:'yuyv422',yuv444p:'yuvj444p',gray:'pal8',nv12:'yuv420p',nv21:'yuv420p',argb:'rgba',rgba:'argb',abgr:'argb',bgra:'argb',yuva420p:'yuva422p',gbrp:'rgb24'});
  expect(Object.keys(picks).length).toBe(140);
  expect(Object.fromEntries(Object.entries(picks).filter(([key,value])=>key.endsWith('/whole')&&picks[key.replace('/whole','/-ss 0.04')]!==value).map(([key,value])=>[key.replace('/whole',''),[value,picks[key.replace('/whole','/-ss 0.04')]]]))).toEqual({'nv12/noformat=yuv420p,negate':['nv12','yuvj420p'],'nv21/noformat=yuv420p,negate':['nv21','yuvj420p']});
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native -filter_complex noformat branches through the media graph and the timed producer and pull schedulers',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-noformat-complex-'));let count=0,refused=0;
 try{
  await runBoundedCases(sources.flatMap(source=>pathSizes.map(size=>[source,size] as const)),4,signal,async([source,[width,height]],caseSignal)=>{
   const input=pattern(source,width,height),file=join(root,`${source}-${width}x${height}.raw`);writeFileSync(file,input);
   for(const description of descriptions(source)){
    for(const graph of [`[0:v]${description},split[left][right]`,`[0:v]split[a][b];[a]${description}[left];[b]null[right]`])for(const muxer of ['rawvideo','framecrc'])for(const scope of [[],['-ss','0.04','-frames:v','1']]){
     const dir=mkdtempSync(join(root,'case-')),outputs=(prefix:string)=>['left','right'].flatMap((name,index)=>['-map',`[${name}]`,...scope,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,prefix+index+'.out']);
     const {shown}=await nativePick(['-y',...raw(source,width,height),'-i',file,'-filter_complex',withShowinfo(graph),...outputs(dir+'/')],caseSignal);
     for(const [name,backend]of [['media',media],['producer',timed('producer')],['pull',timed('pull')]] as const){
      // negate is not an actor or timed operator; those schedulers refuse it before negotiation.
      const refusal=name!=='media'&&description.includes('negate')?'Actor operators not implemented':refusalFor(shown);
      const label=`${name}/${source}/${width}x${height}/${graph}/${muxer}/${scope}`,result=await cli(backend,input,['-y',...raw(source,width,height),'-i','/in','-filter_complex',graph,...outputs('/')],['/0.out','/1.out'],refusal,label);
      if(refusal===null)for(const index of [0,1])expect(Buffer.from(result.get(`/${index}.out`)!),`${label}/${index}`).toEqual(readFileSync(join(dir,index+'.out')));else refused++;count++;
     }
     rmSync(dir,{recursive:true,force:true});
    }
   }
  });
  expect([count,refused]).toEqual([14*3*5*2*2*2*3,1704]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native noformat frame by frame through replay streams and activation actors, or refuses the pick by name',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-noformat-stream-'));let count=0,refused=0;
 try{
  await runBoundedCases(sources.flatMap(source=>pathSizes.map(size=>[source,size] as const)),4,signal,async([source,[width,height]],caseSignal)=>{
   const input=pattern(source,width,height),file=join(root,`${source}-${width}x${height}.raw`);writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width,height},timeBase:time,open(sourceSignal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){sourceSignal.throwIfAborted();yield decode(input,source,width,height,index);}}};}};
   for(const description of descriptions(source)){
    const label=`${source}/${width}x${height}/${description}`,{stdout:expected,shown}=await nativePick([...raw(source,width,height),'-i',file,'-filter_complex',`[0:v]${withShowinfo(description)}[out]`,'-map','[out]','-f','rawvideo','-'],caseSignal);
    const stream=async()=>{const execution=createReplayVideoExecution(`[in]${description}[out]`,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),frames:VideoFrameData[]=[],stamps:bigint[]=[];
     try{for await(const frame of execution.outputs[0]!.frames){frames.push(frame);stamps.push(frame.pts!.value);}}finally{await execution.close();}expect(stamps,label).toEqual([0n,1n,2n]);return frames;};
    const actor=async()=>{const actors=createFrameActors(description,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:{format:source,width,height}}]}),frames:VideoFrameData[]=[];
     try{for(let n=0;n<3;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:decode(input,source,width,height,n)});actors.endInput(0,EOF,3n);for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}};
    for(const [name,frames]of [['stream',stream],['actor',actor]] as const){
     const refusal=name==='actor'&&description.includes('negate')?'Actor operators not implemented':refusalFor(shown);
     if(refusal===null)expect(tight(await frames()),`${name}/${label}`).toEqual(expected);else{await expect(frames(),`${name}/${label}`).rejects.toThrow(refusal);refused++;}count++;
    }
   }
  });
  expect([count,refused]).toEqual([14*3*5*2,129]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('negotiates every accepted source as native does for noformat lists and refuses picks without storage by name on every path',async({signal})=>{
 const outcomes:Record<string,unknown>={};let checks=0;
 for(const description of ['noformat=yuv420p','noformat=rgb24','noformat=gray|yuv420p','noformat=yuv420p|yuv422p|yuv444p|nv12|nv21']){const outcome=await nativeNegotiationOutcome(description,negotiationSources,signal);outcomes[description]={matched:outcome.matched,refused:outcome.refused};checks+=outcome.checks;}
 // Each source with its own format excluded.
 for(const source of negotiationSources.filter(source=>!source.startsWith('yuvj'))){const outcome=await nativeNegotiationOutcome(`noformat=${source}`,[source],signal);outcomes[`noformat=${source}`]={matched:outcome.matched,refused:outcome.refused};checks+=outcome.checks;}
 expect(outcomes).toEqual({
  'noformat=yuv420p':{matched:{},refused:{yuv420p:'yuvj420p'}},
  'noformat=rgb24':{matched:{rgb24:'bgr24'},refused:{}},
  'noformat=gray|yuv420p':{matched:{rgb24:'rgb24',bgr24:'bgr24',yuv422p:'yuv422p',yuv444p:'yuv444p',nv12:'nv12',nv21:'nv21',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'},refused:{yuv420p:'yuvj420p',gray:'pal8'}},
  'noformat=yuv420p|yuv422p|yuv444p|nv12|nv21':{matched:{rgb24:'rgb24',bgr24:'bgr24',gray:'gray',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'},refused:{yuv420p:'yuvj420p',yuv422p:'yuyv422',yuv444p:'yuvj444p',nv12:'yuvj420p',nv21:'yuvj420p'}},
  'noformat=bgr24':{matched:{bgr24:'rgb24'},refused:{}},
  'noformat=yuv422p':{matched:{},refused:{yuv422p:'yuyv422'}},
  'noformat=yuv444p':{matched:{},refused:{yuv444p:'yuvj444p'}},
  'noformat=gray':{matched:{},refused:{gray:'pal8'}},
  'noformat=nv12':{matched:{nv12:'yuv420p'},refused:{}},
  'noformat=nv21':{matched:{nv21:'yuv420p'},refused:{}},
  'noformat=argb':{matched:{argb:'rgba'},refused:{}},
  'noformat=rgba':{matched:{rgba:'argb'},refused:{}},
  'noformat=abgr':{matched:{abgr:'argb'},refused:{}},
  'noformat=bgra':{matched:{bgra:'argb'},refused:{}},
  'noformat=yuva420p':{matched:{},refused:{yuva420p:'yuva422p'}},
  'noformat=gbrp':{matched:{gbrp:'rgb24'},refused:{}}});
 expect(checks).toBe(414);
},300000);
it('refuses noformat forms outside the scope before opening outputs on every backend, where native accepts or rejects them',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-noformat-reject-')),input=pattern('gray',5,3),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  // Native accepts duplicates and color lists (ff_add_format appends; color negotiation is not implemented here) and rejects unknown names with EINVAL.
  for(const [filter,nativeAccepts]of [['noformat=gray|gray',true],['noformat=color_spaces=bt709',true],['noformat=yuv420p:color_ranges=pc',true],['noformat=alpha_modes=straight',true],['noformat=yuvj420p',true],['noformat=yuv420p10le',true],['noformat=enable=1',false],['noformat=bogus',false]] as const){
   const status=await run(['-v','error',...raw('gray',5,3),'-i',file,'-vf',filter,'-f','rawvideo','-'],signal).then(()=>true,()=>false);expect(status,filter).toBe(nativeAccepts);
   for(const backend of [media,timed('producer'),timed('pull')])for(const flag of ['-vf','-filter_complex'] as const){
    let opened=0;const result=await backend(input,()=>{opened++;return collectingOutput().output;}).exec([...raw('gray',5,3),'-i','/in',flag,flag==='-vf'?filter:`[0:v]${filter}[o]`,...(flag==='-vf'?[]:['-map','[o]']),'-f','rawvideo','/out']);
    expect(result.exitCode,filter).not.toBe(0);expect(opened,filter).toBe(0);count++;
   }
  }
  expect(count).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
