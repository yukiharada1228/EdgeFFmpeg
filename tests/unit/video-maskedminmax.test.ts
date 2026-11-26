import {expect,it} from 'vitest';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {maskedMinMaxFrames,maskedMinMaxGeometry,maskedMinMaxPixelFormats,parseMaskedMinMax} from '../../packages/avfilter/src/video-maskedminmax.js';
import type {MaskedMinMaxStep} from '../../packages/avfilter/src/video-maskedminmax.js';
const time={num:1n,den:25n};
const gray=(values:readonly number[],width:number,height:number,stride=width,pts=0n):VideoFrameData=>{const data=new Uint8Array(stride*height).fill(77);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data[y*stride+x]=values[y*width+x]!;return {width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:pts,timeBase:time},metadata:{}};};
const token=(options:string|null)=>({name:'maskedmin',options});
const step=(name:'maskedmin'|'maskedmax',planes=15):MaskedMinMaxStep=>({name,planes,shortest:false});
const budget={maxFrameBytes:1<<12};
it('parses the planes mask, shorthand, expressions and later occurrences into three-input join pads',()=>{
 expect(parseMaskedMinMax('maskedmin',token(null))).toEqual({inputs:3,outputs:1,configuration:{name:'maskedmin',planes:15,shortest:false}});
 for(const [options,planes]of [['5',5],['planes=0',0],['planes=0x3',3],['1:planes=6',6],['planes=2+4',6],['planes=all+16',15],['planes=none',0],['planes=max',15],['planes=2.5',2],['planes=3.5',4]] as const)expect(parseMaskedMinMax('maskedmax',token(options)).configuration.planes,options).toBe(planes);
 expect(Object.isFrozen(parseMaskedMinMax('maskedmin',token('1')).configuration)).toBe(true);
 for(const options of ['16','planes=-1','planes=foo','planes=1/0'])expect(()=>parseMaskedMinMax('maskedmin',token(options)),options).toThrow('Invalid maskedmin planes');
 for(const options of ['shortest=1','eof_action=pass','repeatlast=0','ts_sync_mode=nearest','threads=2'])expect(()=>parseMaskedMinMax('maskedmax',token(options)),options).toThrow('Unsupported maskedmax option');
 expect(()=>parseMaskedMinMax('maskedmin',token('1:2'))).toThrow('Missing filter option name');
 expect(()=>parseMaskedMinMax('maskedmin',token('enable=1'))).toThrow('maskedmin timeline expressions are not implemented');
 expect(maskedMinMaxPixelFormats.length).toBe(60);expect(maskedMinMaxPixelFormats.slice(0,3)).toEqual(['yuva444p','yuv444p','yuv440p']);expect(maskedMinMaxPixelFormats.slice(-3)).toEqual(['grayf32le','gbrpf32le','gbrapf32le']);
 for(const name of ['maskedmin','maskedmax']){const op=videoOperator(name)!;expect(op.role).toBe('join');expect(op.paths).toEqual(['graph','stream','actor','timed']);expect(op.formats!(step(name as 'maskedmin'))).toBe(maskedMinMaxPixelFormats);}
});
it('picks the closer filter per sample with ties keeping filter1 and copies unselected planes from the source into owned tight planes',()=>{
 // source, filter1, filter2: f2 closer, f1 closer, tie (|10-4| == |10-16|), equal filters, extremes.
 const s=[10,10,10,10,0,255],a=[0,12,4,7,255,0],b=[11,30,16,7,1,254];
 const frames=[gray(s,3,2,5),gray(a,3,2,4),gray(b,3,2,3)],before=frames.map(frame=>Uint8Array.from(frame.planes[0]!));
 const min=maskedMinMaxFrames(frames,step('maskedmin'),budget),max=maskedMinMaxFrames(frames,step('maskedmax'),budget);
 expect([...min.planes[0]!]).toEqual([11,12,4,7,1,254]);expect([...max.planes[0]!]).toEqual([0,30,4,7,255,0]);
 expect(min.linesizes).toEqual([3]);expect(min.planes[0]!.buffer).not.toBe(frames[0]!.planes[0]!.buffer);expect(min.pixelFormat).toBe('gray');
 frames.forEach((frame,index)=>expect(frame.planes[0],String(index)).toEqual(before[index]));
 expect([...maskedMinMaxFrames(frames,step('maskedmin',14),budget).planes[0]!]).toEqual(s);
 // Plane bits follow the native plane index: yuv444p 1=Y, 2=U, 4=V.
 const yuv=(values:readonly number[]):VideoFrameData=>({width:1,height:1,pixelFormat:'yuv444p',planes:values.map(value=>Uint8Array.of(value)),linesizes:[1,1,1],pts:{value:3n,timeBase:time},metadata:{lavfi:'x'}});
 const out=maskedMinMaxFrames([yuv([50,60,70]),yuv([40,40,40]),yuv([55,100,71])],step('maskedmin',5),budget);
 expect(out.planes.map(plane=>plane[0])).toEqual([55,60,71]);expect(out.pts).toEqual({value:3n,timeBase:time});expect(out.metadata).toEqual({lavfi:'x'});
 const min64=-(1n<<63n),clamped=maskedMinMaxFrames([0,1,2].map(()=>({...gray([1],1,1),pts:{value:min64,timeBase:time}})),step('maskedmax'),budget);expect(clamped.pts!.value).toBe(min64+1n);
 expect(maskedMinMaxFrames([0,1,2].map(()=>({...gray([1],1,1),pts:null})),step('maskedmax'),budget).pts).toBeNull();
});
it('refuses mismatched geometry, unsupported layouts, budgets, malformed storage, unsynchronized frames and cancellation explicitly',()=>{
 const shape={format:'gray',width:5,height:3};
 expect(maskedMinMaxGeometry('maskedmin',[shape,shape,shape])).toEqual({width:5,height:3});
 expect(()=>maskedMinMaxGeometry('maskedmin',[shape,shape])).toThrow('maskedmin requires three inputs');
 expect(()=>maskedMinMaxGeometry('maskedmax',[shape,shape,{...shape,width:4}])).toThrow('maskedmax input sizes differ');
 expect(()=>maskedMinMaxGeometry('maskedmin',[{...shape,height:2},shape,shape])).toThrow('maskedmin input sizes differ');
 expect(()=>maskedMinMaxGeometry('maskedmin',[shape,{...shape,format:'yuv444p'},shape])).toThrow('maskedmin input formats differ');
 const frame=gray(Array(15).fill(9),5,3),three=[frame,frame,frame];
 expect(()=>maskedMinMaxFrames([frame,frame],step('maskedmin'),budget)).toThrow('maskedmin requires three frames');
 expect(()=>maskedMinMaxFrames([frame,frame,gray(Array(12).fill(1),4,3)],step('maskedmin'),budget)).toThrow('input sizes differ');
 const rgb:VideoFrameData={width:1,height:1,pixelFormat:'rgb24',planes:[new Uint8Array(3)],linesizes:[3],pts:null,metadata:{}};
 expect(()=>maskedMinMaxFrames([rgb,rgb,rgb],step('maskedmin'),budget)).toThrow('maskedmin pixel format is not supported');
 const nv12:VideoFrameData={width:2,height:2,pixelFormat:'nv12',planes:[new Uint8Array(4),new Uint8Array(2)],linesizes:[2,2],pts:null,metadata:{}};
 expect(()=>maskedMinMaxFrames([nv12,nv12,nv12],step('maskedmax'),budget)).toThrow('maskedmax pixel format is not supported');
 for(const maxFrameBytes of [14,0,Number.NaN,2**53])expect(()=>maskedMinMaxFrames(three,step('maskedmin'),{maxFrameBytes}),String(maxFrameBytes)).toThrow('frame exceeds allocation limit');
 expect(()=>maskedMinMaxFrames([frame,frame,gray(Array(15).fill(1),5,3,9)],step('maskedmin'),{maxFrameBytes:20})).toThrow('input storage exceeds frame budget');
 for(const bad of [{...frame,linesizes:[4]},{...frame,linesizes:[1.5]},{...frame,planes:[new Uint8Array(14)]},{...frame,planes:[[1,2,3] as unknown as Uint8Array]}])expect(()=>maskedMinMaxFrames([frame,bad,frame],step('maskedmin'),budget)).toThrow('Invalid maskedmin input storage');
 expect(()=>maskedMinMaxFrames([frame,{...frame,planes:[frame.planes[0]!,frame.planes[0]!]},frame],step('maskedmin'),budget)).toThrow('Invalid maskedmin plane count');
 expect(()=>maskedMinMaxFrames([frame,gray(Array(15).fill(9),5,3,5,1n),frame],step('maskedmax'),budget)).toThrow('maskedmax frames must have synchronized timestamps');
 expect(()=>maskedMinMaxFrames([frame,{...frame,pts:null},frame],step('maskedmax'),budget)).toThrow('synchronized timestamps');
 // 2/50 equals 1/25: equal instants in different time bases are synchronized.
 const at=(value:bigint,den:bigint)=>({...frame,pts:{value,timeBase:{num:1n,den}}});expect(maskedMinMaxFrames([at(1n,25n),at(2n,50n),at(4n,100n)],step('maskedmin'),budget).pts).toEqual({value:1n,timeBase:time});
 expect(()=>maskedMinMaxFrames([frame,{...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},frame],step('maskedmin'),budget)).toThrow('Invalid maskedmin timestamp');
 for(const bad of [{name:'maskedmin',planes:16,shortest:false},{name:'maskedmax',planes:1.5,shortest:false},{name:'limiter',planes:1,shortest:false}])expect(()=>maskedMinMaxFrames(three,bad as MaskedMinMaxStep,budget)).toThrow('Invalid maskedminmax settings');
 const controller=new AbortController();controller.abort();expect(()=>maskedMinMaxFrames(three,step('maskedmin'),{...budget,signal:controller.signal})).toThrow();
});
it('plans maskedmin and maskedmax only as three-input joins, refuses linear chains, enable= and runtime commands, and negotiates one shared format',async()=>{
 for(const name of ['maskedmin','maskedmax']){
  expect(()=>compileVideoFilterChain(name)).toThrow('Unsupported video filter');expect(()=>compileVideoFilterChain(`null,${name}=planes=1`)).toThrow('Unsupported video filter');
  expect(()=>createFrameActors(`split=3[a][b][c];[a][b][c]${name}=enable=1`,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline expressions are not implemented');
  expect(()=>compileVideoFilterGraph(`[0:v]split=3[a][b][c];[a][b][c]${name}=shortest=1[o]`)).toThrow(`Unsupported ${name} option`);
 }
 const plan=compileVideoFilterGraph('[0:v]split=3[a][b][c];[a]hflip[x];[x][b][c]maskedmin[o]').plan({format:'nv12',width:4,height:2},[null],{arithmetic:'scalar'});
 const nv12:VideoFrameData={width:4,height:2,pixelFormat:'nv12',planes:[Uint8Array.of(1,2,3,4,5,6,7,8),Uint8Array.of(128,128,128,128)],linesizes:[4,4],pts:{value:0n,timeBase:time},metadata:{}};
 const [out]=plan.apply(nv12,{maxFrameBytes:1<<12,maxStateBytes:1<<16,maxResidentBytes:1<<20});expect(out!.pixelFormat).toBe('yuv420p');expect([...out!.planes[0]!]).toEqual([1,2,3,4,5,6,7,8]);
 expect(()=>compileVideoFilterGraph('[0:v]split=3[a][b][c];[c]scale=2:2[z];[a][b][z]maskedmax[o]').plan({format:'gray',width:4,height:2},[null],{arithmetic:'scalar'})).toThrow('maskedmax input sizes differ');
 const actors=createFrameActors('split=3[a][b][c];[a]vflip[x];[b][x][c]maskedmax',{maxSteps:256,maxQueuedFrames:4,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:2,height:2}}]});
 try{
  for(const [command,argument]of [['planes','0'],['enable','0']] as const)expect(actors.sendFilterCommand('maskedmax',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:gray([10,20,30,40],2,2)});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);
  // The source and filter2 are the input and filter1 is vflipped [30,40,10,20]: |s-f2| = 0 never exceeds |s-f1| and filter1 wins.
  expect([...result.event!.frame.planes[0]!]).toEqual([30,40,10,20]);
 }finally{actors.dispose();}
});
