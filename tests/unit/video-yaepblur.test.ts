import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {parseYaepblurOptions,VideoYaepblurError,yaepblurOperator,yaepblurPixelFormats,yaepblurVideoFrame} from '../../packages/avfilter/src/video-ops/yaepblur.js';
import type {YaepblurStep} from '../../packages/avfilter/src/video-ops/yaepblur.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseYaepblurOptions(options);
/** A literal BigInt port of pre_calculate_row, pre_calculate_col and filter_slice over full (h+1)x(w+1) uint64 summed-area tables. */
function reference(src:Uint8Array,width:number,height:number,radius:number,sigma:number):Uint8Array{
 const line=width+1,sat=new Array<bigint>(line*(height+1)).fill(0n),square=new Array<bigint>(line*(height+1)).fill(0n),out=new Uint8Array(width*height),wrap=(v:bigint)=>BigInt.asUintN(64,v);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const v=BigInt(src[y*width+x]!);sat[(y+1)*line+x+1]=sat[(y+1)*line+x]!+v;square[(y+1)*line+x+1]=square[(y+1)*line+x]!+v*v;}
 for(let x=1;x<=width;x++)for(let y=0;y<height;y++){sat[(y+1)*line+x]=sat[(y+1)*line+x]!+sat[y*line+x]!;square[(y+1)*line+x]=square[(y+1)*line+x]!+square[y*line+x]!;}
 for(let y=0;y<height;y++){const ly=Math.max(0,y-radius),hy=Math.min(height,y+radius+1);for(let x=0;x<width;x++){
  const lx=Math.max(0,x-radius),hx=Math.min(width,x+radius+1),count=BigInt((hy-ly)*(hx-lx));
  const sum=wrap(sat[hy*line+hx]!-sat[hy*line+lx]!-sat[ly*line+hx]!+sat[ly*line+lx]!),sq=wrap(square[hy*line+hx]!-square[hy*line+lx]!-square[ly*line+hx]!+square[ly*line+lx]!);
  const mean=sum/count,variance=wrap(sq-wrap(sum*sum)/count)/count;out[y*width+x]=Number(wrap(BigInt(sigma)*mean+variance*BigInt(src[y*width+x]!))/wrap(BigInt(sigma)+variance))&255;
 }}
 return out;
}
const noise=(length:number,seed:number)=>Uint8Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
it('parses radius/r, planes/p and sigma/s with native defaults, shorthand order, aliases, integer expressions and last-wins keys',()=>{
 expect(step(null)).toEqual({name:'yaepblur',radius:3,planes:1,sigma:128});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('5')).toEqual({name:'yaepblur',radius:5,planes:1,sigma:128});expect(step('5:7:9')).toEqual({name:'yaepblur',radius:5,planes:7,sigma:9});
 expect(step('r=2:p=3:s=4')).toEqual({name:'yaepblur',radius:2,planes:3,sigma:4});expect(step('radius=2:r=6:planes=1:p=0:sigma=4:s=1')).toEqual({name:'yaepblur',radius:6,planes:0,sigma:1});
 expect(step('0:15:2147483647')).toEqual({name:'yaepblur',radius:0,planes:15,sigma:2147483647});expect(step('2:sigma=3')).toEqual({name:'yaepblur',radius:2,planes:1,sigma:3});
 // AV_OPT_TYPE_INT: expressions, the default/min/max constants and llrint half-to-even rounding.
 expect(step('r=2.5:p=max:s=default')).toEqual({name:'yaepblur',radius:2,planes:15,sigma:128});expect(step('r=3.5:s=min').radius).toBe(4);expect(step('s=min').sigma).toBe(1);expect(step('p=0x6').planes).toBe(6);
 for(const options of ['bogus=1','rad=1','enable=1','threads=1','planes=16','p=-1','s=0','sigma=2147483648','r=-1','radius=2147483648','r=','r=abc','1:2:3:4','r=1:2','p=all'])expect(()=>step(options),options).toThrow(['1:2:3:4','r=1:2'].includes(options)?'Missing filter option name':VideoFilterParseError);
 expect(()=>step('bogus=1')).toThrow("Error applying option 'bogus' to filter 'yaepblur': Option not found");expect(()=>step('p=16')).toThrow("Error applying option 'p' to filter 'yaepblur': Numerical result out of range");
 expect(()=>step('r=abc')).toThrow("Error applying option 'r' to filter 'yaepblur': Invalid argument");expect(()=>step('enable=1')).toThrow('Yaepblur timeline expressions are not implemented');expect(()=>step('thread_type=1')).toThrow('Yaepblur option thread_type is not implemented');
 expect(()=>step('1:2:3:4')).toThrow('Missing filter option name');expect(()=>step('constructor=1')).toThrow('Option not found');
 expect(yaepblurOperator.parse!({name:'yaepblur',options:'4'} as never).configuration).toEqual({name:'yaepblur',radius:4,planes:1,sigma:128});
});
it('declares the native pix_fmts in declared order, all five paths and keeps geometry',()=>{
 expect(yaepblurPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(Object.isFrozen(yaepblurPixelFormats)).toBe(true);expect(yaepblurOperator.formats!(step(null))).toBe(yaepblurPixelFormats);expect(yaepblurOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 for(const format of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'])expect(yaepblurOperator.geometry!(step(null),[{format,width:1,height:1}]),format).toEqual({width:1,height:1});
 expect(yaepblurOperator.geometry!(step(null),[{format:'yuv420p',width:9,height:7}])).toEqual({width:9,height:7});
 for(const format of ['rgb24','nv12'])expect(()=>yaepblurOperator.geometry!(step(null),[{format,width:4,height:3}]),format).toThrow('Yaepblur pixel format is not supported');
 // Native members without frame storage here fail in the shared layout table.
 for(const format of ['gbrap','yuv440p','gray16le'])expect(()=>yaepblurOperator.geometry!(step(null),[{format,width:4,height:3}]),format).toThrow();
 // 255*w*h must stay below 2^32 so that native's uint64 sum*sum cannot wrap.
 expect(()=>yaepblurOperator.geometry!(step(null),[{format:'gray',width:4096,height:4113}])).toThrow('not implemented');expect(yaepblurOperator.geometry!(step(null),[{format:'gray',width:4096,height:4112}])).toEqual({width:4096,height:4112});
});
it('blends the clipped window mean and variance exactly like the native summed-area tables',()=>{
 // 3x3 radius 1 at the centre: sum 9*10+90=180, mean 20, square 8*100+10000=10800, var=(10800-3600)/9=800; (128*20+800*100)/(928)=88.
 const input=Uint8Array.of(10,10,10,0,10,100,10,0,10,10,10,0),frame=gray(input,3,3,4),out=yaepblurVideoFrame(frame,step('r=1'),{maxFrameBytes:12});
 // Corner (0,0): window 2x2 sums 130, mean 32, square 10300, var=(10300-4225)/4=1518; (128*32+1518*10)/1646=11.
 // Edge (1,0): window 3x2 sums 150, mean 25, square 10500, var=(10500-3750)/6=1125; (128*25+1125*10)/1253=11.
 expect([...out.planes[0]!]).toEqual([11,11,11,11,88,11,11,11,11]);expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});
 expect([...input]).toEqual([10,10,10,0,10,100,10,0,10,10,10,0]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 // radius 0 copies; a flat plane has zero variance and returns the mean; sigma 2^31-1 leaves the mean, floored below it where src < mean.
 expect([...yaepblurVideoFrame(frame,step('r=0'),{maxFrameBytes:12}).planes[0]!]).toEqual([10,10,10,10,100,10,10,10,10]);
 expect([...yaepblurVideoFrame(gray(new Uint8Array(6).fill(200),3,2),step(null),{maxFrameBytes:6}).planes[0]!]).toEqual([200,200,200,200,200,200]);
 expect([...yaepblurVideoFrame(frame,step('r=1:s=2147483647'),{maxFrameBytes:12}).planes[0]!]).toEqual([31,24,31,24,20,24,31,24,31]);
 // Unselected planes are copied; planes=6 filters U and V only (bits 1 and 2), and bit 3 selects alpha.
 const yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(0,255,255,0),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(0,255,255,0)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 expect(yaepblurVideoFrame(yuva,step('p=6'),{maxFrameBytes:10}).planes.map(plane=>[...plane])).toEqual([[0,255,255,0],[7],[8],[0,255,255,0]]);
 const blurred=reference(Uint8Array.of(0,255,255,0),2,2,1,128);expect(yaepblurVideoFrame(yuva,step('p=9'),{maxFrameBytes:10}).planes.map(plane=>[...plane])).toEqual([[...blurred],[7],[8],[...blurred]]);
 // gbrp plane 0 is G: the default planes=1 touches only it.
 const gbrp:VideoFrameData={width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(0,200),Uint8Array.of(9,1),Uint8Array.of(3,250)],linesizes:[2,2,2],pts:null,metadata:{}};
 expect(yaepblurVideoFrame(gbrp,step(null),{maxFrameBytes:6}).planes.map(plane=>[...plane])).toEqual([[...reference(Uint8Array.of(0,200),2,1,1,128)],[9,1],[3,250]]);
});
it('matches a literal BigInt summed-area port over random planes, clipped radii and the BigInt variance range',()=>{
 for(const [width,height,radius,sigma,seed]of [[1,1,3,128,1],[5,3,1,1,2],[7,5,2,2147483647,3],[17,9,1000,128,4],[16,1,3,40,5],[1,13,4,9,6],[33,21,6,77,7]] as const){
  const data=noise(width*height,seed),clipped=Math.min(radius,(Math.min(width,height)+1)>>1);
  expect([...yaepblurVideoFrame(gray(data,width,height),step(`r=${radius}:s=${sigma}`),{maxFrameBytes:width*height}).planes[0]!],`${width}x${height}/${radius}/${sigma}`).toEqual([...reference(data,width,height,clipped,sigma)]);
 }
 // 801x700 with radius 400 (clipped to 350): central windows hold 701*701 samples of mean ~227, so sum exceeds 94906265, sum*sum exceeds 2^53 and the BigInt path runs.
 const width=801,height=700,data=noise(width*height,99).map(v=>200+v%56);
 expect(Buffer.from(yaepblurVideoFrame(gray(data,width,height),step('r=400:s=3'),{maxFrameBytes:width*height}).planes[0]!)).toEqual(Buffer.from(reference(data,width,height,350,3)));
},120000);
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba'])expect(()=>yaepblurVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>yaepblurVideoFrame(gray(new Uint8Array(1),4096,4113),settings,{maxFrameBytes:1<<30})).toThrow(VideoYaepblurError);
 expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>yaepblurVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:6.5})).toThrow('allocation limit');
 expect(()=>yaepblurVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>yaepblurVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[1,2,3,4,5,6] as unknown as Uint8Array]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>yaepblurVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>yaepblurVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{name:'yaepblur',radius:-1,planes:1,sigma:1},{name:'yaepblur',radius:1,planes:16,sigma:1},{name:'yaepblur',radius:1,planes:1,sigma:0},{name:'yaepblur',radius:0.5,planes:1,sigma:1},{name:'yaepblur',radius:2147483648,planes:1,sigma:1},{name:'inflate',radius:1,planes:1,sigma:1}])expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as YaepblurStep,{maxFrameBytes:64})).toThrow('Invalid yaepblur settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>yaepblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans yaepblur on every path with packed-alpha and oversized refusals and runtime commands refused',async()=>{
 const plan=compileVideoFilterChain('yaepblur,hflip,yaepblur=r=1:p=15').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['yaepblur','hflip','yaepblur']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('yaepblur').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['yaepblur','yuv420p']]);
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('yaepblur').plan(source,5,3),source).toThrow('Video filter yaepblur input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('yaepblur').plan('gray',4096,4113)).toThrow('not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]yaepblur[o]').plan({format:'gray',width:4096,height:4113},[null])).toThrow('not implemented');
 expect(()=>planTimedVideoGraph('yaepblur',[{geometry:{format:'gray',width:4096,height:4113},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('not implemented');
 expect(planTimedVideoGraph('yaepblur=3',[{geometry:{format:'gray',width:4,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['yaepblur=enable=1','yaepblur=bogus=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(yaepblurOperator.timeline).toBeUndefined();expect(yaepblurOperator.geometryCommands).toBeUndefined();
 // Native answers radius/planes/sigma commands (ff_filter_process_command); here every command is refused and frames keep the parsed options.
 const shape={format:'gray',width:3,height:3},time={num:1n,den:25n},actors=createFrameActors('yaepblur=r=1',{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<16,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:shape}]});
 try{
  const codes=[['radius','0'],['r','0'],['planes','0'],['sigma','1'],['enable','0'],['bogus','1']].map(([command,argument])=>actors.sendFilterCommand('yaepblur',command!,argument!).code);
  expect(codes).toEqual([-38,-38,-38,-38,-1163346256,-38]);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:{...gray(Uint8Array.of(10,10,10,10,100,10,10,10,10),3,3),pts:{value:0n,timeBase:time}}});actors.endInput(0,-541478725,1n);
  const result=await actors.readFrame(0);expect([...result.event!.frame.planes[0]!]).toEqual([11,11,11,11,88,11,11,11,11]);
 }finally{actors.dispose();}
});
