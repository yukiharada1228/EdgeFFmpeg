import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv444p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Native runs at test time from the local reference build: the pinned commit with x86 assembly disabled, never a pinned binary digest. */
const reference=()=>{const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};expect(metadata.commit).toMatch(/^946fcce0/);expect(metadata.flags).toContain('--disable-x86asm');};
const lcg=(seed:number)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
const kinds=['blocks','rings','constant','sparse','noise','ramp'] as const;
/** Structured regions per pixel: 2x2 checker blocks (diagonal-only contact), concentric rings (holes), a constant plane, two-value
 * noise (many components), full noise and ramps. Planes after the first flip about one sample in five, so every plane must match. */
function sample(kind:typeof kinds[number],x:number,y:number,w:number,h:number,frame:number,random:()=>number):number{
 switch(kind){
  case 'blocks':return ((x+frame>>1)+(y>>1))&1?7:200;
  case 'rings':return Math.min(x,y,w-1-x,h-1-y)+frame&1?9:50;
  case 'constant':return 7;
  case 'sparse':return random()<96?0:7;
  case 'noise':return random();
  case 'ramp':return (x*3+y*5+frame)&255;
 }
}
function planar(format:string,width:number,height:number,kind:typeof kinds[number],frames:number,salt:number):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames),random=lcg(salt*7919+width*31+height);
 for(let frame=0;frame<frames;frame++)for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  let value=sample(kind,x,y,width,height,frame,random);if(index>0&&kind!=='constant'&&random()<51)value^=1;
  data[frame*layout.bytes+plane.offset+y*plane.rowBytes+x]=value;
 }
 return data;
}
/** Any layout, packed ones included: each byte takes the block pattern of its pixel, one byte in six perturbed. */
function packed(format:string,width:number,height:number,frames:number,salt:number):Uint8Array{
 const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes*frames),random=lcg(salt);
 for(let frame=0;frame<frames;frame++)for(const plane of layout.planes)for(let y=0;y<plane.height;y++)for(let b=0;b<plane.rowBytes;b++){
  const x=Math.floor(b*plane.width/plane.rowBytes);data[frame*layout.bytes+plane.offset+y*plane.rowBytes+b]=random()<43?random():((x+frame>>1)+(y>>1))&1?7:200;
 }
 return data;
}
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const all='s0=-1:s1=-1:s2=-1';
/** Seeds at the origin, the far corner, the centre and a top-right edge; picked and fixed sources; truncated destinations; seeds
 * outside the frame; the S == d pass-through; and d0=256 over a picked 0 or d=263 over a picked 7, which native never finishes on a
 * region of two or more pixels (it crashes) and finishes unchanged on a lone pixel. */
const descriptions=(w:number,h:number)=>[`floodfill=${all}:d0=1:d1=2:d2=3`,`floodfill=x=${w-1}:y=${h-1}:${all}:d0=250:d1=128:d2=7`,`floodfill=x=${w>>1}:y=${h>>1}:${all}:s3=-1:d0=300:d1=0:d2=511`,'floodfill=s0=7:s1=7:s2=7:d0=99:d1=98:d2=97','floodfill=0:0:200:-1:200:0:0:0:0',`floodfill=x=${w}:s0=-1:d0=1`,`floodfill=y=${h}:${all}:d0=1`,'floodfill=x=65535:y=65535:s0=-1:d0=9','floodfill',`floodfill=x=${w-1}:y=0:${all}:d0=0:d1=0:d2=0`,`floodfill=x=${w>>1}:s0=-1:s1=-1:s2=-1:d0=256:d1=256:d2=256`,`floodfill=x=${w>>1}:y=${h>>1}:${all}:d0=263:d1=263:d2=263`];
it('matches native linear floodfill seeds, regions and pass-through cases across every executable format, size and pattern',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-floodfill-linear-'));let accepted=0,refused=0,hung=0;
 try{
  for(const format of formats)for(const [width,height]of sizes)for(const kind of kinds){
   const frameBytes=pixelLayout(format,width,height).bytes,input=planar(format,width,height,kind,3,kinds.indexOf(kind)+width),file=join(root,'input.raw');writeFileSync(file,input);
   const frames=[0,1,2].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}));
   for(const description of descriptions(width,height)){
    const label=`${format}/${width}x${height}/${kind}/${description}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'],{timeout:2000,killSignal:'SIGKILL'});
    // Native either crashes or spins forever (ignoring SIGTERM) on a never-terminating fill; both count as a native failure.
    const failed=native.status!==0;if(native.error){expect(native.signal,label).toBe('SIGKILL');hung++;}
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});expect(plan.pixelFormat,label).toBe(format);
    let actual:Buffer|null=null;try{actual=Buffer.concat(frames.flatMap(frame=>plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes));}catch(error){expect((error as Error).message,label).toContain('native never terminates');}
    expect(actual!==null,label).toBe(!failed);
    if(actual){expect(actual,label).toEqual(native.stdout);accepted++;}else refused++;
   }
  }
  // How native fails (a crash or a SIGKILLed spin) depends on its heap layout, so only the split is pinned.
  expect([accepted,refused]).toEqual([1261,35]);expect(hung).toBeLessThanOrEqual(refused);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native floodfill CLI rawvideo and framecrc on the linear path with seeking, including implicit conversions',async()=>{
 reference();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuv444p',7,5],['gbrp',8,6],['rgb24',5,3],['bgr24',17,9],['yuv420p',8,6],['nv12',6,4]] as const){
  const input=packed(source,width,height,4,width*height),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-floodfill-cli-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of [`floodfill=${all}:d0=1:d1=2:d2=3`,`floodfill=x=${width-1}:y=${height-1}:${all}:d0=40,hflip`,'vflip,floodfill=x=2:y=1:s0=-1:s1=-1:s2=-1:d0=300:d1=301:d2=302'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],after=['-vf',description,...outputTime!,'-bitexact','-f',format],native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,...inputTime!,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...before,...inputTime!,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${inputTime}/${outputTime}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(126);
},180000);
it('matches native floodfill filter_complex branches on the graph path in rawvideo and framecrc',async()=>{
 reference();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuv444p',7,5],['gbrp',17,9],['nv12',6,4]] as const){
  const input=packed(source,width,height,3,width+7),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-floodfill-graph-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of [`[0:v]split[a][b];[a]floodfill=${all}:d0=1[left];[b]hflip,floodfill=x=1:y=1:${all}:d0=9:d1=8:d2=7[right]`,`[0:v]floodfill=x=${width-1}:${all}:d0=33,split[left][right]`])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontend(files,media(),path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);const label=`${source}/${description}/${format}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(16);
},120000);
it('matches native floodfill on the stream path through replay execution and the multi-input CLI',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-floodfill-stream-'));let checked=0;
 try{
  for(const [source,target]of [['gray',null],['gbrp','gbrp'],['yuv444p','yuv444p']] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=planar(source,5,3,'blocks',3,frameBytes),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of [`[in]floodfill=${all}:d0=1:d1=2:d2=3[out]`,`[in]split[x][y];[x]floodfill=x=4:y=2:${all}:d0=60[l];[y]hflip,floodfill=x=2:y=1:${all}:d1=9[r];[l][r]hstack[out]`]){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  const left=planar('gray',5,3,'rings',3,3),right=planar('gray',5,3,'sparse',3,4),files=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(path:string)=>['-f','rawvideo','-pixel_format','gray','-s','5x3','-i',path],after=['-filter_complex','[0:v]floodfill=x=2:y=1:s0=-1:d0=1[a];[1:v]floodfill=s0=-1:d0=99,vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input(join(root,'a.raw')),...input(join(root,'b.raw')),...after,'-']),sink=collectingOutput();
   const result=await frontend(files,media(),()=>sink.output).exec([...input('/a'),...input('/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(native);checked++;
  }
  expect(checked).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native floodfill through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-floodfill-timed-'));let count=0;
 try{
  for(const [source,width,height]of [['gray',5,3],['yuv444p',7,5],['gbrp',8,6]] as const){
   const input=planar(source,width,height,'blocks',3,width*31),files=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
   for(const description of [`floodfill=${all}:d0=1:d1=2:d2=3`,`floodfill=x=${width-1}:y=${height-1}:${all}:d0=300,hflip`])for(const format of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-vf',description,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format];
    const native=execFileSync(ffmpeg,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${scheduler}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for out-of-range floodfill options before opening any output on every path',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-floodfill-reject-'));let count=0;
 try{
  const input=planar('gray',5,3,'blocks',2,1),files=new Map([['/in',input],['/b',input]]);writeFileSync(join(root,'input.raw'),input);
  const source=(path:string)=>['-f','rawvideo','-pixel_format','gray','-video_size','5x3','-framerate','25','-i',path];
  const cases:readonly (readonly [string,string,readonly string[],ExecutionBackend])[]=[
   ['linear','Invalid floodfill x',['-vf','floodfill=x=65536','-f','rawvideo','OUT0'],media()],
   ['linear-chain','Invalid floodfill s0',['-vf','hflip,floodfill=s0=-2','-f','framecrc','OUT0'],media()],
   ['graph','Invalid floodfill d3',['-filter_complex','[0:v]split[a][b];[a]floodfill=d3=65536[l];[b]null[r]','-map','[l]','-f','rawvideo','OUT0','-map','[r]','-f','rawvideo','OUT1'],media()],
   ['stream','Invalid floodfill y',['-filter_complex','[0:v]floodfill=y=-1[a];[1:v]null[b];[a][b]hstack[out]','-map','[out]','-f','rawvideo','OUT0'],media()],
   ['actor','Invalid floodfill d0',['-vf','floodfill=d0=-1','-c:v','rawvideo','-f','framecrc','OUT0'],timed('producer')],
   ['timed','Invalid floodfill s3',['-vf','floodfill=s3=70000','-c:v','rawvideo','-f','framecrc','OUT0'],timed('pull')],
  ];
  for(const [path,message,after,backend]of cases){
   const inputs=path==='stream'?[...source(join(root,'input.raw')),...source(join(root,'input.raw'))]:source(join(root,'input.raw'));
   const native=spawnSync(ffmpeg,['-y','-v','error',...inputs,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,path).not.toBe(0);expect(native.stderr.toString(),path).toContain('out of range');
   for(const name of ['OUT0','OUT1'])expect(existsSync(join(root,name)),path).toBe(false);
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...(path==='stream'?[...source('/in'),...source('/b')]:source('/in')),...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
   expect(result.exitCode,path).not.toBe(0);expect(opened,path).toBe(0);expect(JSON.stringify(result.diagnostics),path).toContain(message);count++;
  }
  expect(count).toBe(6);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the yuva444p and gbrap picks before output on every path',async({signal})=>{
 reference();
 const outcome=await nativeNegotiationOutcome(`floodfill=x=1:y=1:${all}:d0=1:d1=2:d2=3`,negotiationSources,signal);
 // Native converts yuva420p to yuva444p and packed RGB with alpha to gbrap, which have no frame storage here: refused by name on every
 // path and CLI backend. Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap',yuva420p:'yuva444p'});
 expect(outcome.matched).toEqual({yuv420p:'yuv444p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv444p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv444p',nv21:'yuv444p',gbrp:'gbrp',yuvj420p:'yuv444p',yuvj422p:'yuv444p',yuvj444p:'yuv444p'});
 expect(outcome.checks).toBe(93);
},120000);
