import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {drawboxPixelFormats} from '../../packages/avfilter/src/video-drawbox.js';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[];platform:string;arch:string};
/** Translucent colours blend with a double (planar YUV) or float (packed RGB) multiply-add that clang contracts on macOS arm64; GCC on x86-64 does not. */
const linuxX64=metadata.platform==='linux'&&metadata.arch==='x64';
/** The members of native's list with frame storage here, in declared order. */
const stored=drawboxPixelFormats.filter(executableFormat),sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Three frames per input: LCG noise, ramps with a hard diagonal edge, and constant planes. */
function patterned(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames);let seed=0x2545f491;
 for(let n=0;n<frames;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  const at=n*layout.bytes+plane.offset+y*plane.rowBytes+x,kind=n%3;
  if(kind===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[at]=seed>>>24;}else if(kind===1)data[at]=(x*29+y*53+index*71+(x>y?96:0))&255;else data[at]=[0,255,128,17][index]!;
 }
 return data;
}
const frameOf=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const run=(args:readonly string[],signal?:AbortSignal)=>new Promise<{status:number;stdout:Buffer;stderr:string}>(done=>{execFile(ffmpeg,['-hide_banner','-nostdin','-v','error','-cpuflags','0',...args],{encoding:'buffer',maxBuffer:1<<24,...(signal?{signal}:{})},(error,stdout,stderr)=>{done({status:error?Number((error as {code?:unknown}).code??-1):0,stdout,stderr:stderr.toString()});});});
const pool=async<T>(items:readonly T[],work:(item:T,signal:AbortSignal)=>Promise<void>)=>{await runBoundedCases(items,4,new AbortController().signal,work);};
/** Opaque, alpha-0, inverted and replace=1 colours write integers on every platform. */
const integerCases=['drawbox','drawbox=1:1:3:2:red:1','drawbox=x=-2:y=-1:w=4:h=3:c=0x20c040','drawbox=x=iw-2:y=ih-2:w=5:h=5:t=2:c=white','drawbox=x=iw+1:y=0:w=3:h=3:c=red','drawbox=x=-5:y=-5:w=2:h=2:c=blue','drawbox=t=fill:x=1:y=1:w=iw/2:h=ih/2:c=0x8040c0','drawbox=x=1:y=0:w=3:h=4:t=3:c=Navy','drawbox=c=invert:t=1','drawbox=x=1:y=1:w=3:h=3:t=1:c=0x10e08040:replace=1','drawbox=c=red@0:t=2','drawbox=t=0:c=white','drawbox=t=-1:c=white','drawbox=w=-3:h=0.5:t=2:c=yellow','drawbox=x=iw/2-w/2:y=ih/2-h/2:w=iw/3:h=ih/3:t=hsub+vsub+1:c=white','drawbox=x=w:w=2:y=h*0.5:h=3:t=1:c=0xff00ff:replace=1','drawbox=x=st(0\\,ld(0)+1):y=ld(0)+1:w=3:h=3:t=1:c=white',
 'drawgrid','drawgrid=w=3:h=2:c=red','drawgrid=x=1:y=2:w=4:h=3:t=2:c=0x20c040','drawgrid=x=-3:y=-1:w=2:h=2:c=invert','drawgrid=w=iw/3:h=ih/2:t=fill:c=white','drawgrid=x=5:y=7:w=3:h=3:c=white:replace=1','drawgrid=c=yellow@0x80:replace=1:w=2:h=2','drawgrid=t=0:c=red','drawgrid=x=-1:y=-1:w=2:h=3:t=hypot(1\\,1):c=0x808080@0x00'];
/** Translucent colours: the double and float multiply-add path. */
const floatCases=['drawbox=c=red@0.5','drawbox=x=1:y=1:w=4:h=3:t=2:c=0x4080c0@0x80','drawbox=x=-1:y=0:w=3:h=9:t=1:c=0x10e08040','drawbox=t=fill:c=white@0.25:x=1:y=1:w=3:h=2','drawgrid=c=white@0.3:w=2:h=3','drawgrid=x=1:y=1:w=3:h=2:t=1:c=0xc02060@0xc0'];
async function linearMatrix(cases:readonly string[],label:string){
 const root=mkdtempSync(join(tmpdir(),`edge-drawbox-${label}-`)),jobs:[string,number,number][]=[];let count=0;
 try{
  for(const format of stored)for(const [width,height]of sizes)jobs.push([format,width,height]);
  await pool(jobs,async([format,width,height],signal)=>{
   const data=patterned(format,width,height),file=join(root,`${format}-${width}x${height}.raw`);writeFileSync(file,data);
   for(const filter of cases){
    const native=await run(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter,'-f','rawvideo','-'],signal),name=`${format}/${width}x${height}/${filter}`;expect(native.status,name+native.stderr).toBe(0);
    const plan=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});
    const actual=Buffer.concat([0,1,2].flatMap(n=>{const frame=frameOf(data,format,width,height,n),output=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);expect(output.pixelFormat).toBe(format);return output.planes;}));
    expect(actual,name).toEqual(native.stdout);count++;
   }
  });
  return count;
 }finally{rmSync(root,{recursive:true,force:true});}
}
it('runs against the reference build of the pinned commit without x86 assembly',()=>{
 expect(existsSync(ffmpeg),'npm run bootstrap -- --only npm,submodule,reference --allow-unpinned-reference').toBe(true);
 expect(metadata.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native linear drawbox and drawgrid bytes for integer colours across formats, sizes, crossing and outside boxes and patterns',async()=>{
 expect(await linearMatrix(integerCases,'linear')).toBe(stored.length*sizes.length*integerCases.length);
},300000);
it.skipIf(!linuxX64)('matches native translucent drawbox and drawgrid blending on linear chains and the CLI paths (linux-x64 unfused double and float)',async()=>{
 expect(await linearMatrix(floatCases,'float')).toBe(stored.length*sizes.length*floatCases.length);
 expect(await cliMatrix(floatCases.slice(1,5),'float-cli',[[7,5]])).toBe(stored.length*4*2*2*4);
},300000);
const filesystemFor=(data:Uint8Array,outputs:Map<string,ReturnType<typeof collectingOutput>>)=>({async openRead(){return {size:BigInt(data.length),async readAt(offset:bigint,length:number){return data.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path:string){const sink=collectingOutput();outputs.set(path,sink);return sink.output;}});
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const memoryStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const profile=linuxX64?'linux-x64':'darwin-arm64';
const backends={media:()=>createMediaBackend({pixelArithmetic:'scalar'}),actor:()=>createTimedVideoBackend({storage:memoryStorage,limits:{numericProfile:profile,maxEvents:128,scheduler:'activation'}}),timed:()=>createTimedVideoBackend({storage:memoryStorage,limits:{numericProfile:profile,maxEvents:128,scheduler:'pull'}})} as const;
/** rawvideo and framecrc through media -vf and -filter_complex, activation actors and the timed executor, with and without -ss/-t; native with default and single filter threads. */
async function cliMatrix(cases:readonly string[],label:string,shapes:readonly (readonly [number,number])[]){
 const root=mkdtempSync(join(tmpdir(),`edge-drawbox-${label}-`)),jobs:[string,number,number][]=[];let count=0;
 try{
  for(const format of stored)for(const [width,height]of shapes)jobs.push([format,width,height]);
  await pool(jobs,async([format,width,height],signal)=>{
   const data=patterned(format,width,height,4),file=join(root,`${format}-${width}x${height}.raw`);writeFileSync(file,data);
   for(const filter of cases)for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']]] as const){
    const before=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...inputTime];
    for(const [backend,complex]of [['media',false],['media',true],['actor',true],['timed',true]] as const){
     const after=[...(complex?['-filter_complex',`[0:v]${filter}[x]`,'-map','[x]']:['-vf',filter]),...(backend==='media'?[]:['-fps_mode','passthrough','-enc_time_base','filter']),...outputTime,'-c:v','rawvideo','-bitexact','-f',muxer];
     const name=`${format}/${width}x${height}/${filter}/${muxer}/${inputTime.join(' ')}/${backend}/${complex}`,expected=await run(['-y',...before,'-i',file,...after,'-'],signal),single=await run(['-y',...before,'-i',file,'-filter_threads','1',...after,'-'],signal);
     expect(expected.status,name+expected.stderr).toBe(0);expect(single.stdout,name).toEqual(expected.stdout);
     const outputs=new Map<string,ReturnType<typeof collectingOutput>>(),result=await new FFmpeg({filesystem:filesystemFor(data,outputs),backend:backends[backend](),budget}).exec(['-y',...before,'-i','/in',...after,'/out']);
     expect(result.exitCode,name+JSON.stringify(result.diagnostics)).toBe(0);expect(outputs.get('/out')?.committed,name).toBe(true);expect(Buffer.from(outputs.get('/out')!.bytes()),name).toEqual(expected.stdout);count++;
    }
   }
  });
  return count;
 }finally{rmSync(root,{recursive:true,force:true});}
}
it('matches native drawbox and drawgrid rawvideo and framecrc through linear, graph, actor and timed CLI execution with and without -ss/-t',async()=>{
 const cases=['drawbox=x=-1:y=1:w=4:h=3:t=1:c=red','drawbox=t=fill:x=2:y=1:w=3:h=2:c=0x20c040','drawbox=c=invert:t=2','drawbox=x=1:y=1:w=iw-2:h=ih-2:c=0x10e08040:replace=1','drawgrid=x=1:y=-1:w=3:h=2:c=white','drawgrid=w=2:h=2:t=1:c=0x4080c0@0x80:replace=1'];
 expect(await cliMatrix(cases,'cli',[[7,5],[17,9]])).toBe(stored.length*2*cases.length*2*2*4);
},300000);
it('matches native replayed drawbox and drawgrid branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-drawbox-stream-'));let checked=0;
 try{
  for(const format of stored){
   const [width,height]=[8,6],data=patterned(format,width,height),file=join(root,'input.raw');writeFileSync(file,data);
   for(const graph of ['[in]drawbox=1:1:4:3:red:1[out]','[in]drawgrid=w=3:h=2:c=0x20c040,hflip[out]','[in]split[x][y];[x]drawbox=x=-1:y=2:w=5:h=9:t=2:c=white[l];[y]drawgrid=x=1:y=1:w=2:h=4:c=invert[r];[l][r]hstack[out]','[in]split[x][y];[x]drawbox=t=fill:x=2:y=2:w=3:h=3:c=blue,vflip[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){for(let n=0;n<3;n++)yield frameOf(data,format,width,height,n);}}],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const expected=await run(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-']);expect(expected.status,graph+expected.stderr).toBe(0);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(expected.stdout);expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(stored.length*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses native errors with native status and the scoped-out forms native runs, before opening outputs on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-drawbox-refuse-')),einval=(256-constants.errno.EINVAL)&255;let count=0;
 try{
  const data=patterned('yuv420p',8,6),file=join(root,'input.raw');writeFileSync(file,data);
  // [filter, native exit status (null: native runs), message here]
  const cases:readonly (readonly [string,number|null,string])[]=[
   ['drawbox=c=nosuch',einval,"Cannot find color 'nosuch'"],['drawbox=c=red@2',einval,'Invalid alpha value specifier'],['drawgrid=c=#ff00',einval,'Invalid 0xRRGGBB[AA] color string'],['drawbox=box_source=foo',einval,'box_source is not implemented'],
   ['drawbox=x=x',einval,"Error when evaluating the expression 'x'."],['drawgrid=w=nosuch',einval,"Error when evaluating the expression 'nosuch'."],['drawbox=t=0/0',einval,"Error when evaluating the expression '0/0'."],
   ['drawbox=box_source=side_data_detection_bboxes',null,'box_source is not implemented'],['drawbox=x=sin(1)',null,'sin()'],['drawgrid=w=pow(2\\,2)',null,'pow()'],['drawbox=w=sar*4',null,'sar or dar'],['drawbox=c=random',null,'is not supported'],
   ['drawbox=w=1e10',null,'outside the int range'],['drawgrid=x=-2147483647',null,'overflows int'],['drawbox=y=ih-h:h=fill-1',null,'undefined integer conversion'],['drawbox=enable=lt(n\\,1)',null,'timeline'],['drawgrid=threads=1',null,'Unsupported drawgrid option'],
  ];
  for(const [filter,status,message]of cases){
   const native=await run(['-f','rawvideo','-pixel_format','yuv420p','-s','8x6','-i',file,'-vf',filter,'-f','rawvideo','-']);
   expect(native.status,filter+native.stderr).toBe(status??0);if(status!==null)expect(native.stdout.length,filter).toBe(0);
   expect(()=>compileVideoFilterChain(filter).plan('yuv420p',8,6),filter).toThrow(message);
   for(const [backend,complex]of [['media',false],['media',true],['actor',true],['timed',true]] as const){
    const outputs=new Map<string,ReturnType<typeof collectingOutput>>(),result=await new FFmpeg({filesystem:filesystemFor(data,outputs),backend:backends[backend](),budget}).exec(['-y','-f','rawvideo','-pixel_format','yuv420p','-video_size','8x6','-framerate','25','-i','/in',...(complex?['-filter_complex',`[0:v]${filter}[x]`,'-map','[x]']:['-vf',filter]),'-c:v','rawvideo','-f','framecrc','/out']);
    expect(result.exitCode,`${filter}/${backend}/${complex}`).not.toBe(0);expect(outputs.size,`${filter}/${backend}/${complex}`).toBe(0);expect(result.diagnostics.at(-1)?.message,`${filter}/${backend}/${complex}`).toContain(message);count++;
   }
  }
  expect(count).toBe(cases.length*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does for drawbox and drawgrid and runs each pick on every path',async({signal})=>{
 for(const filter of ['drawbox=x=1:y=1:w=4:h=3:t=1:c=0x4080c0','drawgrid=w=3:h=2:c=red']){
  const outcome=await nativeNegotiationOutcome(filter,negotiationSources,signal);
  expect(outcome.refused,filter).toEqual({});
  // Native picks rgb24 for gray and gbrp sources; every pick has storage here and runs byte-exact on every path.
  expect(outcome.matched,filter).toEqual({yuv420p:'yuv420p',rgb24:'rgb24',bgr24:'bgr24',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'rgb24',nv12:'yuv420p',nv21:'yuv420p',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'yuva420p',gbrp:'rgb24',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
  expect(outcome.checks,filter).toBe(73);
 }
},120000);
