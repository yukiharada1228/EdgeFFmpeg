import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {avgblurVideoFrame,parseAvgblurOptions,avgblurPixelFormats} from '../../packages/avfilter/src/video-ops/avgblur.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
/** The members of native's list with frame storage here: the six eight-bit layouts. */
const stored=avgblurPixelFormats.filter(executableFormat);
const ffmpeg=resolve('.build/reference/ffmpeg');
/** The sandbox build may differ from the pinned binary; only its provenance is required, never its digest. */
function reference():void{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Frames cycle through LCG noise, a horizontal/vertical ramp with sparse peaks, a saturated checkerboard and constant planes. */
function patterned(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),bytes=layout.bytes,data=new Uint8Array(bytes*frames);let seed=0x2545f491;
 for(let i=0;i<data.length;i++){
  const frame=Math.floor(i/bytes)%4,j=i%bytes,plane=layout.planes.findIndex(p=>j>=p.offset&&j<p.offset+p.bytes),p=layout.planes[plane]!,x=(j-p.offset)%p.rowBytes,y=Math.floor((j-p.offset)/p.rowBytes);
  if(frame===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed>>>24;}else if(frame===1)data[i]=j%7===3?255-(j%5):(x*29+y*11)&255;else if(frame===2)data[i]=((x+y)&1)?255:0;else data[i]=plane*80+17;
 }
 return data;
}
const frameOf=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const optionSets=[null,'sizeX=2','5','64','sizeX=1:sizeY=3','2:15:5','sizeX=5:sizeY=1','planes=1','planes=2','planes=5','3:5','sizeX=64:planes=10:sizeY=2','planes=0','sizeX=1024:sizeY=1024','sizeX=3:planes=0xe:sizeY=0'];
const sizes=[[1,1],[2,2],[1,3],[2,3],[5,3],[7,5],[8,6],[17,9],[40,2]] as const;
it('matches native avgblur bytes across formats sizes radii planes and patterns',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-kernel-'));let count=0;
 try{
  for(const format of stored)for(const [width,height]of sizes){
   const input=patterned(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const options of optionSets){
    const description=options===null?'avgblur':`avgblur=${options}`,label=`${format}/${width}x${height}/${description}`,settings=parseAvgblurOptions(options);
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);
    const actual=Buffer.concat([0,1,2,3].flatMap(n=>avgblurVideoFrame(frameOf(input,format,width,height,n),settings,{maxFrameBytes:1<<20}).planes));
    expect(actual,label).toEqual(native);count++;
   }
  }
  expect(count).toBe(810);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native avgblur with default filter threads and with -filter_threads 1',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-threads-'));let count=0;
 try{
  for(const format of stored)for(const [width,height]of [[17,9],[64,33]] as const){
   const input=patterned(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['avgblur','avgblur=5:5:2','avgblur=sizeX=64:sizeY=3']){
    const settings=parseAvgblurOptions(description.slice(8)||null),actual=Buffer.concat([0,1,2,3].flatMap(n=>avgblurVideoFrame(frameOf(input,format,width,height,n),settings,{maxFrameBytes:1<<20}).planes));
    for(const threads of [[],['-filter_threads','1']]){const native=execFileSync(ffmpeg,['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);expect(actual,`${format}/${width}x${height}/${description}/${threads}`).toEqual(native);count++;}
   }
  }
  expect(count).toBe(72);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native linear avgblur chains with negotiated conversion and scalar arithmetic',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-linear-'));let count=0;
 try{
  for(const source of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp','nv12','nv21','rgb24'])for(const [width,height]of [[5,3],[6,4]] as const){
   const input=patterned(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const target of [null,'nv12','rgba'])for(const description of ['avgblur','avgblur=2:5:1','hflip,avgblur=sizeX=3:planes=2,scale=13:7','format=nv12,avgblur','scale=13:7,avgblur=64,vflip']){
    const label=`${source}/${width}x${height}/${target}/${description}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',file,'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'});
    const actual=Buffer.concat([0,1,2].flatMap(n=>{const frame=frameOf(input,source,width,height,n),output=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return output.planes;}));
    expect(actual,label).toEqual(native);count++;
   }
  }
  expect(count).toBe(270);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
const frontendFor=(input:Uint8Array,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:'scalar'}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000}});
it('matches native avgblur CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-cli-'));let linear=0,graph=0;
 try{
  for(const [source,target]of [['gray',null],['yuv420p','rgba'],['yuva420p',null],['gbrp','gray'],['nv12','yuv444p'],['bgr24',null]] as const){
   const input=patterned(source,5,3,4);writeFileSync(join(root,'input.raw'),input);const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'];
   for(const description of ['avgblur','avgblur=sizeX=2:planes=5:sizeY=1,hflip','avgblur=64:3','scale=13:7,avgblur=sizeY=3'])for(const size of [null,'7x5'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]]){
    const after=['-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',format],native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,...inputTime!,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontendFor(input,()=>sink.output).exec([...before,...inputTime!,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,description,size,format,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${size}/${format}/${inputTime}/${outputTime}`).toEqual(native);expect(sink.committed).toBe(true);linear++;
   }
   for(const description of ['[0:v]split[a][b];[a]avgblur[left];[b]hflip,avgblur=3:1:2[right]','[0:v]avgblur=planes=0,split[left][right]'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','1']]){
    const outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...(target?['-pix_fmt',target]:[]),...time,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontendFor(input,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({source,description,format,time,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${description}/${format}/${time}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}graph++;
   }
  }
  expect([linear,graph]).toEqual([288,48]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native replayed avgblur branches and joins frame by frame',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-stream-'));let checked=0;
 try{
  for(const [source,target]of [['yuva420p',null],['nv12','rgba'],['gray',null],['gbrp','yuv420p'],['yuv422p',null]] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=patterned(source,5,3),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]avgblur[out]','[in]avgblur=2:5:1,hflip[out]','[in]split[x][y];[x]avgblur[l];[y]avgblur=planes=0[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,avgblur=sizeY=2[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(20);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
/** The public timed backend: pull runs the timed DAG executor, the other schedulers run activation actors. */
async function timedRun(argv:readonly string[],input:Uint8Array,scheduler:'pull'|'activation'|'producer'){
 const published=new Map<string,Uint8Array>();let writes=0;
 const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing fixture event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
 const engine=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){writes++;const chunks:Uint8Array[]=[];return {async write(bytes){chunks.push(bytes.slice());},async commit(){published.set(path,Buffer.concat(chunks));},async abort(){chunks.length=0;}};}},backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128,scheduler}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:10000}});
 const result=await engine.exec([...argv]);return {result,published,writes};
}
it('matches native avgblur framecrc and rawvideo through the timed executor and activation actors',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-avgblur-timed-'));let count=0;
 try{
  for(const format of stored)for(const [width,height]of [[1,1],[2,3],[5,3]] as const){
   const input=patterned(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const filter of ['avgblur','avgblur=sizeX=2:planes=5:sizeY=1,hflip','avgblur=64:3:2','split[a][b];[a]avgblur=planes=2[l];[b]avgblur=3:15:0[r];[l][r]vstack'])for(const muxer of ['framecrc','rawvideo']){
    const argv=(input:string,output:string)=>['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input,'-filter_complex',`[0:v]${filter}[x]`,'-map','[x]','-frames:v','3','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,output];
    execFileSync(ffmpeg,['-v','error',...argv(file,join(root,'native.out'))]);const native=readFileSync(join(root,'native.out'));
    for(const scheduler of ['pull','activation','producer'] as const){const {result,published}=await timedRun(argv('/input/one','/output/out'),input,scheduler);const label=`${format}/${width}x${height}/${filter}/${muxer}/${scheduler}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(published.get('/output/out')!),label).toEqual(native);count++;}
   }
  }
  expect(count).toBe(432);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses avgblur enable= timelines on every CLI path before opening outputs while native accepts them',async()=>{
 reference();const input=new Uint8Array(pixelLayout('gray',4,3).bytes*2),before=['-f','rawvideo','-pixel_format','gray','-s','4x3'];let count=0;
 for(const filter of ['avgblur=enable=gte(n\\,1)','avgblur=sizeX=2:enable=1']){
  expect(()=>compileVideoFilterChain(filter)).toThrow();
  for(const args of [['-vf',filter],['-filter_complex',`[0:v]${filter}[x]`,'-map','[x]']]){let opened=0;const result=await frontendFor(input,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in',...args,'-f','rawvideo','/out']);expect(result.exitCode,filter).not.toBe(0);expect(opened,filter).toBe(0);count++;}
  for(const scheduler of ['pull','activation','producer'] as const){const {result,writes}=await timedRun([...before,'-framerate','25','-i','/in','-filter_complex',`[0:v]${filter}[x]`,'-map','[x]','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f','framecrc','/out'],input,scheduler);expect(result.exitCode,`${filter}/${scheduler}`).not.toBe(0);expect(writes,`${filter}/${scheduler}`).toBe(0);count++;}
  execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','gray','-s','4x3','-i','/dev/zero','-frames:v','1','-vf',filter,'-f','null','-']);
 }
 expect(count).toBe(10);
},60000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 reference();
 const outcome=await nativeNegotiationOutcome('avgblur=sizeX=2:planes=5:sizeY=3',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
