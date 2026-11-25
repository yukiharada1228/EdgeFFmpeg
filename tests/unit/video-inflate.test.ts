import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {inflateOperator,inflateVideoFrame,parseInflateOptions,VideoInflateError} from '../../packages/avfilter/src/video-ops/inflate.js';
import type {InflateStep} from '../../packages/avfilter/src/video-ops/inflate.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null):InflateStep=>parseInflateOptions(options);
/** Direct transcription of vf_neighbor.c inflate with its lb/rb border tables. */
function reference(data:Uint8Array,width:number,height:number,threshold:number):number[]{
 const at=(x:number,y:number)=>data[y*width+x]!,out:number[]=[];
 for(let y=0;y<height;y++){const u=y>0?y-1:y,d=y<height-1?y+1:y;for(let x=0;x<width;x++){
  const cols=x===0?[1,0,1,1,1]:x===width-1?[width-2,width-1,width-2,width-2,width-2]:[x-1,x,x+1,x-1,x+1];
  const sum=at(cols[0]!,u)+at(cols[1]!,u)+at(cols[2]!,u)+at(cols[3]!,y)+at(cols[4]!,y)+at(cols[0]!,d)+at(cols[1]!,d)+at(cols[2]!,d),p=at(x,y);
  out.push(threshold?Math.min(Math.max(Math.floor(sum/8),p),Math.min(p+threshold,255)):p);
 }}
 return out;
}
it('parses threshold shorthand, named options, AV_OPT_TYPE_INT expressions and rounding into frozen steps',()=>{
 expect(step(null)).toEqual({name:'inflate',thresholds:[65535,65535,65535,65535]});expect(Object.isFrozen(step(''))).toBe(true);expect(Object.isFrozen(step('1').thresholds)).toBe(true);
 expect(step('1:2:3:4').thresholds).toEqual([1,2,3,4]);expect(step('threshold2=9:threshold0=0').thresholds).toEqual([0,65535,9,65535]);expect(step('7:threshold3=1').thresholds).toEqual([7,65535,65535,1]);
 expect(step('2.5:3.5:max/2:min').thresholds).toEqual([2,4,32768,0]);expect(step('threshold0=default').thresholds[0]).toBe(65535);expect(step('threshold0=none').thresholds[0]).toBe(0);expect(step('threshold1=0x10').thresholds[1]).toBe(16);
 for(const options of ['coordinates=1','bogus=1','threshold4=1','Threshold0=1','threshold0=65536','threshold0=-1','threshold0=all','threshold0=nan','threshold0=','threshold0=1+','1:2:3:4:5','1:threshold0=2:3','enable=1','threads=1','thread_type=slice','extra_hw_frames=1'])expect(()=>step(options),options).toThrow();
 expect(()=>step('bogus=1')).toThrow(VideoFilterParseError);expect(()=>step('bogus=1')).toThrow("Error applying option 'bogus' to filter 'inflate': Option not found");
 expect(()=>step('threshold1=65536')).toThrow("Error applying option 'threshold1' to filter 'inflate': Numerical result out of range");
 expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('threads=2')).toThrow('not implemented');
});
it('registers a frozen frame descriptor flagged on every path with the native pix_fmts in declared order',()=>{
 expect(videoOperator('inflate')).toBe(inflateOperator);expect(Object.isFrozen(inflateOperator)).toBe(true);expect(inflateOperator.role).toBe('frame');
 expect(inflateOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(inflateOperator.timeline).toBeUndefined();expect(inflateOperator.geometryCommands).toBeUndefined();
 // The pinned vf_neighbor.c pix_fmts in declared order.
 expect(inflateOperator.formats!(step(null))).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(inflateOperator.geometry!(step(null),[{format:'yuv420p',width:3,height:1}])).toEqual({width:3,height:1});
 for(const [format,width,options]of [['gray',1,null],['yuv420p',2,null],['yuv422p',1,'0'],['yuva420p',2,'0:0:1'],['gbrp',1,'0:0:1']] as const)expect(()=>inflateOperator.geometry!(step(options),[{format,width,height:4}]),`${format}/${width}/${options}`).toThrow('at least two pixels wide');
 expect(inflateOperator.geometry!(step('0:0:0:0'),[{format:'gray',width:1,height:4}])).toEqual({width:1,height:4});expect(inflateOperator.geometry!(step('4:0:0'),[{format:'yuv420p',width:2,height:4}])).toEqual({width:2,height:4});
 for(const format of ['rgb24','nv12','rgba'])expect(()=>inflateOperator.geometry!(step(null),[{format,width:4,height:4}]),format).toThrow('not supported');
});
it('matches the native kernel transcription on borders, impulses, saturation and every threshold class',()=>{
 let seed=7;const noise=(length:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
 for(const [width,height]of [[2,1],[2,2],[3,1],[5,4],[9,7]] as const)for(const data of [noise(width*height),Uint8Array.from({length:width*height},(_,i)=>i%3?255:250),Uint8Array.from({length:width*height},(_,i)=>i===Math.floor(width*height/2)?255:0)])for(const threshold of [0,1,3,64,255,65535]){
  const actual=inflateVideoFrame(gray(data,width,height),step(String(threshold)),{maxFrameBytes:width*height});expect([...actual.planes[0]!],`${width}x${height}/${threshold}`).toEqual(reference(data,width,height,threshold));
 }
 expect([...inflateVideoFrame(gray(Uint8Array.of(0,0,0,0,200,0,0,0,0),3,3),step('3'),{maxFrameBytes:9}).planes[0]!]).toEqual([3,3,3,3,200,3,3,3,3]);
});
it('filters each plane with its own threshold and copies threshold-zero planes',()=>{
 const width=4,height=4,luma=Uint8Array.from({length:16},(_,i)=>i*15),chroma=Uint8Array.of(0,200,100,0),alpha=Uint8Array.from({length:16},(_,i)=>i&1?255:0);
 const frame:VideoFrameData={width,height,pixelFormat:'yuva420p',planes:[luma,chroma,chroma.slice(),alpha],linesizes:[4,2,2,4],pts:null,metadata:{}};
 const actual=inflateVideoFrame(frame,step('0:5:65535:1'),{maxFrameBytes:40});
 expect([...actual.planes[0]!]).toEqual([...luma]);expect([...actual.planes[1]!]).toEqual(reference(chroma,2,2,5));expect([...actual.planes[2]!]).toEqual(reference(chroma,2,2,65535));expect([...actual.planes[3]!]).toEqual(reference(alpha,4,4,1));
 expect(actual.pts).toBeNull();expect(actual.linesizes).toEqual([4,2,2,4]);
});
it('materializes owned tight planes from padded input without mutating it or changing timestamps and metadata',()=>{
 const input=Uint8Array.of(10,20,30,99,40,50,60,99,70,80,90,99),copy=input.slice(),frame=gray(input,3,3,4),actual=inflateVideoFrame(frame,step(null),{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual(reference(Uint8Array.of(10,20,30,40,50,60,70,80,90),3,3,65535));expect(actual.linesizes).toEqual([3]);expect(actual.planes[0]!.buffer).not.toBe(input.buffer);
 expect(input).toEqual(copy);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect(actual.metadata).not.toBe(frame.metadata);
});
it('enforces frame budgets, plane counts, malformed strides and storage, time bases and filtered width-1 planes',()=>{
 const data=new Uint8Array(12),ok=gray(data,3,4);
 expect(()=>inflateVideoFrame(ok,step(null),{maxFrameBytes:11})).toThrow('allocation limit');expect(()=>inflateVideoFrame(ok,step(null),{maxFrameBytes:0})).toThrow(VideoInflateError);expect(()=>inflateVideoFrame(ok,step(null),{maxFrameBytes:1.5})).toThrow(VideoInflateError);
 expect(()=>inflateVideoFrame(gray(new Uint8Array(40),3,4,10),step(null),{maxFrameBytes:20})).toThrow('storage exceeds allocation limit');
 for(const [stride,length]of [[2,12],[-3,12],[3.5,12],[3,11],[2147483648,12]] as const)expect(()=>inflateVideoFrame(gray(new Uint8Array(length),3,4,stride),step(null),{maxFrameBytes:64}),`${stride}/${length}`).toThrow('stride or storage');
 expect(()=>inflateVideoFrame({...ok,planes:[data,data]},step(null),{maxFrameBytes:64})).toThrow('plane count');expect(()=>inflateVideoFrame({...ok,linesizes:[]},step(null),{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>inflateVideoFrame({...ok,planes:[Array.from(data) as unknown as Uint8Array]},step(null),{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>inflateVideoFrame({...ok,pts:{value:0n,timeBase:{num:0n,den:1n}}},step(null),{maxFrameBytes:64})).toThrow('time base');
 expect(()=>inflateVideoFrame(gray(new Uint8Array(4),1,4),step(null),{maxFrameBytes:64})).toThrow('at least two pixels wide');expect([...inflateVideoFrame(gray(Uint8Array.of(1,2,3,4),1,4),step('0'),{maxFrameBytes:64}).planes[0]!]).toEqual([1,2,3,4]);
 expect(()=>inflateVideoFrame({...ok,pixelFormat:'rgb24',planes:[new Uint8Array(36)],linesizes:[9]},step(null),{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>inflateVideoFrame(ok,{name:'inflate',thresholds:[1,2,3] as unknown as InflateStep['thresholds']},{maxFrameBytes:64})).toThrow('settings');
});
it('observes AbortSignal before and during row processing',()=>{
 const aborted=new AbortController();aborted.abort(new Error('stop early'));expect(()=>inflateVideoFrame(gray(new Uint8Array(4),2,2),step(null),{maxFrameBytes:4,signal:aborted.signal})).toThrow('stop early');
 let reads=0;const late=new AbortController(),signal=new Proxy(late.signal,{get(target,key){if(key==='throwIfAborted')return ()=>{if(++reads===3)late.abort(new Error('stop late'));target.throwIfAborted();};const value=Reflect.get(target,key) as unknown;return typeof value==='function'?(value as (...args:unknown[])=>unknown).bind(target):value;}});
 expect(()=>inflateVideoFrame(gray(new Uint8Array(32),4,8),step(null),{maxFrameBytes:32,signal})).toThrow('stop late');
});
it('compiles linear chains and frame graphs, refusing width-1 planes at plan time',()=>{
 const plan=compileVideoFilterChain('inflate=4').plan('gray',3,2,{arithmetic:'scalar'});expect(plan.stages.map(stage=>stage.operation)).toEqual(['inflate']);
 expect(()=>compileVideoFilterChain('inflate').plan('gray',1,2,{arithmetic:'scalar'})).toThrow('at least two pixels wide');
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-inflate.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('inflate').plan(source,5,3),source).toThrow('Video filter inflate input negotiates gbrap, which is not implemented');expect(()=>compileVideoFilterChain('inflate').plan('yuv420p',2,2,{arithmetic:'scalar'})).toThrow('at least two pixels wide');
 expect(()=>compileVideoFilterChain('inflate=bogus=1')).toThrow('Option not found');expect(()=>compileVideoFilterChain('inflate=enable=1')).toThrow('timeline');
 expect(()=>compileVideoFilterGraph('[in]inflate=threshold9=1[out]')).toThrow('Option not found');
});
