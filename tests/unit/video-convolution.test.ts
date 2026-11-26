import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {convolutionOperator,parseConvolutionStep} from '../../packages/avfilter/src/video-ops/convolution.js';
import {convolutionMirror,convolutionPixelFormats,convolutionPlane,convolutionSample,convolveVideoFrame,parseConvolutionMatrix,parseConvolutionOptions,VideoConvolutionError} from '../../packages/avfilter/src/video-convolution.js';
import type {VideoConvolutionSettings} from '../../packages/avfilter/src/video-convolution.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const defaults=parseConvolutionOptions(null),time={num:1n,den:25n},f=Math.fround;
/** An independent reference: periodic reflection, exact integer sums wrapped to int32, unfused float rounding. */
function naive(src:readonly number[],width:number,height:number,matrix:readonly number[],mode:'square'|'row'|'column',rdiv:number,bias:number):number[]{
 const reflect=(x:number,n:number)=>{if(n===1)return 0;const p=2*(n-1),k=((x%p)+p)%p;return k<n?k:p-k;},size=mode==='square'?Math.sqrt(matrix.length):matrix.length,hx=mode==='column'?1:size,vy=mode==='row'?1:size;
 return Array.from({length:width*height},(_,i)=>{const x=i%width,y=Math.floor(i/width);let sum=0;for(let j=0;j<vy;j++)for(let k=0;k<hx;k++)sum+=src[reflect(y+j-(vy>>1),height)*width+reflect(x+k-(hx>>1),width)]!*matrix[j*hx+k]!;
  const v=Math.trunc(f(f(f(f(sum|0)*rdiv)+bias)+0.5));return v<0?0:v>255?255:v;});
}
it('parses native defaults, shorthand order, modes, separators and float rdiv and bias into frozen param_init planes',()=>{
 expect(defaults.planes).toHaveLength(4);for(const plane of defaults.planes)expect(plane).toEqual({matrix:[0,0,0,0,1,0,0,0,0],mode:'square',size:3,rdiv:1,bias:0,copy:true});
 expect(Object.isFrozen(defaults)&&Object.isFrozen(defaults.planes)&&defaults.planes.every(plane=>Object.isFrozen(plane)&&Object.isFrozen(plane.matrix))).toBe(true);expect(parseConvolutionOptions('')).toEqual(defaults);
 // Shorthand follows the declaration order 0m..3m, 0rdiv..3rdiv, 0bias..3bias, 0mode..3mode.
 const positional=parseConvolutionOptions('1 2 1 2 4 2 1 2 1:0 -1 0 -1 5 -1 0 -1 0:1 1 1:-1 0 1:0:2:0.5:0:0:0:7.25:0:0:0:row:2');
 expect(positional.planes.map(plane=>[plane.mode,plane.size,plane.rdiv,plane.bias,plane.copy])).toEqual([['square',3,0.0625,0,false],['square',3,2,0,false],['row',3,f(0.5),f(7.25),false],['column',3,1,0,false]]);
 expect(parseConvolutionOptions('3mode=column:3m=  1|2 | 3  |4 5:0m=+0 -0 0 0 1 0 0 0 0').planes[3]).toEqual({matrix:[1,2,3,4,5],mode:'column',size:5,rdiv:f(1/15),bias:0,copy:false});
 expect(parseConvolutionOptions('0m=+0 -0 0 0 1 0 0 0 0').planes[0]!.copy).toBe(true);expect(Object.is(parseConvolutionOptions('0m=0 -0 0 0 1 0 0 0 0').planes[0]!.matrix[1],0)).toBe(true);
 // rdiv 0 means 1/sum of the float element sum, 1 when the sum is 0; explicit rdiv and bias are stored as floats.
 expect(parseConvolutionOptions('0m=0 1 0 1 -4 1 0 1 0').planes[0]!.rdiv).toBe(1);expect(parseConvolutionOptions('0m=-1 -1 -1 -1 1 -1 -1 -1 -1').planes[0]!.rdiv).toBe(f(-1/7));
 expect(parseConvolutionOptions(`0m=${Array(49).fill(1).join(' ')}:1m=${Array(25).fill(2).join(' ')}`).planes.slice(0,2).map(plane=>[plane.size,plane.rdiv])).toEqual([[7,f(1/49)],[5,f(1/50)]]);
 expect(parseConvolutionOptions('0m=16777217 1 0 0 0 0 0 0 0').planes[0]!.rdiv).toBe(f(1/f(f(16777217)+1)));expect(parseConvolutionOptions('0rdiv=0.1:0bias=2147483647:0m=0 0 0 0 2 0 0 0 0').planes[0]).toMatchObject({rdiv:f(0.1),bias:2147483648,copy:false});
 expect(parseConvolutionOptions('0mode=1:0m=7').planes[0]).toEqual({matrix:[7],mode:'row',size:1,rdiv:f(1/7),bias:0,copy:false});expect(parseConvolutionOptions('0mode=square:0rdiv=1').planes[0]!.copy).toBe(true);expect(parseConvolutionOptions('0rdiv=1e0:0bias=0.0').planes[0]!.copy).toBe(true);
 expect(parseConvolutionOptions(`0m=${Array(49).fill(1).join(' ')}:0mode=row`).planes[0]!.size).toBe(49);expect(parseConvolutionMatrix('|1||-2|  3|',0)).toEqual([1,-2,3]);
 expect(convolutionPlane([0,0,0,0,1,0,0,0,0],'square',0,1).copy).toBe(false);expect(convolutionPlane([0,1,0],'row',1,0).copy).toBe(false);
 const refusals:[string,string][]=[['0m=1 2','must be odd'],['0m=','must be odd'],['3m=| |','must be odd'],['1m=1 2 3','9, 25 or 49'],['0m=1 2 3 4 5 6 7 8 9 10 11:0mode=square','9, 25 or 49'],['0m=1.5 0 0 0 1 0 0 0 0','decimal integer'],['0m=0x1 0 0 0 1 0 0 0 0','decimal integer'],['0m=1\t2 3','decimal integer'],['0m=2147483648 0 0 0 1 0 0 0 0','int range'],['0m=-2147483649 0 0 0 1 0 0 0 0','int range'],
  [`0m=${Array(51).fill(1).join(' ')}:0mode=row`,'more than 49'],['0rdiv=-1','out of range'],['0bias=2147483648','out of range'],['1rdiv=1/16','constant decimal'],['2bias=nan','constant decimal'],['3rdiv=','constant decimal'],['0mode=3','Invalid convolution 0mode'],['0mode=diagonal','Invalid convolution 0mode'],['planes=1','Unsupported convolution option'],['threads=1','Unsupported convolution option'],['scale=2','Unsupported convolution option'],['enable=1','timeline'],['1 2:0 0 0 0 1 0 0 0 0','must be odd'],['a:b:c:d','decimal integer'],['0m=0 0 0 0 1 0 0 0 0:0 0 0 0 1 0 0 0 0:0 0 0 0 1 0 0 0 0:0 0 0 0 1 0 0 0 0:0:0:0:0:0:0:0:0:0:0:0:0:0','Missing filter option name']];
 for(const [options,message]of refusals){expect(()=>parseConvolutionOptions(options),options).toThrow(message);expect(()=>parseConvolutionStep(options),options).toThrow(message==='Missing filter option name'?Error:VideoFilterParseError);}
 expect(videoOperator('convolution')).toBe(convolutionOperator);expect(convolutionOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(convolutionOperator.timeline).toBeUndefined();expect(convolutionOperator.geometryCommands).toBeUndefined();
 // The pinned vf_convolution.c pix_fmts in declared order.
 expect(convolutionPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(Object.isFrozen(convolutionPixelFormats)).toBe(true);expect(convolutionOperator.formats!(parseConvolutionStep(null))).toBe(convolutionPixelFormats);
});
it('convolves square, row and column taps with mirrored edges, wrapped sums and unfused float rounding into owned tight planes',()=>{
 expect([[-1,4],[5,4],[-3,1],[7,0],[-7,2],[9,3]].map(([x,w])=>convolutionMirror(x!,w!))).toEqual([1,3,1,0,1,3]);
 // sum*rdiv, +bias and +0.5 each round to float; out of int range converts to INT_MIN (x86-64 cvttss2si) and clips to 0.
 expect([convolutionSample(-1,1,0),convolutionSample(255,1,0),convolutionSample(256,1,0),convolutionSample(2147483647,1,0),convolutionSample(-2147483648,1,0),convolutionSample(5,f(0.3),f(0.3)),convolutionSample(3,f(0.7),0),convolutionSample(1,1,2147483648)]).toEqual([0,255,255,0,0,2,2,0]);
 // 3x3 padded to stride 4: the sharpen kernel reads mirrored rows and columns at every edge; a -1 centre gets rdiv 1/-1.
 const input=Uint8Array.of(1,2,3,99,4,50,6,99,7,8,9,99),frame=gray(input,3,3,4),sharpen=parseConvolutionOptions('0m=0 -1 0 -1 5 -1 0 -1 0'),actual=convolveVideoFrame(frame,sharpen,{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([0,0,0,0,230,0,11,0,17]);expect([...convolveVideoFrame(frame,parseConvolutionOptions('0m=0 0 0 0 -1 0 0 0 0:0bias=60'),{maxFrameBytes:12}).planes[0]!]).toEqual([61,62,63,64,110,66,67,68,69]);
 expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([1,2,3,99,4,50,6,99,7,8,9,99]);
 const copy=convolveVideoFrame(frame,defaults,{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([1,2,3,4,50,6,7,8,9]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 const src=[1,2,3,4,50,6,7,8,9];
 for(const [options,matrix,mode,rdiv,bias]of [['0m=-1 0 1:0mode=row',[-1,0,1],'row',1,0],['0m=1 2 3 4 5:0mode=column:0bias=2.5',[1,2,3,4,5],'column',f(1/15),f(2.5)],['0m=1 1 1 1 1 1 1 1 1',Array(9).fill(1),'square',f(1/9),0],[`0m=${Array.from({length:49},(_,i)=>i%5-2).join(' ')}:0rdiv=0.7`,Array.from({length:49},(_,i)=>i%5-2),'square',f(0.7),0],[`0m=${Array.from({length:49},(_,i)=>i%3).join(' ')}:0mode=row:0rdiv=0.01`,Array.from({length:49},(_,i)=>i%3),'row',f(0.01),0]] as const)
  expect([...convolveVideoFrame(frame,parseConvolutionOptions(options),{maxFrameBytes:12}).planes[0]!],options).toEqual(naive(src,3,3,matrix,mode,rdiv,bias));
 // Kernels wider than the plane reflect repeatedly; a one pixel plane reads itself.
 for(const [width,height]of [[1,1],[2,1],[1,5],[2,2],[7,3]] as const){const data=Uint8Array.from({length:width*height},(_,i)=>(i*67+13)&255),plane=[...data];
  for(const [options,matrix,mode]of [[`0m=${Array.from({length:49},(_,i)=>(i*7)%9-4).join(' ')}`,Array.from({length:49},(_,i)=>(i*7)%9-4),'square'],[`0m=${Array.from({length:49},(_,i)=>i%4-1).join(' ')}:0mode=row`,Array.from({length:49},(_,i)=>i%4-1),'row'],[`0m=${Array.from({length:25},(_,i)=>i%3-1).join(' ')}:0mode=column`,Array.from({length:25},(_,i)=>i%3-1),'column']] as const){
   const settings=parseConvolutionOptions(options);expect([...convolveVideoFrame(gray(data,width,height),settings,{maxFrameBytes:64}).planes[0]!],`${width}x${height} ${mode}`).toEqual(naive(plane,width,height,matrix,mode,settings.planes[0]!.rdiv,0));}}
 // unsigned sums wrap modulo 2^32 before the int conversion: 2^32+2 reads as 2, and 2^31+1 as a negative int.
 expect([...convolveVideoFrame(gray(Uint8Array.of(2,2,2),3,1),parseConvolutionOptions('0m=1073741824 1073741824 1:0mode=row:0rdiv=1'),{maxFrameBytes:3}).planes[0]!]).toEqual([2,2,2]);
 expect([...convolveVideoFrame(gray(Uint8Array.of(1,1,1),3,1),parseConvolutionOptions('0m=2147483647 2 0:0mode=row:0rdiv=1'),{maxFrameBytes:3}).planes[0]!]).toEqual([0,0,0]);
 // Per-plane settings: yuva420p planes 0-3 and gbrp memory order G, B, R; identity planes are copied.
 const yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(10,20,30,40),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(9,1,5,6)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 const mixed=convolveVideoFrame(yuva,parseConvolutionOptions('0m=1 -1 0:0mode=row:1m=3:1mode=column:2m=0 0 0 0 2 0 0 0 0:3m=-1 3 -1:3mode=column'),{maxFrameBytes:64});
 expect(mixed.planes.map(plane=>[...plane])).toEqual([[10,0,10,0],[7],[8],[17,0,0,16]]);expect(mixed.pts).toBeNull();expect(mixed.pixelFormat).toBe('yuva420p');
 const planar:VideoFrameData={width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(4,3),Uint8Array.of(5,6),Uint8Array.of(9,1)],linesizes:[2,2,2],pts:null,metadata:{}};
 expect(convolveVideoFrame(planar,parseConvolutionOptions('1m=2:1mode=row:1rdiv=1:2m=1 1 1:2mode=row:2rdiv=1'),{maxFrameBytes:6}).planes.map(plane=>[...plane])).toEqual([[4,3],[10,12],[11,19]]);
});
it('refuses native null-filter planes, unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 // An identity square plane whose rdiv or bias clears the copy has no eight-bit filter natively (SIGSEGV); only processed planes count.
 const nullPlane=parseConvolutionStep('1bias=3');
 expect(convolutionOperator.geometry!(nullPlane,[{format:'gray',width:3,height:2}])).toEqual({width:3,height:2});expect([...convolveVideoFrame(gray(Uint8Array.of(1,2,3,4,5,6),3,2),nullPlane,{maxFrameBytes:6}).planes[0]!]).toEqual([1,2,3,4,5,6]);
 for(const format of ['yuv420p','yuv444p','gbrp','yuva420p']){expect(()=>convolutionOperator.geometry!(nullPlane,[{format,width:4,height:2}]),format).toThrow('native calls a null filter');expect(()=>compileVideoFilterChain('convolution=1bias=3').plan(format,4,2),format).toThrow('identity matrix 1m');}
 expect(()=>compileVideoFilterChain('convolution=3rdiv=2').plan('yuv420p',4,2)).not.toThrow();expect(()=>compileVideoFilterChain('convolution=3rdiv=2').plan('yuva420p',4,2)).toThrow('identity matrix 3m');expect(()=>compileVideoFilterChain('convolution=0m=0 0 0 0 1 0 0 0 0:0rdiv=1.5').plan('gray',2,2)).toThrow('identity matrix 0m');
 expect(()=>convolveVideoFrame(gray(new Uint8Array(4),2,2),parseConvolutionOptions('0bias=1'),{maxFrameBytes:64})).toThrow('native calls a null filter');expect(()=>convolutionOperator.geometry!(defaults as never,[])).toThrow('one input');
 expect(convolutionOperator.geometry!(parseConvolutionStep(null),[{format:'yuv420p',width:1,height:1}])).toEqual({width:1,height:1});
 for(const pixelFormat of ['nv12','rgb24','rgba','pal8','yuva444p','gbrap','gray16le'])expect(()=>convolveVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow(/not supported|Unsupported|pixel format/);
 expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>convolveVideoFrame(gray(new Uint8Array(8),3,2,4),defaults,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:1.5})).toThrow('allocation limit');
 expect(()=>convolveVideoFrame(gray(new Uint8Array(5),3,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2,1.5),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2,-3),defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>convolveVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>convolveVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>convolveVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},defaults,{maxFrameBytes:64})).toThrow('time base');
 const plane=defaults.planes[0]!,bad=(override:object):VideoConvolutionSettings=>({planes:[{...plane,...override},plane,plane,plane]} as never);
 for(const settings of [bad({matrix:[1,2]}),bad({matrix:[0.5,0,0,0,1,0,0,0,0]}),bad({matrix:Array(51).fill(1),mode:'row',size:51}),bad({mode:'diagonal'}),bad({size:5}),bad({mode:'row'}),bad({rdiv:0.1}),bad({rdiv:Number.NaN}),bad({bias:-1}),bad({copy:1}),{planes:[plane,plane,plane]} as never])expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64})).toThrow('Invalid convolution settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>convolveVideoFrame(gray(new Uint8Array(6),3,2),parseConvolutionOptions('0m=1 1 1 1 1 1 1 1 1'),{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 for(const options of ['0m=1 1 1 1 1 1 1 1 1',null]){let rows=0;const late=new AbortController(),signal={throwIfAborted(){if(++rows===3)late.abort(new Error('late'));late.signal.throwIfAborted();}} as AbortSignal;expect(()=>convolveVideoFrame(gray(new Uint8Array(12),3,4),parseConvolutionOptions(options),{maxFrameBytes:64,signal}),String(options)).toThrow('late');}
 expect(VideoConvolutionError.prototype).toBeInstanceOf(Error);
});
it('budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands',()=>{
 const plan=compileVideoFilterChain('convolution=0m=0 -1 0 -1 5 -1 0 -1 0,hflip,convolution=0m=1 1 1:0mode=column').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['convolution','hflip','convolution']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(45);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*9),5,3),out=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(out.planes[0]).toHaveLength(15);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');expect([...frame.planes[0]!]).toEqual(Array.from({length:15},(_,i)=>i*9));
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]convolution[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');
 expect(compileVideoFilterGraph('[0:v]convolution=0m=1:0mode=row[o]').plan({format:'rgb24',width:1,height:1},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-convolution.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('convolution').plan(source,5,3),source).toThrow('Video filter convolution input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('convolution=enable=1')).toThrow('timeline');expect(()=>compileVideoFilterChain('convolution=0m=1 2')).toThrow('must be odd');
 const actors=createFrameActors('convolution=0m=0 -1 0 -1 5 -1 0 -1 0',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:1<<12,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:3}}]});
 // Native accepts these runtime commands and reruns param_init; here they are ENOSYS, and enable answers AVERROR_PATCHWELCOME.
 try{for(const [command,argument]of [['0m','1 1 1 1 1 1 1 1 1'],['0rdiv','1'],['0mode','row'],['w','2']] as const)expect(actors.sendFilterCommand('convolution',command,argument).code,command).toBe(-38);expect(actors.sendFilterCommand('convolution','enable','0').code).toBe(-1163346256);}finally{actors.dispose();}
 expect(()=>createFrameActors('convolution=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
