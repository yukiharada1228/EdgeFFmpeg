import {expect,it} from 'vitest';
import {execFile,execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {runBoundedCases} from '../helpers/native-oracle.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),packed=['rgba','bgra','argb','abgr'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** do_colorkey_pixel's double r*scale-c and squared sum may be fused on macOS arm64; the soft-blend cases are gated to the x86-64 baseline. */
const linuxX64=process.platform==='linux'&&process.arch==='x64';
/** Native at test time: the sandbox build need not reproduce the pinned binary, so only its provenance is asserted. */
function reference():void{
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Per pixel: LCG noise, ramps, the key colour exactly, the key colour nudged by a few levels, or a constant; alpha is noise. */
function pattern(format:string,width:number,height:number,frames:number,salt:number,key:readonly number[]):Uint8Array{
 const bytes=pixelLayout(format,width,height).bytes,data=new Uint8Array(bytes*frames);let seed=salt*7919+17;const next=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)>>>24;
 for(let n=0;n<frames;n++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const kind=next()%6,base=n*bytes+(y*width+x)*4,value=(c:number)=>kind===0?next():kind===1?(x*37+y*11+c*53+n*7)&255:kind===2?key[c]!:kind===3?Math.max(0,Math.min(255,key[c]!+(next()%9)-4)):kind===4?(x+y)%2?255:0:128;
  for(let c=0;c<4;c++)data[base+c]=c===3&&kind!==4?next():value(c);
 }
 return data;
}
const keys:Readonly<Record<string,readonly number[]>>={black:[0,0,0],green:[0,128,0],'0x336699@0.5':[0x33,0x66,0x99],white:[255,255,255]};
const frameOf=(data:Uint8Array,format:string,width:number,height:number,n:number)=>{const size=pixelLayout(format,width,height).bytes;return decodeRawVideo({streamIndex:0,data:data.slice(n*size,(n+1)*size),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<20});};
const nativeRun=(args:readonly string[],signal:AbortSignal)=>new Promise<Buffer>((done,fail)=>{execFile(ffmpeg,['-v','error','-cpuflags','0',...args],{encoding:'buffer',maxBuffer:1<<22,signal},(error,stdout,stderr)=>{if(error)fail(new Error(`${args.join(' ')}: ${stderr.toString()}`));else done(stdout);});});
/** Every case keys three frames through compileVideoFilterChain and compares rawvideo bytes and timestamps with native -vf. */
async function kernelCases(root:string,descriptions:readonly (readonly [string,string])[],formats:readonly string[],shapes:readonly (readonly [number,number])[],signal:AbortSignal):Promise<number>{
 const cases=formats.flatMap(format=>shapes.flatMap(([width,height])=>descriptions.map(([key,description])=>({format,width,height,key,description}))));
 return runBoundedCases(cases,4,signal,async({format,width,height,key,description},caseSignal)=>{
  const input=pattern(format,width,height,3,width*31+height+description.length,keys[key]!),file=join(root,`${format}-${width}x${height}-${description.replace(/[^a-z0-9]/gi,'_')}.raw`);writeFileSync(file,input);
  const native=await nativeRun(['-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'],caseSignal);
  const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),label=`${format}/${width}x${height}/${description}`;expect(plan.pixelFormat,label).toBe(format);
  const actual=Buffer.concat([0,1,2].flatMap(n=>{const frame=frameOf(input,format,width,height,n),output=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});expect(output.pts,label).toEqual(frame.pts);return output.planes;}));
  expect(actual,label).toEqual(native);
 });
}
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
/** -vf on the media backend (linear) and the timed backend's producer (actor) and pull (timed) schedulers, with and without -ss/-t, in rawvideo and framecrc. */
async function cliCases(root:string,sources:readonly string[],descriptions:readonly string[],key:string):Promise<number>{
 let count=0;
 for(const source of sources){
  const input=pattern(source==='rgba'||source==='bgra'||source==='argb'||source==='abgr'?source:'rgba',7,5,4,source.length*13,keys[key]!).subarray(0,pixelLayout(source,7,5).bytes*4),files=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
  for(const description of descriptions)for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']]] as const)for(const [path,backend]of [['linear',media],['actor',()=>timed('producer')],['timed',()=>timed('pull')]] as const){
   const before=['-f','rawvideo','-pixel_format',source,'-video_size','7x5','-framerate','25',...inputTime],after=['-vf',description,...outputTime,...(path==='linear'?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',format];
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
   const result=await frontend(files,backend(),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']),label=`${source}/${description}/${format}/${inputTime.join(' ')}/${path}`;
   expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
  }
 }
 return count;
}
/** -filter_complex with two outputs on the media backend (graph path). */
async function graphCases(root:string,sources:readonly string[],descriptions:readonly string[],key:string):Promise<number>{
 let count=0;
 for(const source of sources){
  const input=pattern('rgba',5,3,3,source.length+7,keys[key]!).subarray(0,pixelLayout(source,5,3).bytes*3),files=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
  for(const description of descriptions)for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.04','-frames:v','1']]){
   const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,...time,'-bitexact','-f',format,prefix+index+'.out']);
   execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
   const result=await frontend(files,media(),path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);const label=`${source}/${description}/${format}/${time.join(' ')}`;
   expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);
   for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
  }
 }
 return count;
}
/** createReplayVideoExecution with branches and joins, compared frame by frame with native -filter_complex. */
async function streamCases(root:string,sources:readonly (readonly [string,string|null])[],graphs:readonly string[],key:string):Promise<number>{
 let count=0;
 for(const [source,target]of sources){
  const frameBytes=pixelLayout(source,5,3).bytes,input=pattern('rgba',5,3,3,frameBytes,keys[key]!).subarray(0,frameBytes*3),file=join(root,'input.raw');writeFileSync(file,input);
  const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield frameOf(input,source,5,3,index);}}};}};
  for(const graph of graphs){
   const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
   try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
   execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
   expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);count++;
  }
 }
 return count;
}
const hard=(name:string)=>(['black','green','0x336699@0.5'] as const).flatMap(color=>['0.00001','0.01','0.1','0.3','0.5','1'].map(similarity=>[color,`${name}=color=${color}:similarity=${similarity}`] as const));
const soft=(name:string)=>(['black','green','0x336699@0.5'] as const).flatMap(color=>['0.01','0.1','0.5'].flatMap(similarity=>['0.00005','0.2','0.5','1'].map(blend=>[color,`${name}=${color}:${similarity}:${blend}`] as const)));
it('matches native colorkey and colorhold hard keys across packed RGBA orders, sizes and patterns',async({signal})=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-hard-'));
 try{
  const count=await kernelCases(root,[...hard('colorkey'),...hard('colorhold'),['black','colorkey'],['black','colorhold']],packed,sizes,signal);
  expect(count).toBe(4*6*38);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it.skipIf(!linuxX64)('matches native colorkey and colorhold soft blends across packed RGBA orders and every path on linux-x64',async({signal})=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-soft-'));
 try{
  const kernel=await kernelCases(root,[...soft('colorkey'),...soft('colorhold')],packed,[[1,1],[5,3],[17,9]],signal);
  const cli=await cliCases(root,['rgba','abgr','yuv420p'],['colorkey=0x336699@0.5:0.2:0.5','hflip,colorhold=green:0.1:0.3,vflip'],'0x336699@0.5');
  const graph=await graphCases(root,['bgra','gray'],['[0:v]split[a][b];[a]colorkey=black:0.05:0.7[left];[b]colorhold=white:0.4:0.25,hflip[right]'],'white');
  const stream=await streamCases(root,[['argb',null],['yuv444p','rgba']],['[in]split[x][y];[x]colorkey=green:0.2:0.4[l];[y]colorhold=0x336699:0.3:1[r];[l][r]hstack[out]'],'green');
  // Distances from black where the float iblend = 1.f/blend truncates one level above the double reciprocal.
  const boundary=[[119,118,242],[167,148,242],[188,170,236],[212,212,242],[7,5,67],[11,1,119],[14,10,134],[13,7,73],[26,14,146],[5,1,161]];let edges=0;
  for(const format of packed)for(const name of ['colorkey','colorhold'])for(const [similarity,blend]of [['0.01','0.9'],['0.05','0.9'],['0.1','0.9'],['0.2','0.9'],['0.1','0.7'],['0.2','0.7']]){
   const order={rgba:[0,1,2,3],bgra:[2,1,0,3],argb:[1,2,3,0],abgr:[3,2,1,0]}[format],input=new Uint8Array(boundary.length*4),description=`${name}=black:${similarity}:${blend}`,label=`${format}/${description}`;
   boundary.forEach((pixel,index)=>{for(let c=0;c<3;c++)input[index*4+order[c]!]=pixel[c]!;input[index*4+order[3]!]=77;});writeFileSync(join(root,'boundary.raw'),input);
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${boundary.length}x1`,'-i',join(root,'boundary.raw'),'-vf',description,'-f','rawvideo','-']);
   const plan=compileVideoFilterChain(description).plan(format,boundary.length,1,{arithmetic:'scalar'});expect(Buffer.from(plan.apply(frameOf(input,format,boundary.length,1,0),{maxFrameBytes:4096,maxStateBytes:0}).planes[0]!),label).toEqual(native);edges++;
  }
  expect([kernel,cli,graph,stream,edges]).toEqual([4*3*72,3*2*2*2*3,2*1*2*2,2,48]);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native colorkey and colorhold CLI rawvideo and framecrc on the linear, actor and timed paths, including implicit conversions',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-cli-'));
 try{
  const count=await cliCases(root,['rgba','bgra','argb','abgr','yuv420p','rgb24','gray'],['colorkey','colorkey=green:0.3','colorhold=0x336699@0.5:0.4','hflip,colorkey=white:0.6,vflip'],'green');
  expect(count).toBe(7*4*2*2*3);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native colorkey and colorhold filter_complex branches on the graph path in rawvideo and framecrc',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-graph-'));
 try{
  const count=await graphCases(root,['rgba','argb','yuva420p','gbrp'],['[0:v]split[a][b];[a]colorkey=white:0.3[left];[b]colorhold=black:0.2,hflip[right]','[0:v]colorkey=0x336699@0.5:0.15,split[left][right]'],'white');
  expect(count).toBe(4*2*2*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native colorkey and colorhold on the stream path through replay execution and the multi-input CLI',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-stream-'));
 try{
  let count=await streamCases(root,[['rgba',null],['abgr','abgr'],['yuv420p','bgra']],['[in]colorkey=green:0.2[out]','[in]split[x][y];[x]colorkey=black:0.4[l];[y]colorhold=white:0.5,hflip[r];[l][r]hstack[out]'],'green');
  const left=pattern('rgba',5,3,3,3,keys.black!),right=pattern('bgra',5,3,3,4,keys.white!),files=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(source:string,path:string)=>['-f','rawvideo','-pixel_format',source,'-s','5x3','-i',path],after=['-filter_complex','[0:v]colorkey=black:0.3[a];[1:v]colorhold=white:0.2,vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input('rgba',join(root,'a.raw')),...input('bgra',join(root,'b.raw')),...after,'-']),sink=collectingOutput();
   const result=await frontend(files,media(),()=>sink.output).exec([...input('rgba','/a'),...input('bgra','/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(native);count++;
  }
  expect(count).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for invalid colours and out-of-range floats, and refuses enable= and random colours, before opening any output on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-colorkey-reject-'));let count=0;
 try{
  const input=pattern('rgba',5,3,2,1,keys.black!),files=new Map([['/in',input],['/b',input]]);writeFileSync(join(root,'input.raw'),input);
  const source=(path:string)=>['-f','rawvideo','-pixel_format','rgba','-video_size','5x3','-framerate','25','-i',path];
  // Native AVERROR(EINVAL) and AVERROR(ERANGE) exit statuses on this host; EdgeFFmpeg filter parse failures exit 1 (see docs/contributing/colorkey.md).
  const EINVAL=256-constants.errno.EINVAL,ERANGE=256-constants.errno.ERANGE;
  const cases:readonly (readonly [string,string,number|null,string,readonly string[],ExecutionBackend])[]=[
   ['linear','colorkey=nocolor',EINVAL,"Cannot find color 'nocolor'",['-f','rawvideo','OUT0'],media()],
   ['linear','hflip,colorhold=similarity=2',ERANGE,"Value 2.000000 for parameter 'similarity' out of range [1e-05 - 1]",['-f','framecrc','OUT0'],media()],
   ['graph','colorkey=blend=-1',ERANGE,"Value -1.000000 for parameter 'blend' out of range [0 - 1]",['-f','rawvideo','OUT0'],media()],
   ['stream','colorhold=0x12345',EINVAL,"Invalid 0xRRGGBB[AA] color string: '12345'",['-f','rawvideo','OUT0'],media()],
   ['actor','colorkey=similarity=0',ERANGE,'out of range [1e-05 - 1]',['-c:v','rawvideo','-f','framecrc','OUT0'],timed('producer')],
   ['timed','colorhold=blend=1.5',ERANGE,'out of range [0 - 1]',['-c:v','rawvideo','-f','framecrc','OUT0'],timed('pull')],
   ['linear','colorkey=enable=gte(t\\,0)',null,'timeline expressions are not implemented',['-f','rawvideo','OUT0'],media()],
   ['timed','colorhold=color=random',null,'Unsupported colorhold color',['-c:v','rawvideo','-f','framecrc','OUT0'],timed('pull')],
  ];
  for(const [path,vf,status,message,after,backend]of cases){
   const filter=path==='graph'?['-filter_complex',`[0:v]split[a][b];[a]${vf}[l];[b]null[r]`,'-map','[l]',...after,'-map','[r]','-f','rawvideo','OUT1']:path==='stream'?['-filter_complex',`[0:v]${vf}[a];[1:v]null[b];[a][b]hstack[out]`,'-map','[out]',...after]:['-vf',vf,...after];
   const inputs=(file:string,second:string)=>path==='stream'?[...source(file),...source(second)]:source(file),label=`${path}/${vf}`;
   if(status!==null){const native=spawnSync(ffmpeg,['-y','-v','error',...inputs(join(root,'input.raw'),join(root,'input.raw')),...filter.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,label).toBe(status);expect(native.stderr.toString(),label).toContain(message);for(const name of ['OUT0','OUT1'])expect(existsSync(join(root,name)),label).toBe(false);}
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...inputs('/in','/b'),...filter.map(value=>value.startsWith('OUT')?'/'+value:value)]);
   expect(result.exitCode,label).toBe(1);expect(opened,label).toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message);count++;
  }
  expect(count).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does for colorkey and colorhold and runs byte-exact on every path',async({signal})=>{
 reference();
 const argb=Object.fromEntries(negotiationSources.map(source=>[source,(packed as readonly string[]).includes(source)?source:'argb']));
 for(const vf of ['colorkey','colorhold=green:0.3']){const outcome=await nativeNegotiationOutcome(vf,negotiationSources,signal);expect(outcome.refused,vf).toEqual({});expect(outcome.matched,vf).toEqual(argb);expect(outcome.checks,vf).toBe(14*5+3);}
},180000);
