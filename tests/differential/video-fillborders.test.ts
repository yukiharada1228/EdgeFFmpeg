import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['yuv444p','yuv422p','yuv420p','yuva420p','gbrp','gray'],modes=['smear','mirror','fixed','reflect','wrap','fade','margins'],colors=[null,'0x4080c0','0x4080c0@0x80','#20e0a0','0x10ff3360','black@0.5'];
/** Two frames per input: a structured gradient with edges, then LCG noise. */
function input(format:string,width:number,height:number):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*2);let seed=97;
 for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++)data[plane.offset+y*plane.rowBytes+x]=(x*29+y*53+index*71+(x>y?96:0))&255;
 for(let i=layout.bytes;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed>>>24;}
 return data;
}
const frames=(format:string,width:number,height:number,data:Uint8Array)=>{const bytes=pixelLayout(format,width,height).bytes;return [0,1].map(n=>decodeRawVideo({streamIndex:0,data:data.slice(n*bytes,(n+1)*bytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16}));};
const native=(root:string,args:readonly string[])=>spawnSync(ffmpeg,['-y','-v','error','-cpuflags','0',...args.map(arg=>arg.startsWith('@')?join(root,arg.slice(1)):arg)],{timeout:10000});
const tuples=(width:number,height:number)=>{const w=width>>1,h=height>>1;return [[0,0,0,0],[1,2,3,0],[3,0,1,2],[w,w,h,h],[w,0,0,h],[w+1,0,0,0],[0,0,h+1,0],[0,w,0,h+1]];};
function description(mode:string,[left,right,top,bottom]:readonly number[],color:string|null){return `fillborders=left=${left}:right=${right}:top=${top}:bottom=${bottom}:mode=${mode}${color===null?'':':color='+color}`;}
it('matches native linear fillborders across formats, modes, border tuples, colours and sizes',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-fillborders-linear-'));const counts={accepted:0,nativeErrors:0,refusedReflect:0,refusedMargins:0};
 try{
  for(const format of formats)for(const [width,height]of [[9,7],[20,10],[33,17]] as const){
   const data=input(format,width,height),decoded=frames(format,width,height,data);writeFileSync(join(root,'input.raw'),data);
   for(const mode of modes)for(const tuple of tuples(width,height))for(const color of mode==='fixed'||mode==='fade'?colors:[null,'0x4080c0']){
    const filter=description(mode,tuple,color),label=`${format}/${width}x${height}/${filter}`,result=native(root,['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i','@input.raw','-vf',filter,'-pix_fmt',format,'-f','rawvideo','-']);
    expect(result.error,label).toBeUndefined();let actual:Buffer|null=null,message='';
    try{const plan=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});actual=Buffer.concat(decoded.flatMap(frame=>{const output=plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return output.planes;}));}catch(error){message=(error as Error).message;}
    if(result.status!==0){expect(result.stderr.toString(),label).toContain('Borders are bigger than input frame size.');expect(message,label).toBe('Borders are bigger than input frame size.');counts.nativeErrors++;continue;}
    if(actual===null){expect(message,label).toMatch(mode==='reflect'?/reflect borders reaching half/:/margins on planes narrower than 8/);counts[mode==='reflect'?'refusedReflect':'refusedMargins']++;continue;}
    expect(actual,label).toEqual(result.stdout);counts.accepted++;
   }
  }
  expect(counts).toEqual({accepted:1926,nativeErrors:1188,refusedReflect:24,refusedMargins:30});
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
const filesystemFor=(data:Uint8Array,outputs:Map<string,ReturnType<typeof collectingOutput>>):VirtualFileSystem=>({async openRead(){return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){const sink=collectingOutput();outputs.set(path,sink);return sink.output;}});
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const memoryStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const backends={media:()=>createMediaBackend({pixelArithmetic:'scalar'}),actor:()=>createTimedVideoBackend({storage:memoryStorage,limits:{numericProfile:'linux-x64',maxEvents:128}}),timed:()=>createTimedVideoBackend({storage:memoryStorage,limits:{numericProfile:'linux-x64',maxEvents:128,scheduler:'pull'}})} as const;
const cliCases=['fillborders=1:2:3:0','fillborders=3:0:1:2:mirror','fillborders=2:3:2:2:fixed:0x4080c0@0x80','fillborders=1:3:2:1:reflect','fillborders=4:4:3:3:wrap','fillborders=3:2:3:1:fade:#20e0a0','fillborders=2:1:2:3:margins:0x10ff3360','fillborders=0:0:0:0:fade'];
it('matches native fillborders rawvideo and framecrc through linear, graph, actor and timed CLI execution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-fillborders-cli-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[20,10],[33,17]] as const){
   const data=input(format,width,height);writeFileSync(join(root,'input.raw'),data);
   for(const filter of cliCases)for(const muxer of ['rawvideo','framecrc'])for(const [backend,complex]of [['media',false],['media',true],['actor',true],['timed',true]] as const){
    const before=['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25'],after=[...(complex?['-filter_complex',`[0:v]${filter}[x]`,'-map','[x]']:['-vf',filter]),...(backend==='media'?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',muxer];
    const label=`${format}/${width}x${height}/${filter}/${muxer}/${backend}/${complex}`,expected=native(root,[...before,'-i','@input.raw',...after,'@out']);expect(expected.status,label+expected.stderr.toString()).toBe(0);
    const outputs=new Map<string,ReturnType<typeof collectingOutput>>(),result=await new FFmpeg({filesystem:filesystemFor(data,outputs),backend:backends[backend](),budget}).exec(['-y',...before,'-i','/in',...after,'/out']);
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(outputs.get('/out')?.committed,label).toBe(true);expect(Buffer.from(outputs.get('/out')!.bytes()),label).toEqual(readFileSync(join(root,'out')));count++;
   }
  }
  expect(count).toBe(768);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed fillborders branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-fillborders-stream-'));let checked=0;
 try{
  for(const format of formats){
   const [width,height]=[20,10],data=input(format,width,height),decoded=frames(format,width,height,data);writeFileSync(join(root,'input.raw'),data);
   for(const graph of ['[in]fillborders=2:1:3:2:mirror[out]','[in]fillborders=3:3:2:2:fade:0x4080c0,hflip[out]','[in]split[x][y];[x]fillborders=1:2:1:2:wrap[l];[y]fillborders=2:2:2:2:margins[r];[l][r]hstack[out]','[in]split[x][y];[x]fillborders=4:0:0:4:reflect,vflip[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[{geometry:{format,width,height},timeBase:{num:1n,den:25n},async *open(){yield* decoded;}}],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const expected=native(root,['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i','@input.raw','-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo','-']);expect(expected.status,graph).toBe(0);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(expected.stdout);expect(stamps).toEqual([0n,1n]);checked++;
   }
  }
  expect(checked).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses margins on narrow chroma, named colours and timeline options before opening outputs where native runs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-fillborders-refuse-'));let count=0;
 try{
  for(const [format,width,height,filter,message]of [['yuv420p',9,7,'fillborders=1:1:1:1:margins','margins on planes narrower than 8'],['yuv422p',14,6,'fillborders=0:0:1:0:margins','margins on planes narrower than 8'],['yuva420p',13,8,'fillborders=mode=margins','margins on planes narrower than 8'],['gray',7,7,'fillborders=1:1:0:0:mode=6','margins on planes narrower than 8'],['yuv444p',8,8,'fillborders=1:1:1:1:fixed:red','fillborders colors'],['gbrp',8,8,'fillborders=1:1:1:1:fade:color=Navy@0.5','fillborders colors'],['gray',8,8,'fillborders=1:1:1:1:fixed:color=random','fillborders colors'],['gray',8,8,'fillborders=1:1:1:1:enable=lt(n\\,1)','timeline']] as const){
   const data=input(format,width,height);writeFileSync(join(root,'input.raw'),data);
   expect(native(root,['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i','@input.raw','-vf',filter,'-f','rawvideo','-']).status,filter).toBe(0);
   expect(()=>compileVideoFilterChain(filter).plan(format,width,height),filter).toThrow(message);
   for(const backend of ['media','actor','timed'] as const){
    const outputs=new Map<string,ReturnType<typeof collectingOutput>>(),result=await new FFmpeg({filesystem:filesystemFor(data,outputs),backend:backends[backend](),budget}).exec(['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','/in','-filter_complex',`[0:v]${filter}[x]`,'-map','[x]','-c:v','rawvideo','-f','framecrc','/out']);
    expect(result.exitCode,`${filter}/${backend}`).not.toBe(0);expect(outputs.size,`${filter}/${backend}`).toBe(0);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
