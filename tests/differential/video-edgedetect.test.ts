import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const reference=resolve('.build/reference/ffmpeg'),frames=3;
// Native runs at test time; the sandbox build need not reproduce the pinned binary, so only its provenance is checked.
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:readonly string[]};
it('runs against a reference built from commit 946fcce0 with --disable-x86asm',()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');});
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,kinds=['noise','edges','constant'] as const;
/** Each mode's native list (inputs stay in the operator's own formats) and option sets: defaults, high/low extremes and swaps,
 * plane masks (named, numeric and relative) and the arithmetic threshold forms. */
const cases:readonly (readonly [readonly string[],readonly string[]])[]=[
 [['gray'],['edgedetect','edgedetect=high=0:low=0','edgedetect=1:1','edgedetect=high=0.1:low=0.4','edgedetect=low=0:high=1','edgedetect=high=50/255:low=20/255:planes=0x1','edgedetect=planes=u+v','edgedetect=0.02:0.01:wires']],
 [['gbrp','gray'],['edgedetect=mode=colormix','edgedetect=0.05:0.02:colormix','edgedetect=mode=1:planes=g+r','edgedetect=mode=colormix:high=0.2:low=0.5']],
 [['yuv420p','yuv422p','yuv444p','gbrp','gray'],['edgedetect=mode=canny','edgedetect=mode=canny:high=0:low=0','edgedetect=mode=2:high=0.1:low=0.4:planes=y','edgedetect=mode=canny:planes=u+v','edgedetect=mode=canny:planes=-y','edgedetect=mode=canny:low=0.01:high=0.15:planes=b']],
];
const matrix=cases.flatMap(([formats,descriptions])=>formats.flatMap(format=>descriptions.map(description=>[format,description] as const)));
/** LCG noise; ramps with hard edges and diagonals; constant planes. */
const pattern=(format:string,width:number,height:number,kind:typeof kinds[number])=>{
 const bytes=pixelLayout(format,width,height).bytes;let seed=width*31+height*7+format.length;
 return Uint8Array.from({length:bytes*frames},(_,i)=>{const n=i%bytes,f=Math.floor(i/bytes),x=n%width,y=Math.floor(n/width);
  if(kind==='constant')return 90+f*40;if(kind==='edges')return ((x+f)>width/2?200:30)+((x+y)%4<2?0:20)+(y*9)%25;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
};
const native=(args:readonly string[])=>spawnSync(reference,['-v','error','-cpuflags','0',...args],{timeout:20000,maxBuffer:1<<24});
const memoryStore=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index:number,value:TimedVideoOutputEvent){values.set(index,value);},async read(index:number){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index:number){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000}});
type CliPath='linear'|'graph'|'stream'|'actor'|'timed';
const cliPaths:readonly CliPath[]=['linear','graph','stream','actor','timed'];
/** CLI argv shared by native and every frontend path; stream uses a second input drained into nullsink. */
const argv=(path:CliPath,format:string,width:number,height:number,description:string,muxer:string,input:string,output:string,[inputTime,outputTime]:readonly [readonly string[],readonly string[]]=[[],[]])=>{
 const source=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...inputTime,'-i',input];
 const filter=path==='linear'?['-vf',description]:path==='stream'?['-filter_complex',`[0:v]${description}[x];[1:v]nullsink`,'-map','[x]']:['-filter_complex',`[0:v]${description}[x]`,'-map','[x]'];
 const timing=path==='actor'||path==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[];
 return [...source,...(path==='stream'?source:[]),...filter,...timing,...outputTime,'-c:v','rawvideo','-bitexact','-f',muxer,output];
};
const backendFor=(path:CliPath)=>path==='actor'?timed('producer'):path==='timed'?timed('pull'):media();
const decoded=(input:Uint8Array,format:string,width:number,height:number):VideoFrameData[]=>{const bytes=pixelLayout(format,width,height).bytes;return Array.from({length:frames},(_,n)=>decodeRawVideo({streamIndex:0,data:input.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20}));};
it('matches native edgedetect through the linear, frame graph and replay APIs across modes, formats, thresholds, planes, sizes and patterns',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-edgedetect-api-'));let matched=0,nonzero=0;
 try{
  for(const [format,description]of matrix)for(const [width,height]of sizes)for(const kind of kinds){
   const label=`${format}/${width}x${height}/${kind}/${description}`,input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);const sourceFrames=decoded(input,format,width,height);
   const expected=native(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
   expect(expected.stdout.length,label).toBe(input.length);
   const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[null],{arithmetic:'scalar'});
   expect(Buffer.concat(sourceFrames.flatMap(frame=>linear.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:linear.stateBytes}).planes)),label+' linear').toEqual(expected.stdout);
   expect(Buffer.concat(sourceFrames.flatMap(frame=>graph.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!.planes)),label+' graph').toEqual(expected.stdout);
   const execution=createReplayVideoExecution(`[0:v]${description}[o]`,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* sourceFrames;}}],[null],{maxFrameBytes:1<<20,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
   try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
   expect(Buffer.concat(chunks),label+' stream').toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);matched++;
   if(expected.stdout.some(value=>value!==0))nonzero++;
  }
  expect(matched).toBe(matrix.length*sizes.length*kinds.length);expect(matched).toBe(828);expect(nonzero).toBeGreaterThan(matched/2);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native edgedetect rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-edgedetect-cli-'));let matched=0;
 const scopes:readonly (readonly [readonly string[],readonly string[]])[]=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-t','0.05']]];
 try{
  for(const [format,description]of matrix)for(const [width,height,kind,scope]of [[1,1,'noise',scopes[0]!],[2,2,'constant',scopes[2]!],[5,3,'edges',scopes[1]!],[7,5,'noise',scopes[1]!],[8,6,'edges',scopes[2]!],[17,9,'noise',scopes[0]!]] as const){
   const input=pattern(format,width,height,kind),file=join(root,'input.raw');writeFileSync(file,input);
   for(const muxer of ['rawvideo','framecrc'])for(const path of cliPaths){
    const label=`${path}/${format}/${width}x${height}/${kind}/${description}/${muxer}/${scope.flat().join(' ')}`;const sink=collectingOutput();
    const expected=native(['-y',...argv(path,format,width,height,description,muxer,file,'-',scope)]);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const result=await frontend(input,backendFor(path),()=>sink.output).exec(['-y',...argv(path,format,width,height,description,muxer,'/in','/out',scope)]);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);matched++;
   }
  }
  expect(matched).toBe(matrix.length*6*2*5);expect(matched).toBe(2760);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('accepts the native option forms it implements with native bytes: unit names, relative and wide plane flags, constants and arithmetic',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-edgedetect-forms-'));let count=0;
 try{
  for(const description of ['edgedetect=mode=canny-1','edgedetect=mode=wires+2:planes=y+u-y','edgedetect=mode=canny:planes=+y','edgedetect=mode=canny:planes=0','edgedetect=mode=canny:planes=0x10','edgedetect=mode=canny:planes=4294967295','edgedetect=mode=canny:planes=8+v','edgedetect=high=default*2:low=min','edgedetect=high=max:low=1e-1','edgedetect=high=(1+2)/20:low=none','edgedetect=high=0.1:high=0.3:mode=canny:mode=colormix','edgedetect=low=0.5/255:high=0.49/255']){
   const format=description.includes('canny')||description.includes('wires+2')?'yuv444p':'gray',input=pattern(format,17,9,'edges'),file=join(root,'input.raw');writeFileSync(file,input);
   const negotiated=compileVideoFilterChain(description).plan(format,17,9,{arithmetic:'scalar'}),pick=negotiated.stages.at(-1)!.pixelFormat;
   const expected=native(['-f','rawvideo','-pixel_format',format,'-s','17x9','-i',file,'-vf',`${description},format=${pick}`,'-f','rawvideo','-']);expect(expected.status,description+expected.stderr.toString()).toBe(0);
   expect(Buffer.concat(decoded(input,format,17,9).flatMap(frame=>negotiated.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:negotiated.stateBytes}).planes)),description).toEqual(expected.stdout);count++;
  }
  expect(count).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('produces the same native output with default filter threads and with -filter_threads 1',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-edgedetect-threads-'));let count=0;
 try{
  for(const [format,description]of matrix){
   const input=pattern(format,17,9,'noise'),file=join(root,'input.raw');writeFileSync(file,input);
   const args=(threads:readonly string[])=>['-f','rawvideo','-pixel_format',format,'-s','17x9','-i',file,...threads,'-vf',description,'-f','rawvideo','-'];
   const a=native(args([])),b=native(args(['-filter_threads','1']));expect(a.status).toBe(0);expect(b.status).toBe(0);expect(a.stdout,description).toEqual(b.stdout);count++;
  }
  expect(count).toBe(matrix.length);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-edgedetect-reject-')),input=pattern('gray',9,7,'noise'),file=join(root,'input.raw');writeFileSync(file,input);let count=0;
 try{
  for(const [description,message]of [['edgedetect=high=1.5','out of range'],['edgedetect=low=-0.1','out of range'],['edgedetect=mode=3','out of range'],['edgedetect=mode=sobel','Unable to parse'],['edgedetect=foo=1','Option not found'],['edgedetect=0.1:0.05:canny:y:9','No option name'],['edgedetect=planes=w','Unable to parse']] as const)for(const path of cliPaths){
   const expected=native(['-y',...argv(path,'gray',9,7,description,'rawvideo',file,'-')]);expect(expected.status,description).not.toBe(0);expect(expected.stdout.length,description).toBe(0);expect(expected.stderr.toString(),description).toContain(message);
   let opened=0;const result=await frontend(input,backendFor(path),()=>{opened++;return collectingOutput().output;}).exec(['-y',...argv(path,'gray',9,7,description,'rawvideo','/in','/out')]);
   expect(result.exitCode,`${path} ${description}`).not.toBe(0);expect(opened,`${path} ${description}`).toBe(0);count++;
  }
  expect(count).toBe(35);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
// Every source converts to a pick with frame storage (YUV conversions included), so nothing is refused; pinned from native.
const all=(format:string)=>Object.fromEntries(negotiationSources.map(source=>[source,format]));
const picks:readonly (readonly [string,Readonly<Record<string,string>>])[]=[
 ['edgedetect',all('gray')],
 ['edgedetect=mode=colormix:high=0.3',{...all('gbrp'),gray:'gray'}],
 ['edgedetect=mode=canny:low=0.05:planes=y+u',{yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',argb:'gbrp',rgba:'gbrp',abgr:'gbrp',bgra:'gbrp',yuva420p:'yuv420p',gbrp:'gbrp',yuvj420p:'yuv420p',yuvj422p:'yuv422p',yuvj444p:'yuv444p'}],
];
for(const [vf,matched]of picks)it(`negotiates every accepted source as native does for ${vf}`,async({signal})=>{
 const outcome=await nativeNegotiationOutcome(vf,negotiationSources,signal);
 expect(outcome.refused).toEqual({});expect(outcome.matched).toEqual(matched);expect(outcome.checks).toBe(73);
},120000);
