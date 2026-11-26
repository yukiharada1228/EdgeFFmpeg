import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {despillVideoFrame,parseDespillOptions} from '../../packages/avfilter/src/video-ops/despill.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const native=resolve('.build/reference/ffmpeg'),formats=['argb','rgba','abgr','bgra'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,EOF=-541478725;
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;platform:string;arch:string;flags:string[]};
/** do_despill_slice is single-precision float: products and sums that a fused multiply-add would contract (macOS arm64) are only pinned
 * against the unfused Linux x64 reference. Options whose every product is exact (multipliers 0 or a power of two) are contraction-free. */
const linuxX64=metadata.platform==='linux'&&metadata.arch==='x64';
/** R, G, B, A byte offsets of each packed order (config_output comp offsets). */
const offsets:Record<string,readonly [number,number,number,number]>={argb:[1,2,3,0],rgba:[0,1,2,3],abgr:[3,2,1,0],bgra:[2,1,0,3]};
/** Three frames: byte noise; structured colour ramps (green and blue ramps against red, spill-like greens); edges and constant planes
 * (keyed greens and blues, white, black, gray, saturated primaries, 0/255 alpha). */
function frames(format:string,width:number,height:number):Uint8Array{
 const bytes=width*height*4,output=new Uint8Array(bytes*3),[ro,go,bo,ao]=offsets[format]!;let seed=7919+width*131+height*17+format.charCodeAt(0);
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 const edges=[[0,255,0,255],[0,0,255,0],[255,255,255,255],[0,0,0,0],[128,128,128,128],[255,0,0,255],[40,200,60,255],[60,90,230,17],[0,255,255,255],[255,255,0,1],[1,2,1,254],[254,255,253,255]];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const p=(y*width+x)*4;for(let i=0;i<4;i++)output[p+i]=next();
  const r=Math.round(x*255/Math.max(1,width-1)),g=Math.round(y*255/Math.max(1,height-1)),ramp=[(r>>1)+((x+y)&1)*40,Math.min(255,g+(x*37&127)),(255-r+g*3)&255,(x*29+y*53)&255];
  const q=bytes+p;output[q+ro]=ramp[0]!;output[q+go]=ramp[1]!;output[q+bo]=ramp[2]!;output[q+ao]=ramp[3]!;
  const e=edges[x===0||y===0||x===width-1||y===height-1?(x+y)%4:4+((x>>1)+y)%8]!,s=2*bytes+p;output[s+ro]=e[0]!;output[s+go]=e[1]!;output[s+bo]=e[2]!;output[s+ao]=e[3]!;
 }
 return output;
}
/** Every multiplier is 0 or a power of two (factor=(1-mix)*(1-expand) included), so fused and unfused float agree. */
const portable=['','blue','type=green:mix=0:expand=1','type=blue:mix=1:expand=0','mix=0:expand=0','mix=0.5:expand=0.5:red=1:green=-2:blue=0.5:brightness=1','blue:0:0.5:-1:2:-4:-2:1','red=-0.5:green=0:blue=-1:brightness=-1:alpha=1','type=1:red=4:green=8:blue=-8:brightness=2','alpha=yes:mix=1:expand=1','green=0.5:green=1:alpha=on'];
/** Typical values and the extremes of each range: inexact products that a contracting compiler would fuse. */
const general=['mix=0.3:expand=0.2','mix=1:expand=1:red=100:green=-100:blue=100:brightness=10','red=-100:blue=-100:brightness=-10:alpha=1','blue:0.7:0.9:37.5:-12.25:0.1:0.33:1','brightness=0.1:green=-1.3','mix=0.123456789:expand=0.987654321:alpha=1','type=blue:mix=0.01:green=99.9:brightness=9.99','mix=0.7:red=0.3:green=-0.6:blue=0.2:brightness=-0.25:alpha=1','type=blue:mix=0:expand=0.25:red=-37:green=63:blue=-1.5'];
const filter=(options:string)=>options?`despill=${options}`:'despill';
const decode=(data:Uint8Array,pixelFormat:string,width:number,height:number,pts:bigint)=>decodeRawVideo({streamIndex:0,data,pts,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat,width,height},{maxFrameBytes:1<<20});
const concat=(chunks:readonly Uint8Array[])=>Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)));
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:8*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const timedBackend=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};},limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
/** One native run per format, size and option string; the kernel must equal it frame by frame. Returns [comparisons, frames the
 * filter changed], so the comparisons are not dominated by spill-free identity frames. */
function kernel(options:readonly string[],label:string):[number,number]{
 const root=mkdtempSync(join(tmpdir(),`edge-despill-${label}-`));let count=0,changed=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=frames(format,width,height),file=join(root,'input.raw'),bytes=width*height*4;writeFileSync(file,input);
   for(const option of options){
    const expected=execFileSync(native,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(option),'-f','rawvideo','-']),step=parseDespillOptions(option||null);expect(expected.length).toBe(bytes*3);
    for(let n=0;n<3;n++){
     const data=input.subarray(n*bytes,(n+1)*bytes),frame=decode(data,format,width,height,BigInt(n)),output=despillVideoFrame(frame,step,{maxFrameBytes:bytes}),name=`${format}/${width}x${height}/${filter(option)}/${n}`;
     expect([output.pixelFormat,output.width,output.height,output.linesizes[0]],name).toEqual([format,width,height,width*4]);expect(tight(output),name).toEqual(expected.subarray(n*bytes,(n+1)*bytes));expect(output.pts).toEqual(frame.pts);
     if(!tight(output).equals(Buffer.from(data)))changed++;count++;
    }
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return [count,changed];
}
it('checks the native reference build at test time',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native despill pixels on every packed order, size and pattern with contraction-free options',()=>{
 const [count,changed]=kernel(portable,'portable');expect(count).toBe(4*6*11*3);expect(changed).toBe(726);
},240000);
// Skipped unless build-metadata reports linux/x64: these options need that reference's unfused float arithmetic. The title is the
// same on every platform so that the linux-x64 contract also names the skip elsewhere.
it.skipIf(!linuxX64)('matches native despill pixels at typical and extreme float option values on every packed order and size (linux/x64)',()=>{
 const [count,changed]=kernel(general,'general');expect(count).toBe(4*6*9*3);expect(changed).toBe(615);
},240000);
it('agrees with native slice threading: default threads and -filter_threads 1 give the same bytes as the kernel',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-despill-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[17,9],[64,48]] as const){
   const input=frames(format,width,height),file=join(root,'input.raw'),bytes=width*height*4;writeFileSync(file,input);
   for(const option of ['','blue:0:0.5:-1:2:-4:-2:1']){
    const run=(threads:string[])=>execFileSync(native,['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',filter(option),'-f','rawvideo','-']);
    const threaded=run([]),single=run(['-filter_threads','1']),eight=run(['-filter_threads','8']);expect(threaded).toEqual(single);expect(eight).toEqual(single);
    const step=parseDespillOptions(option||null);expect(concat([0,1,2].map(n=>tight(despillVideoFrame(decode(input.subarray(n*bytes,(n+1)*bytes),format,width,height,BigInt(n)),step,{maxFrameBytes:bytes})))),`${format}/${width}x${height}/${option}`).toEqual(single);count++;
   }
  }
  expect(count).toBe(16);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native despill linear and graph plans with scalar conversions around the packed stage',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-despill-plan-'));let count=0;
 try{
  for(const source of ['rgba','abgr','rgb24','gray','yuv420p'])for(const [width,height]of [[5,4],[6,3]] as const){
   const input=source==='rgba'||source==='abgr'?frames(source,width,height).subarray(0,width*height*4):Uint8Array.from({length:pixelLayout(source,width,height).bytes},(_,i)=>[16,200,40,90,235][(i*7+(i/width|0))%5]!);writeFileSync(join(root,'input.raw'),input);
   const frame=decode(input,source,width,height,9007199254740993n);
   for(const description of ['despill','despill=blue:alpha=1','despill=mix=0:expand=1,hflip','format=bgra,despill=red=2:green=-4,vflip','transpose=clock,despill=type=1:brightness=-1,format=argb'])for(const target of [null,'rgba','yuv444p','gray']){
    const label=`${source}/${width}x${height}/${description}/${target}`,expected=execFileSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'}),linear=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});
    expect(tight(linear),label).toEqual(expected);expect(linear.pts).toEqual(frame.pts);
    const graph=compileVideoFilterGraph(`[0:v]${description}[out]`).plan({format:source,width,height},[target],{arithmetic:'scalar'}).apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<22,maxResidentBytes:1<<24})[0]!;
    expect(tight(graph),label).toEqual(expected);count++;
   }
  }
  expect(count).toBe(200);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native replayed despill streams and activation actors with branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-despill-stream-'));let streams=0,actors=0;
 try{
  for(const [source,target]of [['rgba',null],['bgra','rgba'],['argb','yuv444p'],['abgr','bgra']] as const){
   const input=frames(source,5,4),file=join(root,'input.raw'),bytes=5*4*4;writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input.subarray(n*bytes,(n+1)*bytes),source,5,4,BigInt(n)));
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(const frame of decoded){signal.throwIfAborted();yield frame;}}};}};
   for(const graph of ['[in]despill[out]','[in]despill=blue:0:0.5:-1:2:-4:-2:1,hflip[out]','[in]split[x][y];[x]despill=alpha=1[l];[y]despill=mix=1:expand=1,vflip[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,despill=type=blue[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x4','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);streams++;
   }
   for(const description of ['despill','despill=type=blue:red=-1:alpha=1','hflip,despill=mix=0:expand=0:green=-2,vflip']){
    const expected=execFileSync(native,['-v','error','-f','rawvideo','-pixel_format',source,'-s','5x4','-i',file,'-vf',description,'-f','rawvideo','-']);
    const run=createFrameActors(description,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:source,width:5,height:4}}]}),chunks:Buffer[]=[];
    try{for(const frame of decoded)run.sendFrameInput(0,{kind:'frame',duration:1n,frame});run.endInput(0,EOF,3n);for(let attempt=0;;attempt++){expect(attempt).toBeLessThan(16);const result=await run.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{run.dispose();}
    expect(Buffer.concat(chunks),`actor ${source}/${description}`).toEqual(expected);actors++;
   }
  }
  expect([streams,actors]).toEqual([16,12]);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native despill CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths',async()=>{
 const backends:readonly [string,(()=>ExecutionBackend),boolean][]=[['media',()=>createMediaBackend({pixelArithmetic:'scalar'}),true],['actor',()=>timedBackend('producer'),false],['activation',()=>timedBackend('activation'),false],['timed',()=>timedBackend('pull'),false]];let count=0;
 const root=mkdtempSync(join(tmpdir(),'edge-despill-cli-'));
 try{
  for(const source of formats){
   const input=frames(source,3,2);writeFileSync(join(root,'input.raw'),input);
   for(const description of ['despill','despill=blue:alpha=1','despill=mix=0.5:expand=0.5:red=1:green=-2:blue=0.5:brightness=1,hflip','split[a][b];[a]despill[l];[b]despill=type=1,vflip[r];[l][r]vstack'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-t','0.05']])for(const [name,backend,linear]of backends)for(const complex of linear&&!description.includes(';')?[false,true]:[true]){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','3x2','-framerate','25'],after=[...(complex?['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']:['-vf',description]),...time,...(linear?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',format];
    const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(input,backend(),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${time}/${name}/${complex}`;
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(4*(3*5+4)*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('refuses despill options before any output is opened where native rejects or would evaluate them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-despill-reject-'));let count=0;
 try{
  const input=frames('rgba',3,2).subarray(0,48);writeFileSync(join(root,'input.raw'),input);
  for(const [options,nativeFails,message]of [['mix=1.5',true,'outside'],['mix=-0.1',true,'outside'],['expand=2',true,'outside'],['red=101',true,'outside'],['green=-100.5',true,'outside'],['brightness=-11',true,'outside'],['type=2',true,'Invalid despill type'],['type=red',true,'Invalid despill type'],['alpha=auto',true,'alpha'],['alpha=2',true,'alpha'],['foo=1',true,'Unsupported despill option'],['1:0.5:0:0:-1:0:0:1:3',true,''],['mix=0.25+0.25',false,'Only decimal despill mix'],['red=0.01k',false,'Only decimal despill red'],['green=green',true,'Only decimal despill green'],['enable=1',false,'timeline'],['enable=gte(t\\,1)',false,'timeline'],['threads=1',false,'Unsupported despill option']] as const){
   const description=`despill=${options}`,nativeRun=spawnSync(native,['-v','error','-f','rawvideo','-pixel_format','rgba','-s','3x2','-i',join(root,'input.raw'),'-vf',description,'-f','rawvideo','-'],{timeout:10000});
   expect(nativeRun.status!==0,description).toBe(nativeFails);if(nativeFails)expect(nativeRun.stdout.length,description).toBe(0);
   for(const [backend,args]of [[createMediaBackend({pixelArithmetic:'scalar'}),['-vf',description]],[createMediaBackend({pixelArithmetic:'scalar'}),['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']],[timedBackend('producer'),['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']],[timedBackend('pull'),['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']]] as const){
    let opened=0;const result=await frontend(input,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format','rgba','-video_size','3x2','-i','/in',...args,'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);expect(result.diagnostics.map(entry=>entry.message).join('\n'),description).toContain(message);count++;
   }
  }
  expect(count).toBe(18*4);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does with contraction-free defaults',async({signal})=>{
 const outcome=await nativeNegotiationOutcome('despill',negotiationSources,signal);
 // Native picks argb, the first declared format, from every non-packed-alpha source; packed-alpha sources pass through.
 expect(outcome.refused).toEqual({});
 expect(outcome.matched).toEqual({yuv420p:'argb',rgb24:'argb',bgr24:'argb',yuv422p:'argb',yuv444p:'argb',gray:'argb',nv12:'argb',nv21:'argb',argb:'argb',rgba:'rgba',abgr:'abgr',bgra:'bgra',yuva420p:'argb',gbrp:'argb',yuvj420p:'argb',yuvj422p:'argb',yuvj444p:'argb'});
 expect(outcome.checks).toBe(14*5+3);
},120000);
