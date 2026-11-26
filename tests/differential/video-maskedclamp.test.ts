import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {collectingOutput} from '../helpers/output.js';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** The sandbox build need not reproduce the pinned binary: only its commit and the scalar C paths are required. */
const reference=()=>{const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');};
const native=(args:readonly string[],signal?:AbortSignal)=>new Promise<{status:number;stdout:Buffer;stderr:string}>((done,fail)=>{execFile(ffmpeg,['-hide_banner','-nostats',...args],{encoding:'buffer',maxBuffer:1<<24,timeout:20000,...(signal?{signal}:{})},(error,stdout,stderr)=>{if(error&&typeof error.code!=='number')fail(error);else done({status:error?Number(error.code):0,stdout,stderr:stderr.toString()});});});
/** Structured ramps and extremes in even bytes, LCG noise in odd bytes. */
const pattern=(bytes:number,salt:number)=>{let seed=salt*7919+17;return Uint8Array.from({length:bytes},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%2?seed>>>24:i%10===0?0:i%10===2?255:(i*37+salt*13)&255;});};
/** Constant planes: dark above bright everywhere, so every clamped sample takes the crossed-bounds branch. */
const constant=(bytes:number,value:number)=>new Uint8Array(bytes).fill(value);
const ramp=(bytes:number)=>Uint8Array.from({length:bytes},(_,i)=>i*29&255);
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const media=()=>createMediaBackend({pixelArithmetic:'scalar'}),timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
/** graph: one-source -filter_complex; stream: the multi-input CLI; actor: timed producer; timed: timed pull. */
const backends=[['graph',media,1],['stream',media,3],['actor',()=>timed('producer'),1],['actor',()=>timed('producer'),3],['timed',()=>timed('pull'),1],['timed',()=>timed('pull'),3]] as const;
const rawInput=(format:string,size:string,path:string)=>['-f','rawvideo','-pixel_format',format,'-video_size',size,'-framerate','25','-i',path];
async function compare(label:string,files:ReadonlyMap<string,Uint8Array>,root:string,inputs:readonly (readonly [string,string])[],after:readonly string[],backend:ExecutionBackend,signal?:AbortSignal){
 const expected=await native(['-v','error','-cpuflags','0',...inputs.flatMap(([format,size],index)=>rawInput(format,size,join(root,`in${index}.raw`))),...after,'-'],signal);expect(expected.status,label+expected.stderr).toBe(0);
 const sink=collectingOutput(),result=await frontend(files,backend,()=>sink.output).exec(['-y',...inputs.flatMap(([format,size],index)=>rawInput(format,size,`/in${index}`)),...after,'/out']);
 expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);
}
const options=['','=5:5','=255:255','=undershoot=5:overshoot=255','=0:0:1','=planes=6','=planes=0','=300:65535:9'] as const;
it('matches native maskedclamp on three distinct inputs across formats, sizes, bounds, inversions and plane masks',async({signal})=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedclamp-matrix-'));let count=0;
 try{
  const cases=formats.flatMap(format=>sizes.flatMap(([width,height])=>[0,1].map(variant=>({format,width,height,variant}))));
  await runBoundedCases(cases,4,signal,async({format,width,height,variant},caseSignal)=>{
   const bytes=pixelLayout(format,width,height).bytes,directory=mkdtempSync(join(root,'case-'));
   // Noise triples with unequal lengths (3, 2 and 4 frames), or a ramp base between constant crossed bounds (dark 200 > bright 50).
   const data=variant?[ramp(bytes*3),constant(bytes*3,200),constant(bytes*3,50)]:[pattern(bytes*3,width),pattern(bytes*2,height+1),pattern(bytes*4,width*height+2)],files=new Map(data.map((value,index)=>[`/in${index}`,value]));
   data.forEach((value,index)=>writeFileSync(join(directory,`in${index}.raw`),value));
   for(const option of options){await compare(`${format}/${width}x${height}/${variant}/${option}`,files,directory,[0,1,2].map(()=>[format,`${width}x${height}`] as const),['-filter_complex',`[0:v][1:v][2:v]maskedclamp${option}[out]`,'-map','[out]','-c:v','rawvideo','-bitexact','-f','rawvideo'],media(),caseSignal);count++;}
  });
  expect(count).toBe(576);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskedclamp rawvideo and framecrc on the graph, stream, actor and timed paths with and without -ss/-t',async({signal})=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedclamp-paths-'));let count=0;
 try{
  const sources=[['gray',8,6],['yuv420p',7,5],['yuva420p',5,3],['gbrp',17,9],['yuv422p',2,2],['yuv444p',1,1]] as const,cases=sources.flatMap(source=>backends.map(backend=>({source,backend})));
  await runBoundedCases(cases,4,signal,async({source:[format,width,height],backend:[path,create,inputs]},caseSignal)=>{
   const bytes=pixelLayout(format,width,height).bytes,directory=mkdtempSync(join(root,'case-')),data=inputs===1?[pattern(bytes*4,width+height)]:[pattern(bytes*4,width),pattern(bytes*3,height),pattern(bytes*5,width*height)],files=new Map(data.map((value,index)=>[`/in${index}`,value]));
   data.forEach((value,index)=>writeFileSync(join(directory,`in${index}.raw`),value));
   const graph=inputs===1?'[0:v]split=3[a][b][c];[b]hflip[d];[c]vflip[e];[a][d][e]maskedclamp=5:10[out]':'[0:v][1:v][2:v]maskedclamp=undershoot=255:planes=5[out]';
   for(const time of [[],['-ss','0.04'],['-t','0.08'],['-ss','0.04','-t','0.04']])for(const output of ['rawvideo','framecrc']){
    await compare(`${format}/${path}/${inputs}/${time.join(' ')}/${output}`,files,directory,data.map(()=>[format,`${width}x${height}`] as const),['-filter_complex',graph,'-map','[out]',...time,'-c:v','rawvideo','-bitexact','-f',output],create(),caseSignal);count++;
   }
  });
  expect(count).toBe(288);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses size mismatches, framesync and out-of-range options and enable= before opening any output on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedclamp-reject-'));let count=0;
 try{
  const data=pattern(15*3,5),files=new Map([0,1,2].map(index=>[`/in${index}`,data]));for(const index of [0,1,2])writeFileSync(join(root,`in${index}.raw`),data);
  // Native statuses: config_output EINVAL, AVERROR_OPTION_NOT_FOUND (exit 8), av_opt_set ERANGE; the generic enable= and threads= are accepted natively and refused here.
  const einval=256-constants.errno.EINVAL,erange=256-constants.errno.ERANGE;
  const cases=[
   ['[0:v][1:v][2:v]maskedclamp[out]',3,['5x3','5x3','3x5'],einval,'Maskedclamp input sizes differ: base 5x3, dark 5x3, bright 3x5'],
   ['[0:v][1:v][2:v]maskedclamp[out]',3,['5x3','3x5','5x3'],einval,'Maskedclamp input sizes differ: base 5x3, dark 3x5, bright 5x3'],
   ['[0:v]split=3[a][b][c];[c]scale=4:3[d];[a][b][d]maskedclamp[out]',1,['5x3'],einval,'Maskedclamp input sizes differ: base 5x3, dark 5x3, bright 4x3'],
   ['[0:v]split=3[a][b][c];[a]scale=5:2[d];[d][b][c]maskedclamp[out]',1,['5x3'],einval,'Maskedclamp input sizes differ: base 5x2, dark 5x3, bright 5x3'],
   ...['shortest=1','eof_action=endall','repeatlast=0','ts_sync_mode=nearest'].map(option=>[`[0:v][1:v][2:v]maskedclamp=${option}[out]`,3,['5x3','5x3','5x3'],8,'Unsupported maskedclamp option'] as const),
   ['[0:v]split=3[a][b][c];[a][b][c]maskedclamp=planes=16[out]',1,['5x3'],erange,'Invalid maskedclamp planes'],
   ['[0:v]split=3[a][b][c];[a][b][c]maskedclamp=undershoot=65536[out]',1,['5x3'],erange,'Invalid maskedclamp undershoot'],
   ['[0:v]split=3[a][b][c];[a][b][c]maskedclamp=overshoot=-1[out]',1,['5x3'],erange,'Invalid maskedclamp overshoot'],
   ['[0:v]split=3[a][b][c];[a][b][c]maskedclamp=enable=0[out]',1,['5x3'],0,'Maskedclamp timeline expressions are not implemented'],
   ['[0:v][1:v][2:v]maskedclamp=threads=1[out]',3,['5x3','5x3','5x3'],0,'Unsupported maskedclamp option'],
  ] as const;
  for(const [graph,inputs,shapes,status,message]of cases)for(const [path,create]of [['media',media],['actor',()=>timed('producer')],['timed',()=>timed('pull')]] as const){
   const after=['-filter_complex',graph,'-map','[out]','-c:v','rawvideo','-f','rawvideo'],label=`${graph}/${shapes}/${path}`;
   const expected=await native(['-v','error',...shapes.flatMap((size,index)=>rawInput('gray',size,join(root,`in${index}.raw`))),...after,'-']);expect(expected.status,label).toBe(status);
   let opened=0;const result=await frontend(files,create(),()=>{opened++;return collectingOutput().output;}).exec(['-y',...shapes.flatMap((size,index)=>rawInput('gray',size,`/in${index}`)),...after,'/out']);
   expect(result.exitCode,label).toBe(1);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message);expect(inputs).toBe(shapes.length);count++;
  }
  expect(count).toBe(39);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does on the four join paths and refuses picks without storage by name',async({signal})=>{
 // The shared helper always runs the linear path, which a join never has; this mirrors it on graph, stream, actor and timed.
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedclamp-negotiation-')),matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 try{
  const sources=negotiationSources.filter(source=>!source.startsWith('yuvj'));
  await runBoundedCases(sources,4,signal,async(source,caseSignal)=>{
   const directory=mkdtempSync(join(root,'case-')),data=pattern(pixelLayout(source,8,6).bytes*2,source.length*131),files=new Map([0,1,2].map(index=>[`/in${index}`,data]));for(const index of [0,1,2])writeFileSync(join(directory,`in${index}.raw`),data);
   const log=await native(['-v','info',...rawInput(source,'8x6',join(directory,'in0.raw')),'-vf','split=3[a][b][c];[a][b][c]maskedclamp=4:9,showinfo','-f','null','-'],caseSignal),shown=/ fmt:(\S+) /.exec(log.stderr)?.[1];if(!shown)throw new Error(`showinfo printed no format for ${source}`);
   for(const [path,create,inputs]of backends){
    const graph=inputs===1?'[0:v]split=3[a][b][c];[a][b][c]maskedclamp=4:9[out]':'[0:v][1:v][2:v]maskedclamp=4:9[out]',after=['-filter_complex',graph,'-map','[out]','-c:v','rawvideo','-f','rawvideo'],shapes=Array.from({length:inputs},()=>[source,'8x6'] as const),label=`${source}/${path}/${inputs}`;
    if(executableFormat(shown)){await compare(label,files,directory,shapes,after,create(),caseSignal);matched[source]=shown;}
    else{let opened=0;const result=await frontend(files,create(),()=>{opened++;return collectingOutput().output;}).exec(['-y',...shapes.flatMap(([format,size],index)=>rawInput(format,size,`/in${index}`)),...after,'/out']);
     expect(result.exitCode,label).not.toBe(0);expect(opened,label).toBe(0);expect(result.diagnostics.at(-1)?.message,label).toContain(`negotiates ${shown}, which is not implemented`);refused[source]=shown;}
    checks++;
   }
  });
  const sorted=(value:Record<string,string>)=>Object.fromEntries(sources.filter(source=>source in value).map(source=>[source,value[source]!]));
  expect(sorted(refused)).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
  expect(sorted(matched)).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp'});
  expect(checks).toBe(84);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('agrees with native under default slice threads and -filter_threads 1',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskedclamp-threads-'));let count=0;
 try{
  for(const format of ['yuv420p','gbrp','yuva420p'] as const){
   const bytes=pixelLayout(format,17,9).bytes,data=[pattern(bytes*3,1),pattern(bytes*3,2),pattern(bytes*3,3)],files=new Map(data.map((value,index)=>[`/in${index}`,value]));data.forEach((value,index)=>writeFileSync(join(root,`in${index}.raw`),value));
   const inputs=[0,1,2].flatMap(index=>rawInput(format,'17x9',join(root,`in${index}.raw`))),after=['-filter_complex','[0:v][1:v][2:v]maskedclamp=3:7:11[out]','-map','[out]','-c:v','rawvideo','-f','rawvideo','-'];
   const threaded=await native(['-v','error',...inputs,...after]),single=await native(['-v','error','-filter_threads','1',...inputs,...after]);expect(threaded.status).toBe(0);expect(single.stdout).toEqual(threaded.stdout);
   const sink=collectingOutput(),result=await frontend(files,media(),()=>sink.output).exec(['-y',...[0,1,2].flatMap(index=>rawInput(format,'17x9',`/in${index}`)),...after.slice(0,-1),'/out']);expect(result.exitCode).toBe(0);expect(Buffer.from(sink.bytes())).toEqual(threaded.stdout);count++;
  }
  expect(count).toBe(3);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
