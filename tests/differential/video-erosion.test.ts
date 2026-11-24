import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const;
const coordinates=['',':coordinates=0',':coordinates=85',':coordinates=170',...[1,2,4,8,16,32,64,128].map(bit=>`:coordinates=${bit}`)];
const thresholds=['','threshold0=0:threshold1=0:threshold2=0:threshold3=0','threshold0=10:threshold1=10:threshold2=10:threshold3=10','threshold0=0:threshold2=10','threshold1=0:threshold3=10','threshold0=10:threshold1=0'];
const filters=thresholds.flatMap(threshold=>coordinates.map(coordinate=>{const options=(threshold+coordinate).replace(/^:/,'');return options?`erosion=${options}`:'erosion';}));
/** Frame 0 is LCG noise; frame 1 is 2x2 blocks with single dark and bright pixels. */
function pattern(format:string,width:number,height:number,frames=2):Uint8Array{
 const frameBytes=pixelLayout(format,width,height).bytes,data=new Uint8Array(frameBytes*frames);let seed=width*977+height*131+format.length;
 for(let frame=0;frame<frames;frame++)for(let i=0;i<frameBytes;i++){seed=seed*1103515245+12345>>>0;data[frame*frameBytes+i]=frame%2===0?seed>>>16&255:(i%7===3?3:i%11===5?250:((i>>1)*53+(i/width>>1)*97)&255);}
 return data;
}
const base=['-f','rawvideo','-framerate','25'];
const memory=(inputs:Map<string,Uint8Array>)=>{const published=new Map<string,Uint8Array>();let opened=0;const filesystem:VirtualFileSystem={async openRead(path){const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,61));}};},async openWrite(path){opened++;const parts:Uint8Array[]=[];return {async write(chunk){parts.push(chunk.slice());},async commit(){published.set(path,Uint8Array.from(parts.flatMap(part=>[...part])));},async abort(){parts.length=0;}};}};return {filesystem,published,get opened(){return opened;}};};
const budget={maxResidentBytes:1<<24,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(filesystem:VirtualFileSystem)=>new FFmpeg({filesystem,budget,backend:createMediaBackend()});
const timedStore:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timed=(filesystem:VirtualFileSystem,scheduler:'pull'|'activation'|'producer')=>new FFmpeg({filesystem,budget,backend:createTimedVideoBackend({storage:timedStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}})});
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),out=new Uint8Array(layout.bytes);for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)out.set(frame.planes[index]!.subarray(y*frame.linesizes[index]!,y*frame.linesizes[index]!+plane.rowBytes),plane.offset+y*plane.rowBytes);return out;};
it('matches native erosion for every format, coordinate mask, per-plane threshold and size on the linear and graph planners',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-erosion-matrix-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of [[2,3],[3,3],[9,7],[16,12]] as const){
   if(format!=='gray'&&format!=='yuv444p'&&format!=='gbrp'&&width===2)continue;
   const input=pattern(format,width,height),file=join(root,'in.raw'),frameBytes=pixelLayout(format,width,height).bytes;writeFileSync(file,input);
   const frames=[0,1].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16}));
   // One native split per threshold set keeps each description under the 4096 byte graph limit.
   for(let group=0;group<filters.length;group+=coordinates.length){
    const batch=filters.slice(group,group+coordinates.length),graph=`[0:v]split=${batch.length}${batch.map((_,i)=>`[s${i}]`).join('')};`+batch.map((filter,i)=>`[s${i}]${filter}[o${i}]`).join(';');
    execFileSync(ffmpeg,['-y','-v','error','-nostdin','-filter_complex_threads','1',...base,'-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph,...batch.flatMap((_,i)=>['-map',`[o${i}]`,'-f','rawvideo',join(root,`${i}.raw`)])],{timeout:30000});
    const plan=compileVideoFilterGraph(graph).plan({format,width,height},batch.map(()=>null),{arithmetic:'scalar'}),graphOutputs=frames.map(frame=>plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<22,maxResidentBytes:1<<24}));
    for(const [i,filter]of batch.entries()){
     const native=new Uint8Array(readFileSync(join(root,`${i}.raw`))),linear=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});
     expect(Buffer.concat(frames.map(frame=>tight(linear.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:0})))),`linear ${format} ${width}x${height} ${filter}`).toEqual(Buffer.from(native));
     expect(Buffer.concat(graphOutputs.map(outputs=>tight(outputs[i]!))),`graph ${format} ${width}x${height} ${filter}`).toEqual(Buffer.from(native));compared+=2;
    }
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(2*filters.length*(3*4+3*3));
},300000);
const cliFilters=['erosion','erosion=coordinates=85:threshold0=10','erosion=170:0:10:20:30','erosion=coordinates=16,erosion=threshold1=0:coordinates=2'];
it('matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-erosion-cli-'));let compared=0;
 try{
  for(const format of formats)for(const [width,height]of [[3,3],[9,7]] as const){
   const input=pattern(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   for(const filter of cliFilters)for(const muxer of ['rawvideo','framecrc'])for(const mode of ['linear','graph','stream','actor','producer','timed'] as const){
    const before=[...base,'-pixel_format',format,'-s',`${width}x${height}`],stream=mode==='stream';
    // The replay stream path is the multi-input CLI; the second input is erased by nullsink.
    const graph=stream?`[0:v]${filter}[o];[1:v]nullsink`:`[0:v]${filter}[o]`,after=mode==='linear'?['-vf',filter]:['-filter_complex',graph,'-map','[o]'],tail=[...(mode==='linear'||mode==='graph'||stream?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',muxer];
    const native=execFileSync(ffmpeg,['-v','error','-nostdin','-filter_complex_threads','1',...before,'-i',file,...(stream?[...before,'-i',file]:[]),...after,...tail,'-'],{timeout:10000});
    const io=memory(new Map([['/in',input]])),engine=mode==='linear'||mode==='graph'||stream?media(io.filesystem):timed(io.filesystem,mode==='timed'?'pull':mode==='actor'?'activation':'producer');
    const result=await engine.exec([...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...tail,'/out']);expect(result.exitCode,JSON.stringify({format,filter,muxer,mode,diagnostics:result.diagnostics})).toBe(0);
    expect(Buffer.from(io.published.get('/out')!),`${mode} ${format} ${width}x${height} ${filter} ${muxer}`).toEqual(native);compared++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(compared).toBe(formats.length*2*cliFilters.length*2*6);
},300000);
it('matches native replayed erosion branches frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-erosion-stream-'));let checked=0;
 try{
  for(const format of formats){
   const frameBytes=pixelLayout(format,5,4).bytes,input=pattern(format,5,4,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:5,height:4},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]erosion[out]','[in]erosion=coordinates=85:threshold0=10,hflip[out]','[in]split[x][y];[x]erosion=170[l];[y]erosion=threshold0=0:threshold1=0:threshold2=0:threshold3=0[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,erosion=1:5[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=execFileSync(ffmpeg,['-v','error','-nostdin',...base,'-pixel_format',format,'-s','5x4','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-']);
    expect(Buffer.concat(chunks),`${format} ${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(checked).toBe(24);
},120000);
it('refuses one pixel wide erosion planes on every path before opening outputs',async()=>{
 let refused=0;
 for(const [format,width,height]of [['gray',1,4],['yuv420p',2,4],['yuv422p',1,3],['yuva420p',2,2],['gbrp',1,2]] as const){
  const input=pattern(format,width,height,2),before=[...base,'-pixel_format',format,'-s',`${width}x${height}`];
  expect(()=>compileVideoFilterChain('erosion').plan(format,width,height),format).toThrow('one pixel wide');
  expect(()=>compileVideoFilterGraph('[0:v]erosion[o]').plan({format,width,height},[null]),format).toThrow('one pixel wide');
  for(const mode of ['linear','graph','stream','actor','timed'] as const){
   const io=memory(new Map([['/in',input]])),stream=mode==='stream',after=mode==='linear'?['-vf','erosion']:['-filter_complex',stream?'[0:v]erosion[o];[1:v]nullsink':'[0:v]erosion[o]','-map','[o]'];
   const engine=mode==='actor'||mode==='timed'?timed(io.filesystem,mode==='timed'?'pull':'activation'):media(io.filesystem);
   const result=await engine.exec([...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...(mode==='actor'||mode==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[]),'-c:v','rawvideo','-f','rawvideo','/out']);
   expect(result.exitCode,`${mode} ${format}`).not.toBe(0);expect(JSON.stringify(result.diagnostics),`${mode} ${format}`).toContain('one pixel wide');expect(io.published.size).toBe(0);expect(io.opened,`${mode} ${format}`).toBe(0);refused++;
  }
 }
 expect(refused).toBe(25);
},60000);
