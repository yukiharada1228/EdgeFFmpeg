import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {parseUnsharpOptions,unsharpOperator,unsharpPixelFormats,unsharpVideoFrame,VideoUnsharpError} from '../../packages/avfilter/src/video-ops/unsharp.js';
import type {UnsharpStep} from '../../packages/avfilter/src/video-ops/unsharp.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const step=(options:string|null)=>parseUnsharpOptions(options);
const planar=(pixelFormat:string,width:number,height:number,fill:(plane:number,i:number)=>number,pad=0):VideoFrameData=>{
 const layout=pixelLayout(pixelFormat,width,height);
 return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>{const stride=plane.rowBytes+pad,data=new Uint8Array(stride*plane.height);for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++)data[y*stride+x]=fill(index,y*plane.width+x);return data;}),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}};
};
/** Direct separable binomial convolution with edge replication: an independent model of the FSM cascades. */
function model(src:Uint8Array,stride:number,width:number,height:number,msizeX:number,msizeY:number,amount:number):number[]{
 const sx=msizeX>>1,sy=msizeY>>1,bits=(sx+sy)*2,binomial=(n:number)=>{let row=[1];for(let i=0;i<n;i++)row=[...row,0].map((value,k)=>value+(k?row[k-1]!:0));return row;},wx=binomial(2*sx),wy=binomial(2*sy),out:number[]=[];
 const at=(x:number,y:number)=>src[Math.min(Math.max(y,0),height-1)*stride+Math.min(Math.max(x,0),width-1)]!;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(!amount){out.push(at(x,y));continue;}
  let sum=0;for(let j=0;j<=2*sy;j++)for(let i=0;i<=2*sx;i++)sum+=wy[j]!*wx[i]!*at(x-sx+i,y-sy+j);
  const p=at(x,y),blur=Math.floor((sum+2**(bits-1))/2**bits),res=p+Math.floor((p-blur)*amount/65536);out.push(Math.min(Math.max(res,0),255));
 }
 return out;
}
it('parses the AVOption names, aliases and positional order with native defaults, integer expressions and truncated float amounts',()=>{
 expect(step(null)).toEqual({name:'unsharp',luma:{msizeX:5,msizeY:5,amount:65536},chroma:{msizeX:5,msizeY:5,amount:0},alpha:{msizeX:5,msizeY:5,amount:0}});
 expect(Object.isFrozen(step(''))).toBe(true);expect(Object.isFrozen(step('').luma)).toBe(true);
 // Positional values skip the aliases that share an offset: luma_msize_x, luma_msize_y, luma_amount, chroma..., alpha...
 expect(step('3:7:-2:9:3:1.5:4:20:0.25')).toEqual({name:'unsharp',luma:{msizeX:3,msizeY:7,amount:-131072},chroma:{msizeX:9,msizeY:3,amount:98304},alpha:{msizeX:4,msizeY:20,amount:16384}});
 expect(step('lx=7:luma_msize_x=9:ly=3').luma).toEqual({msizeX:9,msizeY:3,amount:65536});expect(step('cx=3:cy=3:ca=2:chroma_amount=-1').chroma).toEqual({msizeX:3,msizeY:3,amount:-65536});
 expect(step('ax=3:alpha_msize_y=5:aa=1:alpha_amount=5').alpha).toEqual({msizeX:3,msizeY:5,amount:327680});
 // AV_OPT_TYPE_FLOAT then (int)(amount*65536.0): float rounding first, truncation toward zero.
 expect(step('la=0.3333').luma.amount).toBe(21843);expect(step('la=-1.7').luma.amount).toBe(-111411);expect(step('la=0.00001').luma.amount).toBe(0);expect(step('la=-0.00001').luma.amount).toBe(0);expect(Object.is(step('la=-0').luma.amount,0)).toBe(true);
 expect(step('la=5').luma.amount).toBe(327680);expect(step('la=-2').luma.amount).toBe(-131072);expect(step('la=1e-1').luma.amount).toBe(6553);expect(step('la=.5').luma.amount).toBe(32768);
 // AV_OPT_TYPE_INT sizes: expressions, constants and half-to-even rounding.
 expect(step('lx=3*3:ly=min').luma).toEqual({msizeX:9,msizeY:3,amount:65536});expect(step('lx=max:ly=3').luma.msizeX).toBe(23);expect(step('cx=min:cy=default').chroma).toEqual({msizeX:3,msizeY:5,amount:0});expect(step('ax=6.5').alpha.msizeX).toBe(6);expect(step('ax=7.5').alpha.msizeX).toBe(8);expect(step('lx=2.5+0.5').luma.msizeX).toBe(3);
 expect(unsharpOperator.parse!({name:'unsharp',options:'3:3'} as never).configuration.luma).toEqual({msizeX:3,msizeY:3,amount:65536});
});
it('refuses unsupported syntax, out-of-range values and native init and config failures at parse time',()=>{
 for(const options of ['enable=1','threads=2','foo=1','luma=3','lx=2','lx=24','ly=-3','lx=abc','lx=','la=5.0001','la=-2.1','la=1+1','la=PI','la=','la=nan','la=1k'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 for(const options of ['1:2:3:4:5:6:7:8:9:10','lx=3:5'])expect(()=>step(options),options).toThrow('Missing filter option name');
 expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('foo=1')).toThrow('Unsupported unsharp option');expect(()=>step('lx=24')).toThrow('Invalid unsharp matrix size');
 expect(()=>step('la=1+1')).toThrow('Only decimal unsharp amount values');expect(()=>step('la=6')).toThrow('within [-2,5]');
 // set_filter_param: scalebits=(msize_x/2+msize_y/2)*2 above 25, luma then chroma then alpha, before the odd check of config_input.
 expect(()=>step('lx=23:ly=23')).toThrow('luma matrix size (lx/2+ly/2)*2=44 greater than maximum value 25');expect(()=>step('cx=23:cy=5')).toThrow('chroma matrix size (cx/2+cy/2)*2=26 greater than maximum value 25');
 expect(()=>step('ax=22:ay=5')).toThrow('alpha matrix size (ax/2+ay/2)*2=26 greater than maximum value 25');expect(()=>step('lx=4:cx=23:cy=23')).toThrow('chroma matrix size');
 expect(()=>step('lx=4')).toThrow('Invalid even size for luma matrix size 4x5');expect(()=>step('lx=4:cy=6')).toThrow('luma matrix size 4x5');expect(()=>step('cy=6')).toThrow('Invalid even size for chroma matrix size 5x6');
 // Alpha sizes are never checked for oddness natively; 23x3 and 3x23 sit at scalebits 24.
 expect(step('ax=4:ay=20').alpha).toEqual({msizeX:4,msizeY:20,amount:0});expect(step('lx=23:ly=3:cx=3:cy=23').luma.msizeX).toBe(23);
});
it('declares the native pix_fmts in declared order and refuses short frames and the alpha FSM path in geometry and validate',()=>{
 expect(unsharpPixelFormats).toEqual('yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le yuv420p yuv422p yuv444p yuv410p yuv411p yuv440p yuvj420p yuvj422p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p16le yuv422p16le yuv444p16le yuvj444p yuvj440p'.split(' '));
 expect(Object.isFrozen(unsharpPixelFormats)).toBe(true);expect(unsharpOperator.formats!(step(null))).toBe(unsharpPixelFormats);expect(unsharpOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 expect(unsharpOperator.geometry!(step(null),[{format:'yuv420p',width:1,height:8}])).toEqual({width:1,height:8});expect(unsharpOperator.geometry!(step('ly=3'),[{format:'yuv444p',width:3,height:4}])).toEqual({width:3,height:4});
 expect(unsharpOperator.geometry!(step('lx=3:ly=23'),[{format:'yuvj422p',width:2,height:44}])).toEqual({width:2,height:44});
 // nb_threads=h/(4*luma steps_y): zero means no slice job and unwritten output, even when every amount is 0.
 for(const [options,height]of [[null,7],['ly=3',3],['lx=3:ly=23',43],['la=0:ly=7',11]] as const)expect(()=>unsharpOperator.geometry!(step(options),[{format:'yuv420p',width:8,height}]),String(options)).toThrow('heights below');
 expect(()=>unsharpOperator.validate!('yuva420p',step('aa=1'))).toThrow('nonzero alpha amounts');expect(()=>unsharpOperator.geometry!(step('aa=-2'),[{format:'yuva420p',width:8,height:8}])).toThrow('nonzero alpha');
 for(const format of ['yuv420p','yuv422p','yuv444p','yuvj420p'])expect(()=>unsharpOperator.validate!(format,step('aa=2')),format).not.toThrow();
 for(const format of ['gray','rgb24','nv12','yuva444p','yuv410p'])expect(()=>unsharpOperator.validate!(format,step(null)),format).toThrow('not supported');
});
it('matches an independent binomial model with edge replication, clipping and copies into owned tight planes',()=>{
 let seed=7;const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 for(const [format,width,height]of [['yuv444p',1,8],['yuv420p',3,9],['yuv422p',17,12],['yuva420p',5,16],['yuv444p',2,44]] as const)for(const options of [null,'3:3:-2:3:3:5','lx=23:ly=3:la=1.5:cx=3:cy=23:ca=-0.5','la=0:ca=2.5','lx=7:ly=5:la=0.3333:cx=9:cy=11:ca=-1.7','lx=3:ly=21:la=-1:cx=21:cy=3:ca=4']){
  const settings=step(options),frame=planar(format,width,height,()=>noise(),3),input=frame.planes.map(plane=>[...plane]);
  if(Math.trunc(height/(4*(settings.luma.msizeY>>1)))<1){expect(()=>unsharpVideoFrame(frame,settings,{maxFrameBytes:1<<16}),`${format}/${options}`).toThrow('heights below');continue;}
  const out=unsharpVideoFrame(frame,settings,{maxFrameBytes:1<<16}),layout=pixelLayout(format,width,height),params=[settings.luma,settings.chroma,settings.chroma,settings.alpha];
  for(const [index,plane]of layout.planes.entries())expect([...out.planes[index]!],`${format}/${width}x${height}/${options}/${index}`).toEqual(model(frame.planes[index]!,frame.linesizes[index]!,plane.width,plane.height,params[index]!.msizeX,params[index]!.msizeY,params[index]!.amount));
  expect(out.linesizes).toEqual(layout.planes.map(plane=>plane.rowBytes));expect(out.pixelFormat).toBe(format);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:1});expect(out.metadata).not.toBe(frame.metadata);
  expect(frame.planes.map(plane=>[...plane])).toEqual(input);for(const plane of out.planes)expect(frame.planes.some(source=>source.buffer===plane.buffer)).toBe(false);
 }
 // A constant plane is a fixed point for any amount, and amount 0 is an exact copy.
 const flat=unsharpVideoFrame(planar('yuv420p',6,8,plane=>[30,128,250][plane]!),step('3:3:5:3:3:-2'),{maxFrameBytes:1<<10});expect(flat.planes.map(plane=>new Set(plane))).toEqual([new Set([30]),new Set([128]),new Set([250])]);
 // A single spike: 3x3 blur at the spike is (4*255+8)>>4=64, so sharpening by 5 clips to 255 and its neighbours (2*255+8)>>4=32 clip to 0.
 const spike=unsharpVideoFrame(planar('yuv444p',3,4,(plane,i)=>plane===0&&i===4?255:0),step('3:3:5'),{maxFrameBytes:64});expect([...spike.planes[0]!]).toEqual([0,0,0,0,255,0,0,0,0,0,0,0]);
 expect([...unsharpVideoFrame(planar('yuv444p',3,4,(plane,i)=>plane===0&&i===4?255:0),step('3:3:-1'),{maxFrameBytes:64}).planes[0]!]).toEqual([16,32,16,32,64,32,16,32,16,0,0,0]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null),frame=()=>planar('yuv420p',4,8,(plane,i)=>i*plane);
 for(const pixelFormat of ['gray','nv12','rgb24','gbrp','pal8'])expect(()=>unsharpVideoFrame({...frame(),pixelFormat},settings,{maxFrameBytes:1<<10}),pixelFormat).toThrow(VideoUnsharpError);
 expect(()=>unsharpVideoFrame(frame(),settings,{maxFrameBytes:47})).toThrow('allocation limit');expect(()=>unsharpVideoFrame(frame(),settings,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>unsharpVideoFrame(planar('yuv420p',4,8,()=>1,2),settings,{maxFrameBytes:48})).toThrow('storage exceeds');
 expect(()=>unsharpVideoFrame({...frame(),planes:frame().planes.slice(0,2)},settings,{maxFrameBytes:1<<10})).toThrow('plane count');
 for(const linesizes of [[3,2,2],[4,2,2.5],[4,-2,2],[4,2,2147483648]])expect(()=>unsharpVideoFrame({...frame(),linesizes},settings,{maxFrameBytes:1<<20}),String(linesizes)).toThrow('stride or storage');
 expect(()=>unsharpVideoFrame({...frame(),planes:[new Uint8Array(31),...frame().planes.slice(1)]},settings,{maxFrameBytes:1<<10})).toThrow('stride or storage');
 expect(()=>unsharpVideoFrame({...frame(),planes:[[...frame().planes[0]!] as unknown as Uint8Array,...frame().planes.slice(1)]},settings,{maxFrameBytes:1<<10})).toThrow('stride or storage');
 expect(()=>unsharpVideoFrame({...frame(),pts:{value:0n,timeBase:{num:1n,den:0n}}},settings,{maxFrameBytes:1<<10})).toThrow('time base');
 expect(()=>unsharpVideoFrame(planar('yuv420p',4,7,()=>1),settings,{maxFrameBytes:1<<10})).toThrow('heights below');expect(()=>unsharpVideoFrame(planar('yuva420p',4,8,()=>1),step('aa=0.5'),{maxFrameBytes:1<<10})).toThrow('nonzero alpha');
 const forged=[{name:'unsharp',luma:{msizeX:4,msizeY:5,amount:65536},chroma:settings.chroma,alpha:settings.alpha},{name:'unsharp',luma:{msizeX:23,msizeY:23,amount:1},chroma:settings.chroma,alpha:settings.alpha},{name:'unsharp',luma:{msizeX:5,msizeY:5,amount:0.5},chroma:settings.chroma,alpha:settings.alpha},{name:'unsharp',luma:{msizeX:5,msizeY:5,amount:327681},chroma:settings.chroma,alpha:settings.alpha},{name:'unsharp',luma:settings.luma,chroma:null,alpha:settings.alpha},{name:'deflate',luma:settings.luma,chroma:settings.chroma,alpha:settings.alpha}];
 for(const bad of forged)expect(()=>unsharpVideoFrame(frame(),bad as unknown as UnsharpStep,{maxFrameBytes:1<<10}),JSON.stringify(bad)).toThrow('Invalid unsharp settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>unsharpVideoFrame(frame(),settings,{maxFrameBytes:1<<10,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>3)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>unsharpVideoFrame(frame(),settings,{maxFrameBytes:1<<10,signal:late})).toThrow('late stop');
});
it('plans unsharp on every path with its refusals before output and runtime commands refused',()=>{
 const plan=compileVideoFilterChain('unsharp,hflip,unsharp=la=0').plan('yuv420p',5,8);expect(plan.stages.map(stage=>stage.operation)).toEqual(['unsharp','hflip','unsharp']);expect(plan.stateBytes).toBe(0);
 expect(()=>plan.apply(planar('yuv420p',5,8,()=>9),{maxFrameBytes:20,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('unsharp').plan('nv12',4,8).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['unsharp','yuv420p']]);
 // Native picks yuvj444p from gray and yuva444p from packed alpha (tests/differential/video-unsharp.test.ts): neither has storage here.
 expect(()=>compileVideoFilterChain('unsharp').plan('gray',8,8)).toThrow('Video filter unsharp input negotiates yuvj444p, which is not implemented');
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('unsharp').plan(source,8,8),source).toThrow('negotiates yuva444p, which is not implemented');
 expect(()=>compileVideoFilterChain('unsharp').plan('yuv420p',8,7)).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('unsharp=aa=1').plan('yuva420p',8,8)).toThrow('nonzero alpha');
 expect(()=>compileVideoFilterGraph('[0:v]unsharp[o]').plan({format:'yuv444p',width:8,height:7},[null])).toThrow('heights below');
 const source=(format:string,height:number)=>[{geometry:{format,width:8,height},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}];
 expect(()=>planTimedVideoGraph('unsharp',source('yuv420p',7),[null])).toThrow('heights below');expect(()=>planTimedVideoGraph('unsharp=aa=1',source('yuva420p',8),[null])).toThrow('nonzero alpha');
 expect(planTimedVideoGraph('unsharp=3:3:-2',source('yuv420p',4),[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['unsharp=enable=1','unsharp=lx=4','unsharp=threads=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(unsharpOperator.timeline).toBeUndefined();expect(unsharpOperator.geometryCommands).toBeUndefined();
});
