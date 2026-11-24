import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
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
import {dilateVideoFrame,parseDilationOptions,dilationPixelFormats} from '../../packages/avfilter/src/video-ops/dilation.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg');
/** Three frames per input: LCG noise, sparse peaks over a ramp, and a saturated checkerboard. */
function patterned(format:string,width:number,height:number,frames=3):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,data=new Uint8Array(bytes*frames);let seed=0x2545f491;
 for(let i=0;i<data.length;i++){const frame=Math.floor(i/bytes)%3,j=i%bytes;if(frame===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed>>>24;}else if(frame===1)data[i]=j%7===3?250-(j%5):(j*13)&63;else data[i]=((j+(Math.floor(j/width)&1))&1)?255:j%3;}
 return data;
}
const frameOf=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const optionSets=[null,'coordinates=0','1','2','4','8','16','32','64','128','90','165','15:0','threshold0=12','threshold1=0:threshold2=3','threshold3=1','0:0:0:0:0','255:7:300:65535:2','coordinates=170:threshold0=1:threshold1=2:threshold2=3:threshold3=4'];
const sizes=[[2,1],[2,2],[3,1],[2,5],[3,3],[4,5],[5,3],[17,9]] as const;
it('matches native dilation bytes across formats coordinates thresholds edge sizes and patterns',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-dilation-kernel-'));let accepted=0,refused=0;
 try{
  for(const format of dilationPixelFormats)for(const [width,height]of sizes){
   const input=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   const narrow=pixelLayout(format,width,height).planes.some(plane=>plane.width<2);
   for(const options of optionSets){
    const description=options===null?'dilation':`dilation=${options}`,label=`${format}/${width}x${height}/${description}`,settings=parseDilationOptions(options);
    if(narrow){for(let n=0;n<3;n++)expect(()=>dilateVideoFrame(frameOf(input,format,width,height,n),settings,{maxFrameBytes:1<<20}),label).toThrow('narrower than 2');refused++;continue;}
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);
    const actual=Buffer.concat([0,1,2].flatMap(n=>dilateVideoFrame(frameOf(input,format,width,height,n),settings,{maxFrameBytes:1<<20}).planes));
    expect(actual,label).toEqual(native);accepted++;
   }
  }
  expect([accepted,refused]).toEqual([741,171]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native linear dilation chains with negotiated conversion and scalar or default arithmetic',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-dilation-linear-')),defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp','nv12','nv21','rgb24'])for(const [width,height]of [[5,3],[6,4]] as const){
   const input=patterned(source,width,height),file=join(root,'input.raw');writeFileSync(file,input);
   for(const target of [null,'nv12','rgba'])for(const description of ['dilation','dilation=90:12','hflip,dilation=threshold0=0:threshold1=5,scale=13:7','format=nv12,dilation','scale=13:7,dilation=170,vflip'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,label=`${source}/${width}x${height}/${target}/${description}/${arithmetic}`;
    const native=execFileSync(ffmpeg,['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',file,'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),arithmetic});
    const actual=Buffer.concat([0,1,2].flatMap(n=>{const frame=frameOf(input,source,width,height,n),output=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return output.planes;}));
    expect(actual,label).toEqual(native);count++;
   }
  }
  expect(count).toBe(540);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
const frontendFor=(input:Uint8Array,arithmetic:ReturnType<typeof referencePixelArithmetic>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000}});
it('matches native dilation CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-dilation-cli-')),arithmetic=referencePixelArithmetic();let linear=0,graph=0;
 try{
  for(const [source,target]of [['gray',null],['yuv420p','rgba'],['yuva420p',null],['gbrp','gray'],['nv12','yuv444p'],['bgr24',null]] as const){
   const input=patterned(source,5,3,4);writeFileSync(join(root,'input.raw'),input);const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'];
   for(const description of ['dilation','dilation=coordinates=90:threshold0=12,hflip','dilation=15:0:3','scale=13:7,dilation=threshold2=0'])for(const size of [null,'7x5'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]]){
    const after=['-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',format],native=execFileSync(ffmpeg,['-v','error',...before,...inputTime!,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontendFor(input,arithmetic,()=>sink.output).exec([...before,...inputTime!,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,description,size,format,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${size}/${format}/${inputTime}/${outputTime}`).toEqual(native);expect(sink.committed).toBe(true);linear++;
   }
   for(const description of ['[0:v]split[a][b];[a]dilation[left];[b]hflip,dilation=165:5[right]','[0:v]dilation=threshold0=0,split[left][right]'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','1']]){
    const outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...(target?['-pix_fmt',target]:[]),...time,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontendFor(input,arithmetic,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({source,description,format,time,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${description}/${format}/${time}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}graph++;
   }
  }
  expect([linear,graph]).toEqual([288,48]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native replayed dilation branches and joins frame by frame',async()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-dilation-stream-'));let checked=0;
 try{
  for(const [source,target]of [['yuva420p',null],['nv12','rgba'],['gray',null],['gbrp','yuv420p'],['yuv422p',null]] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=patterned(source,5,3),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]dilation[out]','[in]dilation=90:12,hflip[out]','[in]split[x][y];[x]dilation[l];[y]dilation=coordinates=0[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,dilation=threshold0=3[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
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
it('matches native dilation framecrc and rawvideo through the timed executor and activation actors',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-dilation-timed-'));let count=0;
 try{
  for(const format of dilationPixelFormats)for(const [width,height]of [[3,2],[5,3],[6,1]] as const){
   if(pixelLayout(format,width,height).planes.some(plane=>plane.width<2))continue;
   const input=patterned(format,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const filter of ['dilation','dilation=coordinates=90:threshold0=12,hflip','dilation=15:0:3:0:1','split[a][b];[a]dilation=165[l];[b]dilation=0:0[r];[l][r]vstack'])for(const muxer of ['framecrc','rawvideo']){
    const argv=(input:string,output:string)=>['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',input,'-filter_complex',`[0:v]${filter}[x]`,'-map','[x]','-frames:v','3','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer,output];
    execFileSync(ffmpeg,['-v','error',...argv(file,join(root,'native.out'))]);const native=readFileSync(join(root,'native.out'));
    for(const scheduler of ['pull','activation','producer'] as const){const {result,published}=await timedRun(argv('/input/one','/output/out'),input,scheduler);const label=`${format}/${width}x${height}/${filter}/${muxer}/${scheduler}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(published.get('/output/out')!),label).toEqual(native);count++;}
   }
  }
  expect(count).toBe(432);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses width-1 dilation planes on every path before opening outputs',async()=>{
 const arithmetic=referencePixelArithmetic();let count=0;
 for(const [format,width]of [['gray',1],['yuv420p',2],['yuv422p',1],['yuva420p',2],['gbrp',1]] as const){
  const input=new Uint8Array(pixelLayout(format,width,3).bytes*2),before=['-f','rawvideo','-pixel_format',format,'-s',`${width}x3`];
  expect(()=>compileVideoFilterChain('dilation').plan(format,width,3,{arithmetic}),format).toThrow('narrower than 2');
  for(const filter of [['-vf','dilation'],['-filter_complex','[0:v]dilation[x]','-map','[x]']]){let opened=0;const result=await frontendFor(input,arithmetic,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in',...filter,'-f','rawvideo','/out']);expect(result.exitCode,format).not.toBe(0);expect(opened,format).toBe(0);count++;}
  for(const scheduler of ['pull','activation','producer'] as const){const {result,writes}=await timedRun([...before,'-framerate','25','-i','/in','-filter_complex','[0:v]dilation[x]','-map','[x]','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f','framecrc','/out'],input,scheduler);expect(result.exitCode,`${format}/${scheduler}`).not.toBe(0);expect(writes,`${format}/${scheduler}`).toBe(0);count++;}
 }
 // Native itself accepts these sizes and reads past the row; only the refusal is ours.
 expect(spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','gray','-s','1x3','-i','/dev/zero','-frames:v','1','-vf','dilation','-f','null','-']).status).toBe(0);
 expect(count).toBe(25);
},60000);
