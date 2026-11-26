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
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),EOF=-541478725,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Frames cycle through LCG noise, per-plane ramps, and edges with a constant plane (G 77, B a checkerboard, R a vertical step). */
function frames(format:string,width:number,height:number,count=3):Uint8Array{
 const layout=pixelLayout(format,width,height),output=new Uint8Array(layout.bytes*count);let seed=97+width*31+height;
 for(let n=0;n<count;n++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const kind=n%3;
  output[n*layout.bytes+plane.offset+y*plane.rowBytes+x]=kind===0?seed>>>24:kind===1?(x*11+y*29+index*67+n*5)&255:index===0?77:index===1?((x+y)&1)*255:x*2<plane.rowBytes?16:235;
 }
 return output;
}
const decode=(data:Uint8Array,format:string,width:number,height:number,index:number)=>{const bytes=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(index*bytes,(index+1)*bytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return Buffer.concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const memory=(input:Uint8Array)=>{const sink=collectingOutput();const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(){return sink.output;}};return {sink,filesystem};};
const storage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:4*1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:20000};
/** Zero; each channel's h and v at +/-1, +/-(beyond the frame) and +/-255; and three combined sets. */
function shiftOptions(width:number,height:number):string[]{
 const beyond=Math.max(width,height)+2,result=['rgbashift'];
 for(const channel of ['r','g','b','a'])for(const axis of ['h','v'])for(const v of [1,-1,beyond,-beyond,255,-255])result.push(`rgbashift=${channel}${axis}=${v}`);
 result.push(`rgbashift=1:-1:${beyond}:-3:-${beyond}:3:2:-2`,`rgbashift=rh=-255:rv=255:gh=255:gv=-255:bh=${width}:bv=${-height}`,`rgbashift=gh=${width+1}:gv=${height+1}:bh=${-width-1}:bv=${-height-1}:rh=${2*width}:rv=${-2*height}`);
 return result;
}
it('runs against the pinned-commit native reference built without x86 assembly',()=>{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native linear rgbashift gbrp rawvideo across channel shifts, edges, sizes and noise, ramp and edge patterns',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgbashift-linear-'));let count=0;
 try{
  for(const [width,height]of sizes){
   const input=frames('gbrp',width,height),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input,'gbrp',width,height,n));
   for(const shift of shiftOptions(width,height))for(const edge of ['smear','wrap']){
    const description=`${shift}${shift.includes('=')?':':'='}edge=${edge}`,plan=compileVideoFilterChain(description).plan('gbrp',width,height,{arithmetic:'scalar'});expect(plan.pixelFormat).toBe('gbrp');
    const actual=Buffer.concat(decoded.map(frame=>{const output=plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(frame.pts);return tight(output);}));
    expect(actual,`${width}x${height}/${description}`).toEqual(execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','gbrp','-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']));count++;
   }
  }
  expect(count).toBe(624);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native rgbashift -vf and -filter_complex CLI rawvideo and framecrc with timing and rgb24 and gray conversions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgbashift-cli-'));let count=0;
 try{
  const cases:[string,string|null][]=[['gbrp',null],['rgb24',null],['gray',null],['bgr24','rgb24'],['gbrp','gray']];
  for(const [source,target]of cases)for(const [width,height]of [[1,1],[5,3],[17,9]] as const){
   const input=frames(source,width,height,4),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['rgbashift','rgbashift=rh=1:gv=-1:bh=-3','rgbashift=3:-3:-1:1:20:-20:0:0:wrap','rgbashift=rh=255:rv=-255:gh=-17:gv=17:edge=wrap,hflip','vflip,rgbashift=bv=2:gh=2:edge=1'])for(const graph of [false,true])for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,...inputTime!,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
    const result=await new FFmpeg({filesystem,backend:createMediaBackend({pixelArithmetic:'scalar'}),budget}).exec([...before,...inputTime!,'-i','/in',...after,'/out']);
    const label=`${source}/${target}/${width}x${height}/${description}/${graph}/${muxer}/${inputTime}/${outputTime}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(900);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native rgbashift frame graphs and replayed streams with split and stack branches',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgbashift-graph-'));let count=0;
 try{
  for(const [width,height]of [[2,2],[5,3],[8,6]] as const){
   const input=frames('gbrp',width,height,3),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2].map(n=>decode(input,'gbrp',width,height,n));
   for(const graph of ['[in]rgbashift=rh=2:gv=-3:edge=wrap[out]','[in]split[a][b];[a]rgbashift=bh=-1:bv=1[l];[b]rgbashift=gh=255:rv=-255:edge=wrap[r];[l][r]hstack[out]','[in]split[a][b];[a]rgbashift=3:3:3:3:3:3[t];[b]vflip,rgbashift=-3:-3:-3:-3:-3:-3:-3:-3:wrap[u];[t][u]vstack[out]','[in]split[a][b];[a]rgbashift=gv=1[o];[b]nullsink;[o]hflip[out]']){
    execFileSync(ffmpeg,['-y','-v','error','-f','rawvideo','-pixel_format','gbrp','-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo',join(root,'native.raw')]);const native=readFileSync(join(root,'native.raw'));
    const plan=compileVideoFilterGraph(graph.replace('[in]','[0:v]')).plan({format:'gbrp',width,height},[null],{arithmetic:'scalar'});
    expect(Buffer.concat(decoded.map(frame=>tight(plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!))),`graph ${width}x${height}/${graph}`).toEqual(native);count++;
    const replay:ReplayVideoSource={geometry:{format:'gbrp',width,height},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(const frame of decoded){signal.throwIfAborted();yield frame;}}};}};
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    expect(Buffer.concat(chunks),`stream ${width}x${height}/${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native rgbashift through activation actors and the timed backend in rawvideo and framecrc',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgbashift-timed-'));let count=0;
 try{
  for(const [width,height]of [[1,1],[5,3],[17,9]] as const){
   const input=frames('gbrp',width,height,4),file=join(root,'input.raw');writeFileSync(file,input);const decoded=[0,1,2,3].map(n=>decode(input,'gbrp',width,height,n)),geometry={format:'gbrp',width,height};
   for(const description of ['rgbashift','rgbashift=rh=1:rv=-1:gh=-3:gv=3:bh=19:bv=-19','rgbashift=255:-255:13:-13:-4:4:9:9:wrap','hflip,rgbashift=bv=-2:edge=wrap,vflip']){
    const native=execFileSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','gbrp','-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']);
    const actors=createFrameActors(description,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:1<<16,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry}]}),chunks:Buffer[]=[];
    try{for(const frame of decoded)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,4n);for(let attempt=0;;attempt++){expect(attempt).toBeLessThan(16);const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}chunks.push(tight(result.event!.frame));}}finally{actors.dispose();}
    expect(Buffer.concat(chunks),`actor ${width}x${height}/${description}`).toEqual(native);count++;
    for(const muxer of ['rawvideo','framecrc'])for(const time of [[],['-frames:v','2']]){
     const argv=['-f','rawvideo','-pixel_format','gbrp','-video_size',`${width}x${height}`,'-framerate','25'],after=['-filter_complex',`[0:v]${description}[x]`,'-map','[x]',...time,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',muxer];
     const expected=execFileSync(ffmpeg,['-v','error',...argv,'-i',file,...after,'-']),{sink,filesystem}=memory(input);
     const result=await new FFmpeg({filesystem,backend:createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}),budget}).exec(['-y',...argv,'-i','/in',...after,'/out']);
     const label=`timed ${width}x${height}/${description}/${muxer}/${time}`;expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);count++;
    }
   }
  }
  expect(count).toBe(60);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses rgbashift gbrap picks, out-of-range options, timelines and unknown options before output where native accepts or fails them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgbashift-refuse-'));let count=0;
 try{
  for(const [source,description,nativeStatus,message]of [['rgba','rgbashift=rh=1',0,'Video filter rgbashift input negotiates gbrap, which is not implemented'],['yuva420p','rgbashift',0,'Video filter rgbashift input negotiates gbrap, which is not implemented'],['gbrp','rgbashift=rh=256',1,'-255 to 255'],['gbrp','rgbashift=av=-256',1,'-255 to 255'],['gbrp','rgbashift=edge=2',1,'edge smear, wrap'],['gbrp','rgbashift=cbh=1',1,'Unsupported rgbashift option'],['gbrp','rgbashift=gh=1+1',0,'integers from -255 to 255'],['gbrp','rgbashift=rh=1:enable=gt(n\\,0)',0,'timeline']] as const){
   const input=frames(source,5,3,2),file=join(root,'input.raw');writeFileSync(file,input);
   for(const graph of [false,true])for(const timed of [false,true]){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=[...(graph?['-filter_complex',`[0:v]${description}[o]`,'-map','[o]']:['-vf',description]),'-c:v','rawvideo','-bitexact','-f','framecrc'];
    const native=spawnSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',file,...after,'-']);expect(native.status===0?0:1,`${source}/${description}`).toBe(nativeStatus);
    const {sink,filesystem}=memory(input),result=await new FFmpeg({filesystem,backend:timed?createTimedVideoBackend({storage,limits:{numericProfile:'linux-x64',maxEvents:128}}):createMediaBackend({pixelArithmetic:'scalar'}),budget}).exec(['-y',...before,'-i','/in',...after,'/out']);
    const label=`${source}/${description}/${graph}/${timed}`;expect(result.exitCode,label).not.toBe(0);expect(result.diagnostics.map(entry=>entry.message).join('\n'),label).toContain(message);expect(sink.bytes().length,label).toBe(0);expect(sink.committed,label).toBe(false);count++;
   }
  }
  expect(count).toBe(32);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the packed-alpha and yuva gbrap picks before output on every path',async({signal})=>{
 // Native converts every source to gbrp, except packed RGB with alpha and yuva420p, which go to gbrap: no frame storage here, so they are
 // refused by name on every path and CLI backend. Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('rgbashift=rh=1:gv=-2:bh=3:edge=wrap',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap',yuva420p:'gbrap'});
 expect(outcome.matched).toEqual(Object.fromEntries(['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','gbrp','yuvj420p','yuvj422p','yuvj444p'].map(source=>[source,'gbrp'])));
 expect(outcome.checks).toBe(93);
},120000);
