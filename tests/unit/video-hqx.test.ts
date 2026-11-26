import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {hqxVideoFrame,hqxGeometry,hqxRgbToYuv,parseHqxOptions,hqxPixelFormats,VideoHqxError} from '../../packages/avfilter/src/video-hqx.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const bgra=(data:Uint8Array,width:number,height:number,stride=width*4,pixelFormat='bgra'):VideoFrameData=>({width,height,pixelFormat,planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const words=(frame:VideoFrameData)=>Array.from(new Uint32Array(frame.planes[0]!.slice().buffer));
it('parses n=2|3|4 with the native default and shorthand, and refuses other values, enable= and unknown options',()=>{
 expect(parseHqxOptions(null)).toEqual({n:3});expect(parseHqxOptions('')).toEqual({n:3});expect(Object.isFrozen(parseHqxOptions('2'))).toBe(true);
 expect(parseHqxOptions('2').n).toBe(2);expect(parseHqxOptions('n=4').n).toBe(4);expect(parseHqxOptions('n=3').n).toBe(3);expect(parseHqxOptions('n=2:n=4').n).toBe(4);expect(parseHqxOptions('n=+04').n).toBe(4);
 for(const options of ['n=1','n=5','n=0','n=-2','n=','n=2.0','n=0x2','n=1+1','n=two','enable=1','threads=1','foo=1','n=2:enable=t'])expect(()=>parseHqxOptions(options),options).toThrow(VideoHqxError);
 expect(()=>parseHqxOptions('2:3')).toThrow('Missing filter option name');expect(()=>parseHqxOptions('enable=1')).toThrow('timeline');expect(()=>parseHqxOptions('n=5')).toThrow('must be 2, 3 or 4');
 for(const description of ['hqx=n=5','hqx=enable=1','hqx=foo=1','hqx=n=2+1'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 const op=videoOperator('hqx')!;expect(op.paths).toEqual(['linear','graph','stream','actor','timed']);expect(op.formats!({name:'hqx',n:3} as never)).toEqual(['bgra']);expect(op.timeline).toBeUndefined();expect(op.geometryCommands).toBeUndefined();
 expect(hqxPixelFormats).toEqual(['bgra']);expect(Object.isFrozen(hqxPixelFormats)).toBe(true);
});
it('computes the per-pixel YUV key exactly as the 2^24-entry rgbtoyuv table of init',()=>{
 // init walks every (b-g, r-g) pair and increments y along g; the per-pixel formula must agree on every colour.
 let checked=0,mismatch=-1;
 for(let bg=-255;bg<256;bg++)for(let rg=-255;rg<256;rg++){
  const u=(Math.trunc((-169*rg+500*bg)/1000)+128)>>>0,v=(Math.trunc((500*rg-81*bg)/1000)+128)>>>0,startg=Math.max(-bg,-rg,0),endg=Math.min(255-bg,255-rg,255);
  let y=Math.trunc((299*rg+1000*startg+114*bg)/1000)>>>0,c=bg+rg*65536+0x010101*startg;
  for(let g=startg;g<=endg;g++){const expected=((y++)*65536+u*256+v)>>>0;if(mismatch<0&&hqxRgbToYuv(c)!==expected)mismatch=c;c+=0x010101;checked++;}
 }
 expect(mismatch).toBe(-1);expect(checked).toBe(1<<24);
 expect(hqxRgbToYuv(0)).toBe(0x008080);expect(hqxRgbToYuv(0xffffff)).toBe(0xff8080);
},60000);
it('interpolates whole 32-bit words, alpha included, with edge replication into owned tight planes',()=>{
 // 1x1 and constant frames replicate exactly for every n; hq3x keeps the centre pixel.
 for(const n of [2,3,4] as const){expect(words(hqxVideoFrame(bgra(Uint8Array.of(7,8,9,10),1,1),{n},{maxFrameBytes:64}))).toEqual(Array(n*n).fill(0x0a090807));expect(words(hqxVideoFrame(bgra(new Uint8Array(24).fill(77),3,2),{n},{maxFrameBytes:384}))).toEqual(Array(6*n*n).fill(0x4d4d4d4d));}
 // A white diagonal on half-transparent black (values from native): the corner next to the diagonal blends both words, alpha included.
 const input=new Uint8Array(40).fill(99);for(let y=0;y<3;y++)for(let x=0;x<3;x++)input.set(x===y?[255,255,255,255]:[0,0,0,128],y*13+x*4);
 const frame=bgra(input,3,3,13),white=0xffffffff,black=0x80000000;
 for(const [n,row]of [[2,[white,white,0x9f3f3f3f,black,black,black]],[3,[white,white,white,0x9f3f3f3f,black,black,black,black,black]],[4,[white,white,white,white,0x9f3f3f3f,black,black,black,black,black,black,black]]] as const){
  const output=hqxVideoFrame(frame,{n},{maxFrameBytes:9*4*n*n});expect([output.width,output.height,output.linesizes[0]]).toEqual([3*n,3*n,12*n]);expect(words(output).slice(0,3*n),String(n)).toEqual(row);
 }
 const two=hqxVideoFrame(frame,{n:2},{maxFrameBytes:144});
 expect(two.pts).toEqual(frame.pts);expect(two.pts).not.toBe(frame.pts);expect(two.metadata).toEqual({colorRange:2});expect(two.planes[0]!.buffer).not.toBe(input.buffer);expect(input.filter(value=>value===99).length).toBe(4);
 // Equal colours with different alpha: yuv_diff ignores alpha, so no pattern bit is set, but the default interpolation still blends alpha (native values).
 const alpha=hqxVideoFrame(bgra(Uint8Array.of(50,60,70,255,50,60,70,0),2,1),{n:2},{maxFrameBytes:64});expect(words(alpha)).toEqual([0xff463c32,0xbf463c32,0x3f463c32,0x463c32,0xff463c32,0xbf463c32,0x3f463c32,0x463c32]);
});
it('refuses formats, budgets, malformed strides, bad time bases and cancellation explicitly',()=>{
 for(const pixelFormat of ['rgba','argb','abgr','rgb24','gray','yuv420p','bgr0'])expect(()=>hqxGeometry(pixelFormat,2,2,{n:2}),pixelFormat).toThrow('pixel format is not supported');
 expect(hqxGeometry('bgra',5,4,{n:4})).toEqual({width:20,height:16});expect(()=>hqxGeometry('bgra',15000,15000,{n:4})).toThrow('output size is invalid');expect(()=>hqxGeometry('bgra',2,2,{n:5} as never)).toThrow('Invalid hqx settings');
 const frame=bgra(new Uint8Array(24),3,2);
 expect(()=>hqxVideoFrame(frame,{n:4},{maxFrameBytes:383})).toThrow('allocation limit');expect(()=>hqxVideoFrame(frame,{n:2},{maxFrameBytes:95})).toThrow('allocation limit');expect(hqxVideoFrame(frame,{n:2},{maxFrameBytes:96}).planes[0]!.length).toBe(96);
 expect(()=>hqxVideoFrame(frame,{n:2},{maxFrameBytes:Number.NaN})).toThrow('allocation limit');
 expect(()=>hqxVideoFrame(bgra(new Uint8Array(200),3,2,100),{n:2},{maxFrameBytes:150})).toThrow('input plane storage exceeds');
 expect(()=>hqxVideoFrame(bgra(new Uint8Array(23),3,2),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');expect(()=>hqxVideoFrame(bgra(new Uint8Array(24),3,2,8),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');expect(()=>hqxVideoFrame(bgra(new Uint8Array(24),3,2,12.5),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');
 expect(()=>hqxVideoFrame({...frame,planes:[new Uint8Array(24),new Uint8Array(1)],linesizes:[12,1]},{n:2},{maxFrameBytes:1024})).toThrow('plane count');
 expect(()=>hqxVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},{n:2},{maxFrameBytes:1024})).toThrow('time base');expect(()=>hqxVideoFrame({...frame,pixelFormat:'rgba'},{n:2},{maxFrameBytes:1024})).toThrow('not supported');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>hqxVideoFrame(frame,{n:2},{maxFrameBytes:1024,signal:controller.signal})).toThrow('stop');
 // A padded stride reads only the row bytes.
 const padded=new Uint8Array(32).fill(200);padded.set([1,2,3,4,1,2,3,4,1,2,3,4],0);padded.set([1,2,3,4,1,2,3,4,1,2,3,4],16);expect(words(hqxVideoFrame(bgra(padded,3,2,16),{n:2},{maxFrameBytes:96}))).toEqual(Array(24).fill(0x04030201));
});
it('plans n-times geometry on every path, converts other sources to bgra, keeps the timed sample aspect ratio and bounds the scaled output',()=>{
 const plan=compileVideoFilterChain('hqx,hqx=2').plan('bgra',3,2);expect(plan.stages.map(stage=>[stage.operation,stage.width,stage.height,stage.pixelFormat])).toEqual([['hqx',9,6,'bgra'],['hqx',18,12,'bgra']]);
 const frame=bgra(Uint8Array.from({length:24},(_,i)=>i*9),3,2);expect(plan.apply(frame,{maxFrameBytes:864,maxStateBytes:0}).width).toBe(18);expect(()=>plan.apply(frame,{maxFrameBytes:863,maxStateBytes:0})).toThrow();
 for(const source of ['gray','rgba','rgb24'])expect(compileVideoFilterChain('hqx').plan(source,3,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat]),source).toEqual([['scale','bgra'],['hqx','bgra']]);
 expect(compileVideoFilterChain('hqx=4').plan('rgb24',3,2,{outputPixelFormat:'rgb24'}).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat,stage.width])).toEqual([['scale','bgra',3],['hqx','bgra',12],['scale','rgb24',12]]);
 const graph=compileVideoFilterGraph('[0:v]hqx=n=4[o]').plan({format:'rgba',width:5,height:4},[null]);expect(graph.negotiated.nodes[0]!.outputs[0]).toMatchObject({format:'bgra',width:20,height:16});
 const timed=planTimedVideoGraph('hqx',[{geometry:{format:'bgra',width:5,height:4,sampleAspectRatio:{num:3n,den:2n}},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]);
 expect(timed.nodes[0]!.outputs[0]).toMatchObject({format:'bgra',width:15,height:12,sampleAspectRatio:{num:3n,den:2n}});
 expect(()=>createFrameActors('hqx=n=5',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();expect(()=>createFrameActors('hqx=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
});
