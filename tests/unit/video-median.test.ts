import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {medianOperator,medianPixelFormats} from '../../packages/avfilter/src/video-ops/median.js';
import {medianPlan,medianVideoFrame,parseMedianOptions,VideoMedianError} from '../../packages/avfilter/src/video-median.js';
import type {VideoMedianSettings} from '../../packages/avfilter/src/video-median.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const defaults=parseMedianOptions(null),time={num:1n,den:25n};
/** Sorted clamped (2r+1)x(2rv+1) window, element t: what the coarse/fine search selects. */
function brute(src:Uint8Array,w:number,h:number,r:number,rv:number,t:number):number[]{
 const out:number[]=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++){const values:number[]=[];for(let dy=-rv;dy<=rv;dy++)for(let dx=-r;dx<=r;dx++)values.push(src[Math.min(h-1,Math.max(0,y+dy))*w+Math.min(w-1,Math.max(0,x+dx))]!);values.sort((a,b)=>a-b);out.push(values[t]!);}return out;
}
it('parses native defaults, shorthand order, ranges, integer expressions and the float percentile into frozen steps',()=>{
 expect(defaults).toEqual({radius:1,planes:15,radiusV:0,percentile:0.5});expect(Object.isFrozen(defaults)).toBe(true);expect(parseMedianOptions('')).toEqual(defaults);
 expect(parseMedianOptions('3:5:2:0.25')).toEqual({radius:3,planes:5,radiusV:2,percentile:0.25});expect(parseMedianOptions('7')).toEqual({...defaults,radius:7});
 expect(parseMedianOptions('percentile=0.3:radiusV=1+2:radius=max:planes=1.5')).toEqual({radius:127,planes:2,radiusV:3,percentile:Math.fround(0.3)});expect(parseMedianOptions('percentile=0.3').percentile).not.toBe(0.3);
 expect(parseMedianOptions('radius=min:planes=default:radiusV=max:percentile=1')).toEqual({radius:1,planes:15,radiusV:127,percentile:1});expect(parseMedianOptions('percentile=1e-1:planes=0').percentile).toBe(Math.fround(0.1));
 for(const options of ['radius=0','radius=128','planes=16','planes=-1','radiusV=128','radiusV=-1','percentile=1.01','percentile=-0.1','percentile=1/2','percentile=','radius=','radius=abc','enable=1','threads=1','foo=1','1:2:3:0.5:9','radius=2:7'])expect(()=>parseMedianOptions(options),options).toThrow();
 expect(()=>parseMedianOptions('enable=gte(t,1)')).toThrow(VideoFilterParseError);expect(()=>parseMedianOptions('enable=1')).toThrow('timeline');expect(()=>parseMedianOptions('radius=0')).toThrow('Invalid median radius');expect(()=>parseMedianOptions('percentile=2')).toThrow('Invalid median percentile');expect(()=>parseMedianOptions('percentile=PI')).toThrow('decimal');
 expect(videoOperator('median')).toBe(medianOperator);expect(medianOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(medianOperator.timeline).toBeUndefined();expect(medianOperator.geometryCommands).toBeUndefined();
 // The pinned vf_median.c pix_fmts in declared order.
 expect(medianPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p gbrp gbrap gray gray9le yuv420p9le yuv422p9le yuv444p9le gbrp9le yuva420p9le yuva422p9le yuva444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le gray10le gray12le gray14le gray16le'.split(' '));
 expect(Object.isFrozen(medianPixelFormats)).toBe(true);expect(medianOperator.formats!({name:'median',...defaults})).toBe(medianPixelFormats);
});
it('clips the radii to filtered planes and truncates the float threshold as config_input does',()=>{
 const plan=(format:string,width:number,height:number,settings:Partial<VideoMedianSettings>)=>{const {radius,radiusV,threshold,filtered}=medianPlan(format,width,height,{...defaults,...settings});return {radius,radiusV,threshold,filtered};};
 expect(plan('gray',8,8,{})).toEqual({radius:1,radiusV:1,threshold:4,filtered:[true]});expect(plan('gray',8,8,{percentile:1})).toEqual({radius:1,radiusV:1,threshold:8,filtered:[true]});expect(plan('gray',8,8,{percentile:0})).toMatchObject({threshold:0});
 expect(plan('gray',1,1,{radius:127,radiusV:127})).toEqual({radius:0,radiusV:0,threshold:0,filtered:[true]});expect(plan('gray',2,9,{radius:5})).toEqual({radius:0,radiusV:4,threshold:4,filtered:[true]});
 // Chroma planes clip the shared radii only when filtered.
 expect(plan('yuv420p',9,9,{radius:4})).toEqual({radius:2,radiusV:2,threshold:12,filtered:[true,true,true]});expect(plan('yuv420p',9,9,{radius:4,planes:1})).toEqual({radius:4,radiusV:4,threshold:40,filtered:[true,false,false]});
 expect(plan('yuva420p',5,3,{radius:3,radiusV:2,planes:8})).toEqual({radius:2,radiusV:1,threshold:7,filtered:[false,false,false,true]});expect(plan('gbrp',4,4,{planes:0,radius:9})).toEqual({radius:9,radiusV:9,threshold:180,filtered:[false,false,false]});
 // ((2r+1)(2rv+1)-1) * 2.f * percentile in float, then truncated: 0.3 rounds below 3/10 here.
 expect(plan('gray',9,9,{radius:2,radiusV:1,percentile:Math.fround(0.3)}).threshold).toBe(4);expect(plan('gray',99,99,{radius:2,radiusV:3,percentile:Math.fround(0.7)}).threshold).toBe(23);
 expect(medianOperator.geometry!({name:'median',...defaults},[{format:'yuv420p',width:1,height:1}])).toEqual({width:1,height:1});expect(()=>medianOperator.geometry!({name:'median',...defaults},[])).toThrow('one input');
 expect(()=>medianPlan('gray',65534,1,defaults)).toThrow('wider');expect(medianPlan('gray',65533,1,defaults).radius).toBe(1);expect(medianPlan('gray',65534,1,{...defaults,planes:0}).filtered).toEqual([false]);
});
it('selects the clamped window order statistic through the column histograms into owned tight planes',()=>{
 let seed=7;const random=()=>{seed=seed*1103515245+12345>>>0;return seed>>>16&255;};
 for(const [w,h,r,rv,p]of [[1,1,1,0,0.5],[2,2,1,1,1],[5,3,2,1,0.3],[7,5,3,2,0],[17,9,7,4,0.5],[16,12,1,5,1],[33,3,4,1,0.75],[9,40,2,9,0.5]] as const){
  const data=Uint8Array.from({length:w*h},(_,i)=>i%5===0?random()&15:random()),settings={...defaults,radius:r,radiusV:rv,percentile:Math.fround(p)},plan=medianPlan('gray',w,h,settings);
  expect([...medianVideoFrame(gray(data,w,h),settings,{maxFrameBytes:w*h}).planes[0]!],`${w}x${h} ${r} ${rv} ${p}`).toEqual(brute(data,w,h,plan.radius,plan.radiusV,plan.threshold));
 }
 // 3x3 padded to stride 4: the default median of the clamped 3x3 window.
 const input=Uint8Array.of(9,8,7,99,6,50,4,99,3,2,1,99),frame=gray(input,3,3,4),actual=medianVideoFrame(frame,defaults,{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([9,8,7,6,6,4,3,3,2]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([9,8,7,99,6,50,4,99,3,2,1,99]);
 expect([...medianVideoFrame(frame,{...defaults,percentile:0},{maxFrameBytes:12}).planes[0]!]).toEqual([6,4,4,2,1,1,2,1,1]);expect([...medianVideoFrame(frame,{...defaults,percentile:1},{maxFrameBytes:12}).planes[0]!]).toEqual([50,50,50,50,50,50,50,50,50]);
 const copy=medianVideoFrame(frame,{...defaults,planes:0},{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([9,8,7,6,50,4,3,2,1]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 // planes=6 filters U and V only; Y and A are copied. gbrp masks follow the memory plane order G, B, R.
 const yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(1,2,3,4),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(9,1,5,6)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 expect(medianVideoFrame(yuva,{...defaults,planes:9},{maxFrameBytes:64}).planes.map(plane=>[...plane])).toEqual([[1,2,3,4],[7],[8],[9,1,5,6]]);
 const planar:VideoFrameData={width:3,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(4,9,2),Uint8Array.of(5,6,7),Uint8Array.of(9,1,9)],linesizes:[3,3,3],pts:null,metadata:{}},out=medianVideoFrame(planar,{...defaults,planes:5},{maxFrameBytes:12});
 expect(out.planes.map(plane=>[...plane])).toEqual([[4,4,2],[5,6,7],[9,9,9]]);expect(out.pts).toBeNull();
});
it('refuses unsupported layouts, wide planes, budgets, malformed storage, settings and cancellation explicitly',()=>{
 for(const pixelFormat of ['nv12','rgb24','rgba','gbrap','yuv410p','pal8'])expect(()=>medianVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow(/Median pixel format is not supported|Unsupported video pixel format/);
 expect(()=>medianOperator.geometry!({name:'median',...defaults},[{format:'gray',width:65534,height:1}])).toThrow(VideoMedianError);expect(()=>compileVideoFilterChain('median=radius=10').plan('gray',65525,2)).toThrow('wider');
 expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>medianVideoFrame(gray(new Uint8Array(8),3,2,4),defaults,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>medianVideoFrame(gray(new Uint8Array(5),3,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2,1.5),defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>medianVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>medianVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>medianVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},defaults,{maxFrameBytes:64})).toThrow('time base');
 for(const step of [{...defaults,radius:0},{...defaults,radius:128},{...defaults,radius:1.5},{...defaults,planes:16},{...defaults,radiusV:-1},{...defaults,percentile:1.5},{...defaults,percentile:0.3},{...defaults,percentile:Number.NaN}])expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:64})).toThrow('Invalid median settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>medianVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let rows=0;const late=new AbortController(),signal={throwIfAborted(){if(++rows===3)late.abort(new Error('late'));late.signal.throwIfAborted();}} as AbortSignal;expect(()=>medianVideoFrame(gray(new Uint8Array(12),3,4),defaults,{maxFrameBytes:64,signal})).toThrow('late');
});
it('budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands',()=>{
 const plan=compileVideoFilterChain('median,hflip,median=planes=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['median','hflip','median']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(45);
 const data=Uint8Array.from({length:15},(_,i)=>i*7%15),frame=gray(data,5,3),layout=pixelLayout('gray',5,3);expect(layout.bytes).toBe(15);
 expect([...plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0}).planes[0]!]).toEqual([...medianVideoFrame(frame,defaults,{maxFrameBytes:15}).planes[0]!].reduce<number[]>((rows,value,i)=>{rows[Math.trunc(i/5)*5+4-i%5]=value;return rows;},[]));expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]median[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-median.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('median').plan(source,5,3),source).toThrow('Video filter median input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('median=enable=1')).toThrow();
 const actors=createFrameActors('median',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:1<<12,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:3}}]});
 // Option commands are ENOSYS; the disabled timeline answers enable with AVERROR_PATCHWELCOME.
 try{for(const [command,argument]of [['radius','2'],['planes','1'],['radiusV','1'],['percentile','0'],['w','2']] as const)expect(actors.sendFilterCommand('median',command,argument).code,command).toBe(-38);expect(actors.sendFilterCommand('median','enable','0').code).toBe(-1163346256);}finally{actors.dispose();}
 expect(()=>createFrameActors('median=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
