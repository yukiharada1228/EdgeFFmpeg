import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,videoOperator} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {kirschOperator,kirschPixelFormats,kirschVideoFrame,parseKirschOptions,VideoKirschError} from '../../packages/avfilter/src/video-ops/kirsch.js';
import type {KirschStep} from '../../packages/avfilter/src/video-ops/kirsch.js';
const time={num:1n,den:25n},defaults=parseKirschOptions(null);
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:time},metadata:{colorRange:2}});
/** filter_kirsch's eight coefficient rows over c0..c8 (c4, the centre, is unused), as written in vf_convolution.c. */
const compass=[[5,5,5,-3,0,-3,-3,-3,-3],[-3,5,5,5,0,-3,-3,-3,-3],[-3,-3,5,5,0,5,-3,-3,-3],[-3,-3,-3,5,0,5,5,-3,-3],[-3,-3,-3,-3,0,5,5,5,-3],[-3,-3,-3,-3,0,-3,5,5,5],[5,-3,-3,-3,0,-3,-3,5,5],[5,5,-3,-3,0,-3,-3,-3,5]];
/** avpriv_mirror as written in libavutil/internal.h. */
const mirror=(x:number,w:number)=>{if(!w)return 0;while(x<0||x>w){x=-x;if(x<0)x+=2*w;}return x;};
/** An independent direct model of setup_3x3 + filter_kirsch on one plane, with float rounding after each operation. */
function model(src:Uint8Array,width:number,height:number,stride:number,scale:number,delta:number):number[]{
 const out:number[]=[];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const c=Array.from({length:9},(_,i)=>src[mirror(y+Math.floor(i/3)-1,height-1)*stride+mirror(x+i%3-1,width-1)]!);
  const sum=Math.max(...compass.map(row=>row.reduce((total,weight,i)=>total+weight*c[i]!,0))),value=Math.trunc(Math.fround(Math.fround(Math.abs(sum)*Math.fround(scale))+Math.fround(delta)));
  out.push(value<=0?0:value>255?255:value);
 }
 return out;
}
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
it('parses native defaults, shorthand order, ranges, integer plane expressions and float-stored scale and delta into frozen steps',()=>{
 expect(defaults).toEqual({name:'kirsch',planes:15,scale:1,delta:0});expect(Object.isFrozen(defaults)).toBe(true);expect(parseKirschOptions('')).toEqual(defaults);
 expect(parseKirschOptions('5:0.5:-20')).toEqual({name:'kirsch',planes:5,scale:0.5,delta:-20});expect(parseKirschOptions('delta=3:planes=1+1:scale=10')).toEqual({name:'kirsch',planes:2,scale:10,delta:3});
 expect(parseKirschOptions('scale=0.1:delta=-0.3')).toEqual({name:'kirsch',planes:15,scale:Math.fround(0.1),delta:Math.fround(-0.3)});expect(parseKirschOptions('planes=2.5').planes).toBe(2);expect(parseKirschOptions('planes=max:scale=65535:delta=-65535')).toEqual({name:'kirsch',planes:15,scale:65535,delta:-65535});
 expect(parseKirschOptions('planes=min:scale=0:delta=65535')).toEqual({name:'kirsch',planes:0,scale:0,delta:65535});expect(parseKirschOptions('scale=.5e1:delta=+1.')).toEqual({name:'kirsch',planes:15,scale:5,delta:1});expect(parseKirschOptions('planes=1:planes=4').planes).toBe(4);
 for(const options of ['planes=16','planes=-1','planes=','planes=abc','scale=-0.5','scale=65536','scale=','scale=1/2','scale=PI','scale=nan','scale=inf','delta=-65536','delta=65535.5','delta=1e9','delta=0x10','enable=1','threads=1','foo=1','1:1:0:4','scale=1:7'])expect(()=>parseKirschOptions(options),options).toThrow();
 expect(()=>parseKirschOptions('enable=gte(t,1)')).toThrow(VideoFilterParseError);expect(()=>parseKirschOptions('enable=1')).toThrow('timeline');expect(()=>parseKirschOptions('planes=16')).toThrow('Invalid kirsch planes');expect(()=>parseKirschOptions('scale=1/2')).toThrow('Only decimal kirsch scale');expect(()=>parseKirschOptions('delta=-65536')).toThrow('Kirsch delta must be within [-65535,65535]');expect(()=>parseKirschOptions('threads=1')).toThrow('Unsupported kirsch option');
 expect(videoOperator('kirsch')).toBe(kirschOperator);expect(kirschOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(kirschOperator.timeline).toBeUndefined();expect(kirschOperator.geometryCommands).toBeUndefined();
 // The pinned vf_convolution.c pix_fmts in declared order.
 expect(kirschPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(kirschPixelFormats).toHaveLength(57);expect(Object.isFrozen(kirschPixelFormats)).toBe(true);expect(kirschOperator.formats!(defaults)).toBe(kirschPixelFormats);
});
it('matches an independent compass model with mirrored borders, plane masks, float scale and delta and copies into owned tight planes',()=>{
 let checked=0;
 for(const format of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'])for(const [width,height]of [[1,1],[2,2],[1,5],[5,1],[2,7],[5,3],[9,6]] as const)for(const options of ['','planes=0','planes=5','planes=10:scale=0.5:delta=-20','scale=0.7:delta=-0.1','scale=10:delta=25.5','scale=0.01:delta=0.3']){
  const step=parseKirschOptions(options),layout=pixelLayout(format,width,height),strides=layout.planes.map(plane=>plane.rowBytes+3),planes=layout.planes.map((plane,index)=>noise(strides[index]!*plane.height,width*17+height*5+index+format.length));
  const frame:VideoFrameData={width,height,pixelFormat:format,planes,linesizes:strides,pts:{value:7n,timeBase:time},metadata:{colorRange:1}},copies=planes.map(plane=>plane.slice());
  const out=kirschVideoFrame(frame,step,{maxFrameBytes:4096});
  expect(out.linesizes).toEqual(layout.planes.map(plane=>plane.rowBytes));expect(out.pixelFormat).toBe(format);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:1});expect(out.metadata).not.toBe(frame.metadata);
  for(const [index,plane]of layout.planes.entries()){
   const expected=step.planes>>index&1?model(planes[index]!,plane.width,plane.height,strides[index]!,step.scale,step.delta):Array.from({length:plane.width*plane.height},(_,i)=>planes[index]![Math.floor(i/plane.width)*strides[index]!+i%plane.width]!);
   expect([...out.planes[index]!],`${format} ${width}x${height} ${options} ${index}`).toEqual(expected);expect(out.planes[index]!.buffer).not.toBe(planes[index]!.buffer);checked++;
  }
  expect(planes).toEqual(copies);
 }
 expect(checked).toBe(7*7*(1+3+3+3+4+3));
 // Hand-computed: a constant plane has every compass sum 0, so the output is av_clip_uint8(delta) truncated; a lone spike of 100 at a
 // centre gives 5*100 to its eight neighbours and 0 to itself.
 expect([...kirschVideoFrame(gray(new Uint8Array(9).fill(77),3,3),parseKirschOptions('delta=25.9'),{maxFrameBytes:9}).planes[0]!]).toEqual(Array(9).fill(25));
 expect([...kirschVideoFrame(gray(new Uint8Array(9).fill(77),3,3),parseKirschOptions('delta=-0.9'),{maxFrameBytes:9}).planes[0]!]).toEqual(Array(9).fill(0));
 const spike=new Uint8Array(25);spike[12]=100;expect([...kirschVideoFrame(gray(spike,5,5),parseKirschOptions('scale=0.5'),{maxFrameBytes:25}).planes[0]!]).toEqual([0,0,0,0,0,0,250,250,250,0,0,250,0,250,0,0,250,250,250,0,0,0,0,0,0]);
 expect([...kirschVideoFrame(gray(spike,5,5),parseKirschOptions('scale=0.1:delta=-10'),{maxFrameBytes:25}).planes[0]!]).toEqual([0,0,0,0,0,0,40,40,40,0,0,40,0,40,0,0,40,40,40,0,0,0,0,0,0]);
});
it('refuses unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 for(const pixelFormat of ['nv12','rgb24','rgba','pal8'])expect(()=>kirschVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 // Native formats without frame storage here fail in pixelLayout before any plane is read.
 for(const pixelFormat of ['gbrap','yuva444p','yuv410p','gray16le'])expect(()=>kirschVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow();
 expect(kirschOperator.geometry!(defaults,[{format:'yuv420p',width:1,height:1}])).toEqual({width:1,height:1});expect(()=>kirschOperator.geometry!(defaults,[])).toThrow('one input');expect(()=>kirschOperator.geometry!(defaults,[{format:'nv12',width:4,height:4}])).toThrow(VideoKirschError);expect(()=>kirschOperator.geometry!(defaults,[{format:'gbrap',width:4,height:4}])).toThrow();
 expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>kirschVideoFrame(gray(new Uint8Array(8),3,2,4),defaults,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:1.5})).toThrow('allocation limit');
 expect(()=>kirschVideoFrame(gray(new Uint8Array(5),3,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2,1.5),defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>kirschVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>kirschVideoFrame({...gray(new Uint8Array(6),3,2),linesizes:[3,3]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>kirschVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>kirschVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},defaults,{maxFrameBytes:64})).toThrow('time base');
 for(const step of [{...defaults,planes:16},{...defaults,planes:0.5},{...defaults,scale:0.1},{...defaults,scale:-1},{...defaults,scale:65536},{...defaults,delta:-65536},{...defaults,delta:Number.NaN},{...defaults,name:'sobel'},{...defaults,scale:'1'}])expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2),step as KirschStep,{maxFrameBytes:64}),JSON.stringify(step)).toThrow('Invalid kirsch settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>kirschVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let rows=0;const late=new AbortController(),signal={throwIfAborted(){if(++rows===3)late.abort(new Error('late'));late.signal.throwIfAborted();}} as AbortSignal;expect(()=>kirschVideoFrame(gray(new Uint8Array(12),3,4),defaults,{maxFrameBytes:64,signal})).toThrow('late');
});
it('budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands on every path',async()=>{
 const plan=compileVideoFilterChain('kirsch,hflip,kirsch=planes=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['kirsch','hflip','kirsch']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(45);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*13),5,3),single=kirschVideoFrame(frame,defaults,{maxFrameBytes:15}).planes[0]!;
 expect([...plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0}).planes[0]!]).toEqual([0,1,2].flatMap(y=>[4,3,2,1,0].map(x=>single[y*5+x]!)));expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]kirsch[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-kirsch.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('kirsch').plan(source,5,3),source).toThrow('Video filter kirsch input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]kirsch[o]').plan({format:'argb',width:4,height:3},[null])).toThrow('negotiates gbrap');
 expect(()=>createReplayVideoExecution('[0:v]kirsch=enable=1[o]',[{geometry:{format:'gray',width:3,height:3},timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:64,maxStateBytes:64,maxResidentBytes:1<<12,maxSourceTraversals:2})).toThrow();
 expect(()=>compileVideoFilterChain('kirsch=enable=1')).toThrow();expect(()=>compileVideoFilterChain('kirsch=scale=2*0.5')).toThrow('Only decimal kirsch scale');
 const actors=createFrameActors('kirsch',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:1<<12,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:3}}]});
 // Native process_command re-runs param_init; here option commands are ENOSYS and the disabled timeline answers enable with AVERROR_PATCHWELCOME.
 try{for(const [command,argument]of [['planes','1'],['scale','2'],['delta','10'],['w','2']] as const)expect(actors.sendFilterCommand('kirsch',command,argument).code,command).toBe(-38);expect(actors.sendFilterCommand('kirsch','enable','0').code).toBe(-1163346256);}finally{actors.dispose();}
 expect(()=>createFrameActors('kirsch=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
