import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
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
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const;
// sum*rdiv+bias is contracted to one fused multiply-add on macOS arm64; the unfused float emulation is the x86-64 baseline.
const linuxX64=process.platform==='linux'&&process.arch==='x64';
const reference=()=>{const build=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8'));expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');};
const m=(values:readonly number[])=>values.join(' ');
/** n taps of a fixed asymmetric pattern, with the centre adjusted so the elements sum to `total`. */
const taps=(n:number,total:number,seed=3)=>{const values=Array.from({length:n},(_,i)=>((i*seed+1)%7)-3),centre=n>>1;values[centre]=0;values[centre]=total-values.reduce((a,b)=>a+b,0);return values;};
const identity=(n:number)=>m(Array.from({length:n},(_,i)=>i===n>>1?1:0));
/** Integer matrices: rdiv resolves to 1 (sums of 0 or 1, or an explicit 0rdiv=1) and bias is 0, so the result is exact on every platform. */
const integerFilters=[
 'convolution',`convolution=0m=${identity(9)}:0rdiv=1`,`convolution=0m=${identity(25)}`,`convolution=0m=${identity(49)}:1m=${identity(49)}:2m=${identity(49)}:3m=${identity(49)}`,
 'convolution=0m=0 -1 0 -1 5 -1 0 -1 0:1m=0 -1 0 -1 5 -1 0 -1 0:2m=0 -1 0 -1 5 -1 0 -1 0:3m=0 -1 0 -1 5 -1 0 -1 0','convolution=0m=0 1 0 1 -4 1 0 1 0:1m=-1 -1 -1 -1 8 -1 -1 -1 -1:2m=-2 -1 0 -1 1 1 0 1 2:3m=1 -2 1 -2 4 -2 1 -2 1',
 `convolution=0m=${m(taps(25,1))}:1m=${m(taps(25,0,2))}:2m=${m(taps(25,1,5))}:3m=${m(taps(25,0))}`,`convolution=0m=${m(taps(49,0))}:1m=${m(taps(49,1,2))}:2m=${m(taps(49,0,5))}:3m=${m(taps(49,1))}`,
 'convolution=0m=1:0mode=row:1m=-1 0 1:1mode=row:2m=1 -2 1:2mode=row:3m=2 -1 0:3mode=row',`convolution=0m=${m(taps(5,1))}:0mode=row:1m=${m(taps(15,0))}:1mode=row:2m=${m(taps(31,1,2))}:2mode=row:3m=${m(taps(49,0))}:3mode=row`,
 'convolution=0m=1:0mode=column:1m=-1 0 1:1mode=column:2m=1 -2 1:2mode=column:3m=2 -1 0:3mode=column',`convolution=0m=${m(taps(49,0))}:0mode=column:1m=${m(taps(7,1))}:1mode=column:2m=${m(taps(25,0,2))}:2mode=column:3m=${m(taps(49,1,5))}:3mode=column`,
 'convolution=0m=1 1 1 1 1 1 1 1 1:0rdiv=1:1m=1 2 1 2 4 2 1 2 1:1rdiv=1:2m=-3 0 0 0 1 0 0 0 0:2rdiv=1:3m=9 9 9:3mode=1:3rdiv=1',
 // Per-plane selection: identity planes are copied, the others filtered, across the three modes.
 `convolution=0m=${identity(9)}:1m=0 -1 0 -1 5 -1 0 -1 0:2m=${identity(9)}:3m=-1 0 1:3mode=column`,`convolution=0m=-1 2 0:0mode=row:1m=${identity(25)}:2m=${m(taps(9,0))}:2mode=column:3m=${identity(9)}`,
 'convolution=0m=0|-1|0|-1|5|-1|0|-1|0:1m=  1  -2   1 :1mode=row:2m=+1 -0 -1:2mode=column','convolution=0 -1 0 -1 5 -1 0 -1 0:0 1 0 1 -4 1 0 1 0:1 2 3 2 1 2 3 2 1:1 -1 1 -1 1 -1 1 -1 1:1:1:1:1:0:0:0:0:square:square:square:square',
];
/** Float matrices: auto rdiv 1/sum, explicit rdiv and bias, negative sums, wrapped integer sums and out-of-range conversions. */
const floatFilters=[
 'convolution=0m=1 1 1 1 1 1 1 1 1:1m=1 2 1 2 4 2 1 2 1:2m=1 1 1 1 2 1 1 1 1:3m=1 3 1 3 9 3 1 3 1',`convolution=0m=${m(Array(25).fill(1))}:1m=${m(Array(49).fill(1))}:2m=${m(taps(25,7))}:3m=${m(taps(49,11,2))}`,
 `convolution=0m=${m(Array(49).fill(1))}:0mode=row:1m=1 2 1:1mode=row:2m=${m(Array(15).fill(1))}:2mode=column:3m=${m(taps(31,9))}:3mode=column`,
 'convolution=0m=0 -1 0 -1 5 -1 0 -1 0:0rdiv=0.1:0bias=0.5:1m=1 1 1 1 1 1 1 1 1:1rdiv=0.333:1bias=16:2m=0 1 0 1 -4 1 0 1 0:2rdiv=2.5:2bias=128:3m=1 2 1:3mode=row:3rdiv=0.7:3bias=300',
 'convolution=0m=-1 -1 -1 -1 1 -1 -1 -1 -1:1m=-1 0 -1 0 1 0 -1 0 0:2m=-2 -2 -2:2mode=row:3m=-1 0 -1 0 -1:3mode=column:0bias=40:1bias=12.25',
 'convolution=0m=0 -1 0 -1 5 -1 0 -1 0:0rdiv=2147483647:1m=1 2 1 2 4 2 1 2 1:1bias=2147483647:2m=16777217 0 0 0 1 0 0 0 0:2rdiv=0.0000001:3m=2147483647 2147483647 2147483647:3mode=row',
 'convolution=0m=1000000000 1000000000 1000000000 0 1 0 -1000000000 -1000000000 -1000000000:0rdiv=0.001:1m=99999999 0 99999999:1mode=column:1rdiv=1e-6:2m=0 0 0 0 3 0 0 0 0:2rdiv=1.5:3m=0 0 0 0 1 0 0 0 1:3bias=0.49999',
 'convolution=1 2 3 2 1 2 3 2 1:0 0 0 0 2 0 0 0 0:-1 -2 -1 0 0 0 1 2 1:0 0 0 1 1 0 0 0 0:0:0.5:0.25:3:7.5:1:0:2.5',
 // Products that land just below a half: unfused float rounding, a double intermediate and a fused multiply-add all differ here.
 'convolution=0m=1:0mode=row:0rdiv=0.7:1m=1:1mode=row:1rdiv=0.9:1bias=0.1:2m=1:2mode=column:2rdiv=1.3:2bias=0.4:3m=3 -1 1:3mode=row:3rdiv=0.7:3bias=0.3',
 'convolution=0m=1 2 1 2 4 2 1 2 1:0rdiv=0.07:0bias=0.2:1m=0 1 0 1 1 1 0 1 0:1rdiv=0.3:1bias=0.3:2m=1 1 1 1 1:2mode=row:2rdiv=0.13:2bias=1.2:3m=1 0 1 0 1 0 1 0 1:3rdiv=0.17',
];
/** Three frames per input: LCG noise, a ramp with sparse dark and bright pixels and edges, and a constant plane value. */
function pattern(format:string,width:number,height:number,frames=3):Uint8Array{
 const frameBytes=pixelLayout(format,width,height).bytes,data=new Uint8Array(frameBytes*frames);let seed=width*977+height*131+format.length;
 for(let frame=0;frame<frames;frame++)for(let i=0;i<frameBytes;i++){seed=seed*1103515245+12345>>>0;const kind=frame%3;data[frame*frameBytes+i]=kind===0?seed>>>16&255:kind===1?(i%7===3?3:i%11===5?250:((i%width)*29+Math.floor(i/width)*17)&255):200;}
 return data;
}
const base=['-f','rawvideo','-framerate','25'];
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),out=new Uint8Array(layout.bytes);for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)out.set(frame.planes[index]!.subarray(y*frame.linesizes[index]!,y*frame.linesizes[index]!+plane.rowBytes),plane.offset+y*plane.rowBytes);return out;};
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9],[40,7]] as const;
/** Native filter_column writes whole 16-column groups from each slice start, past the row end: when a group passes the frame
 * linesize (slice threads, -cpuflags 0 alignment) native output depends on the write order. One filter thread with the default
 * alignment (16 bytes or more) keeps every group inside the row, so column filters are compared with single-threaded native only. */
const single=['-filter_threads','1','-filter_complex_threads','1'],column=(filter:string)=>/mode=(?:column|2)/.test(filter);
let agreed=0;
/** Native split batches under the 4096 byte graph limit, run with default and with one filter thread; linear and graph planners here. */
function matrix(filters:readonly string[],root:string):number{
 let compared=0;
 for(const format of formats)for(const [width,height]of sizes){
  const input=pattern(format,width,height),file=join(root,'in.raw'),frameBytes=pixelLayout(format,width,height).bytes;writeFileSync(file,input);
  const frames=[0,1,2].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16}));
  const batches:string[][]=[];for(const filter of filters){const last=batches.at(-1);if(last&&last.reduce((n,f)=>n+f.length+16,filter.length+64)<4000)last.push(filter);else batches.push([filter]);}
  for(const batch of batches){
   const graph=`[0:v]split=${batch.length}${batch.map((_,i)=>`[s${i}]`).join('')};`+batch.map((filter,i)=>`[s${i}]${filter}[o${i}]`).join(';');
   for(const threads of [[],single])execFileSync(ffmpeg,['-y','-v','error','-nostdin',...threads,...base,'-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph,...batch.flatMap((_,i)=>['-map',`[o${i}]`,'-f','rawvideo',join(root,`${i}${threads.length?'t':'d'}.raw`)])],{timeout:30000});
   const plan=compileVideoFilterGraph(graph).plan({format,width,height},batch.map(()=>null),{arithmetic:'scalar'}),graphOutputs=frames.map(frame=>plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:1<<22,maxResidentBytes:1<<24}));
   for(const [i,filter]of batch.entries()){
    const native=readFileSync(join(root,`${i}t.raw`)),label=`${format} ${width}x${height} ${filter}`;if(!column(filter)){expect(readFileSync(join(root,`${i}d.raw`)),`threads ${label}`).toEqual(native);agreed++;}
    const linear=compileVideoFilterChain(filter).plan(format,width,height,{arithmetic:'scalar'});
    expect(Buffer.concat(frames.map(frame=>tight(linear.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:0})))),`linear ${label}`).toEqual(native);
    expect(Buffer.concat(graphOutputs.map(outputs=>tight(outputs[i]!))),`graph ${label}`).toEqual(native);compared+=2;
   }
  }
 }
 return compared;
}
it('matches native integer convolution for every format, mode, matrix size, plane selection and size with default and single filter threads',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-integer-'));
 try{agreed=0;expect(matrix(integerFilters,root)).toBe(2*integerFilters.length*formats.length*sizes.length);expect(agreed).toBe(integerFilters.filter(filter=>!column(filter)).length*formats.length*sizes.length);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!linuxX64)('matches native float convolution rdiv, bias and conversion edges on linux-x64',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-float-'));
 try{agreed=0;expect(matrix(floatFilters,root)).toBe(2*floatFilters.length*formats.length*sizes.length);expect(agreed).toBe(floatFilters.filter(filter=>!column(filter)).length*formats.length*sizes.length);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
const memory=(inputs:Map<string,Uint8Array>)=>{const published=new Map<string,Uint8Array>();let opened=0;const filesystem:VirtualFileSystem={async openRead(path){const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,61));}};},async openWrite(path){opened++;const parts:Uint8Array[]=[];return {async write(chunk){parts.push(chunk.slice());},async commit(){published.set(path,Uint8Array.from(parts.flatMap(part=>[...part])));},async abort(){parts.length=0;}};}};return {filesystem,published,get opened(){return opened;}};};
const budget={maxResidentBytes:1<<24,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const media=(filesystem:VirtualFileSystem)=>new FFmpeg({filesystem,budget,backend:createMediaBackend({pixelArithmetic:'scalar'})});
const timedStore:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timed=(filesystem:VirtualFileSystem,scheduler:'pull'|'activation'|'producer')=>new FFmpeg({filesystem,budget,backend:createTimedVideoBackend({storage:timedStore,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}})});
const modes=['linear','graph','stream','actor','producer','timed'] as const;
/** -vf, -filter_complex, two-input -filter_complex (replay stream) and the timed backend's activation, producer and pull schedulers. */
async function cli(root:string,chains:readonly string[],scopes:readonly (readonly [readonly string[],readonly string[]])[],sizes:readonly (readonly [number,number])[]):Promise<number>{
 let compared=0;
 for(const format of formats)for(const [width,height]of sizes){
  const input=pattern(format,width,height,4),file=join(root,'in.raw');writeFileSync(file,input);
  for(const filter of chains)for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of scopes)for(const mode of modes){
   const before=[...base,'-pixel_format',format,'-s',`${width}x${height}`],stream=mode==='stream',media_=mode==='linear'||mode==='graph'||stream;
   const graph=stream?`[0:v]${filter}[o];[1:v]nullsink`:`[0:v]${filter}[o]`,after=mode==='linear'?['-vf',filter]:['-filter_complex',graph,'-map','[o]'],tail=[...(media_?[]:['-fps_mode','passthrough','-enc_time_base','filter']),...outputTime,'-c:v','rawvideo','-bitexact','-f',muxer];
   const native=execFileSync(ffmpeg,['-v','error','-nostdin',...single,...before,...inputTime,'-i',file,...(stream?[...before,'-i',file]:[]),...after,...tail,'-'],{timeout:10000});
   const io=memory(new Map([['/in',input]])),engine=media_?media(io.filesystem):timed(io.filesystem,mode==='timed'?'pull':mode==='actor'?'activation':'producer');
   const result=await engine.exec([...before,...inputTime,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...tail,'/out']);expect(result.exitCode,JSON.stringify({format,filter,muxer,mode,inputTime,outputTime,diagnostics:result.diagnostics})).toBe(0);
   expect(Buffer.from(io.published.get('/out')!),`${mode} ${format} ${width}x${height} ${filter} ${muxer} ${inputTime} ${outputTime}`).toEqual(native);compared++;
  }
 }
 return compared;
}
const scopes=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]] as const;
const integerChains=['convolution=0m=0 -1 0 -1 5 -1 0 -1 0:1m=-1 0 1:1mode=row:2m=1 -2 1:2mode=column',`convolution=0m=${m(taps(49,0))}:1m=${m(taps(25,1))}:2m=${m(taps(7,0))}:2mode=row:3m=-1 2 0:3mode=column,hflip`,'convolution=0m=1 1 1 1 1 1 1 1 1:0rdiv=1:1m=0 1 0 1 -4 1 0 1 0,convolution=0m=1 -1 1:0mode=column','transpose=clock,convolution=-1 -1 -1 -1 8 -1 -1 -1 -1'];
it('matches native integer convolution rawvideo and framecrc through the -vf, -filter_complex and timed backend CLIs with and without -ss/-t',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-cli-'));
 try{expect(await cli(root,integerChains,scopes,[[7,5],[17,9]])).toBe(formats.length*2*integerChains.length*2*scopes.length*modes.length);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
const floatChains=['convolution=0m=1 2 1 2 4 2 1 2 1:1m=1 1 1:1mode=row:2m=1 1 1 1 1:2mode=column:3m=0 1 0 0 1 0 0 0 0:3bias=3.5','convolution=0m=0 -1 0 -1 5 -1 0 -1 0:0rdiv=0.3:0bias=20:1m=0 0 0 0 1 0 0 0 1:1bias=2147483647,vflip'];
it.skipIf(!linuxX64)('matches native float convolution through the -vf, -filter_complex and timed backend CLIs on linux-x64',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-float-cli-'));
 try{expect(await cli(root,floatChains,scopes.slice(0,2),[[7,5]])).toBe(formats.length*floatChains.length*2*2*modes.length);}finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native replayed integer convolution branches frame by frame',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-stream-'));let checked=0;
 try{
  for(const format of formats){
   const frameBytes=pixelLayout(format,5,4).bytes,input=pattern(format,5,4,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:5,height:4},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]convolution=0 -1 0 -1 5 -1 0 -1 0[out]','[in]convolution=0m=-1 0 1:0mode=row,hflip[out]','[in]split[x][y];[x]convolution=0m=0 1 0 1 -4 1 0 1 0[l];[y]convolution=0m=1 -2 1:0mode=column:1m=1 -2 1:1mode=column[r];[l][r]hstack[out]',`[in]split[x][y];[x]transpose=clock,convolution=${m(taps(25,1))}[l];[y]nullsink;[l]null[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[null],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    const native=execFileSync(ffmpeg,['-v','error','-nostdin',...single,...base,'-pixel_format',format,'-s','5x4','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-f','rawvideo','-']);
    expect(Buffer.concat(chunks),`${format} ${graph}`).toEqual(native);expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(checked).toBe(24);
},120000);
/** Native refusals: param_init EINVAL for even or non-square counts, the AVOption range check (ERANGE) and unknown options. */
const nativeRefusals=[['convolution=0m=1 2 3 4','EINVAL','number of matrix elements must be odd'],['convolution=0m=','EINVAL','number of matrix elements must be odd'],['convolution=3m=1 1','EINVAL','number of matrix elements must be odd'],['convolution=1m=1 2 3 4 5','EINVAL','Square convolution matrices'],['convolution=0m=1 2 3 4 5 6 7:0mode=square','EINVAL','Square convolution matrices'],[`convolution=2m=${identity(11)}`,'EINVAL','Square convolution matrices'],['convolution=0rdiv=-1','ERANGE','out of range'],['convolution=2bias=3000000000','ERANGE','out of range'],['convolution=0mode=3','ERANGE','Invalid convolution 0mode'],['convolution=planes=1','OPTION','Unsupported convolution option']] as const;
/** Forms native accepts that are refused here before any output: sscanf leftovers, ignored tokens past 49, expressions and the timeline. */
const edgeRefusals=[['convolution=0m=0 0 0 0 1.5 0 0 0 0','decimal integer'],['convolution=0m=0 0 0 0 x 0 0 0 0','decimal integer'],[`convolution=0m=${identity(49)} 7`,'more than 49'],['convolution=0m=1 2 1 2 4 2 1 2 1:0rdiv=1/16','constant decimal'],['convolution=0m=0 0 0 0 4294967296 0 0 0 0','int range'],['convolution=enable=1','timeline']] as const;
it('refuses invalid and unimplemented convolution options on every path before opening outputs, with native statuses for native refusals',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-refuse-'));let refused=0;
 const statuses={EINVAL:(256-constants.errno.EINVAL)&255,ERANGE:(256-constants.errno.ERANGE)&255,OPTION:8};
 try{
  const input=pattern('gray',5,3,2),file=join(root,'in.raw'),before=[...base,'-pixel_format','gray','-s','5x3'];writeFileSync(file,input);
  for(const [filter,status,message]of [...nativeRefusals.map(([filter,status,message])=>[filter,status as string,message] as const),...edgeRefusals.map(([filter,message])=>[filter,'accepted',message] as const)]){
   const native=spawnSync(ffmpeg,['-v','error','-nostdin',...before,'-i',file,'-vf',filter,'-f','rawvideo','-'],{timeout:10000});
   expect(native.status,filter).toBe(status==='accepted'?0:statuses[status as keyof typeof statuses]);if(status==='accepted')expect(native.stdout.length,filter).toBe(30);
   if(message==='number of matrix elements must be odd')expect(native.stderr.toString(),filter).toContain(message);
   expect(()=>compileVideoFilterChain(filter),filter).toThrow(message);expect(()=>compileVideoFilterGraph(`[0:v]${filter}[o]`),filter).toThrow(message);
   for(const mode of ['linear','graph','stream','actor','timed'] as const){
    const io=memory(new Map([['/in',input]])),stream=mode==='stream',after=mode==='linear'?['-vf',filter]:['-filter_complex',stream?`[0:v]${filter}[o];[1:v]nullsink`:`[0:v]${filter}[o]`,'-map','[o]'];
    const engine=mode==='actor'||mode==='timed'?timed(io.filesystem,mode==='timed'?'pull':'activation'):media(io.filesystem);
    const result=await engine.exec([...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...(mode==='actor'||mode==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[]),'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,`${mode} ${filter}`).toBe(1);expect(JSON.stringify(result.diagnostics),`${mode} ${filter}`).toContain(message);expect(io.opened,`${mode} ${filter}`).toBe(0);refused++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(refused).toBe(5*(nativeRefusals.length+edgeRefusals.length));
},120000);
const nullFilters=['convolution=0bias=5','convolution=0m=1 2 1 2 4 2 1 2 1:1m=0 0 0 0 1 0 0 0 0:1rdiv=0.5','convolution=0m=-1 0 1:0mode=row:2bias=1','convolution=3rdiv=2:3bias=1:0m=0 1 0 1 1 1 0 1 0'];
it('refuses processed identity planes whose rdiv or bias clears the copy, where native calls a null filter, before opening outputs on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-convolution-null-'));let refused=0,matched=0;
 try{
  for(const format of formats){
   const input=pattern(format,5,3,2),file=join(root,'in.raw'),before=[...base,'-pixel_format',format,'-s','5x3'],planes=pixelLayout(format,5,3).planes.length;writeFileSync(file,input);
   for(const [n,filter]of nullFilters.entries()){
    const crashes=[0,1,2,3][n]!<planes,native=spawnSync(ffmpeg,['-v','quiet','-nostdin',...single,...before,'-i',file,'-vf',filter,'-f','rawvideo','-'],{timeout:10000}),label=`${format} ${filter}`;
    if(!crashes){expect(native.status,label).toBe(0);const plan=compileVideoFilterChain(filter).plan(format,5,3,{arithmetic:'scalar'}),frames=[0,1].map(i=>decodeRawVideo({streamIndex:0,data:input.slice(i*input.length/2,(i+1)*input.length/2),pts:BigInt(i),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:5,height:3},{maxFrameBytes:4096}));
     expect(Buffer.concat(frames.map(frame=>tight(plan.apply(frame,{maxFrameBytes:4096,maxStateBytes:0})))),label).toEqual(native.stdout);matched++;continue;}
    expect([native.status,native.signal],label).toEqual([null,'SIGSEGV']);
    expect(()=>compileVideoFilterChain(filter).plan(format,5,3),label).toThrow('native calls a null filter');expect(()=>compileVideoFilterGraph(`[0:v]${filter}[o]`).plan({format,width:5,height:3},[null]),label).toThrow('native calls a null filter');
    for(const mode of ['linear','graph','stream','actor','timed'] as const){
     const io=memory(new Map([['/in',input]])),stream=mode==='stream',after=mode==='linear'?['-vf',filter]:['-filter_complex',stream?`[0:v]${filter}[o];[1:v]nullsink`:`[0:v]${filter}[o]`,'-map','[o]'];
     const engine=mode==='actor'||mode==='timed'?timed(io.filesystem,mode==='timed'?'pull':'activation'):media(io.filesystem);
     const result=await engine.exec([...before,'-i','/in',...(stream?[...before,'-i','/in']:[]),...after,...(mode==='actor'||mode==='timed'?['-fps_mode','passthrough','-enc_time_base','filter']:[]),'-c:v','rawvideo','-f','rawvideo','/out']);
     expect(result.exitCode,`${mode} ${label}`).not.toBe(0);expect(JSON.stringify(result.diagnostics),`${mode} ${label}`).toContain('native calls a null filter');expect(io.opened,`${mode} ${label}`).toBe(0);refused++;
    }
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 // Plane 0 crashes in all six formats, planes 1 and 2 in the five with three or four planes, plane 3 in yuva420p only.
 expect([refused,matched]).toEqual([5*(6+5+5+1),4*6-(6+5+5+1)]);
},120000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 reference();
 // The helper runs native with -cpuflags 0 and default threads, where column groups pass the row (see single), so no column mode here.
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 const outcome=await nativeNegotiationOutcome('convolution=0m=0 -1 0 -1 5 -1 0 -1 0:1m=-1 0 1:1mode=row:2m=1 -2 1 -2 4 -2 1 -2 1',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
