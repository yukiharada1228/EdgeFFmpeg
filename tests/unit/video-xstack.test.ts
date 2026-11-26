import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,compileMultiInputVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {xstackOperator,xstackPixelFormats,parseXstackOptions} from '../../packages/avfilter/src/video-ops/xstack.js';
import {parseXstackLayout,xstackGeometry,xstackVideoFrames} from '../../packages/avfilter/src/video-xstack.js';
import type {XstackLayout} from '../../packages/avfilter/src/video-xstack.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiableFormats} from '../../packages/avfilter/src/video-ops/formats.js';
const pts={value:9007199254740993n,timeBase:{num:1n,den:25n}};
function frame(format:string,width:number,height:number,salt:number,padding=0):VideoFrameData{const layout=pixelLayout(format,width,height);return {width,height,pixelFormat:format,planes:layout.planes.map((plane,p)=>Uint8Array.from({length:(plane.height-1)*(plane.rowBytes+padding)+plane.rowBytes},(_,i)=>(i*7+p*43+salt*29+1)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+padding),pts,metadata:{source:'input'}};}
const shape=(width:number,height:number,format='gray')=>({format,width,height});
const layoutOf=(text:string,inputs:number):XstackLayout=>({kind:'layout',positions:parseXstackLayout(text,inputs)});
const tight=(f:VideoFrameData,p=0)=>{const plane=pixelLayout(f.pixelFormat,f.width,f.height).planes[p]!;return Array.from({length:plane.height},(_,y)=>[...f.planes[p]!.subarray(y*f.linesizes[p]!,y*f.linesizes[p]!+plane.rowBytes)]);};
it('parses inputs, layout, grid, shortest and fill in shorthand order and refuses every unimplemented form',()=>{
 expect(parseXstackOptions(null)).toEqual({name:'xstack',inputs:2,layout:{kind:'grid',columns:2,rows:1},shortest:false});expect(Object.isFrozen(parseXstackOptions(null))).toBe(true);
 expect(parseXstackOptions('2:0_0|w0_0')).toEqual({name:'xstack',inputs:2,layout:{kind:'layout',positions:[{x:[{kind:'n',value:0}],y:[{kind:'n',value:0}]},{x:[{kind:'w',value:0}],y:[{kind:'n',value:0}]}]},shortest:false});
 expect(parseXstackOptions('grid=3x2:inputs=4').inputs).toBe(6);expect(parseXstackOptions('grid=2x2:shortest=1:fill=none')).toEqual({name:'xstack',inputs:4,layout:{kind:'grid',columns:2,rows:2},shortest:true});
 expect(parseXstackOptions('inputs=3:layout=0_0|0_h0+5|w1+h0+2_w0').layout).toEqual({kind:'layout',positions:[{x:[{kind:'n',value:0}],y:[{kind:'n',value:0}]},{x:[{kind:'n',value:0}],y:[{kind:'h',value:0},{kind:'n',value:5}]},{x:[{kind:'w',value:1},{kind:'h',value:0},{kind:'n',value:2}],y:[{kind:'w',value:0}]}]});
 expect(parseXstackOptions('shortest=on:shortest=off').shortest).toBe(false);
 for(const [options,message]of [['fill=red','fill colours'],['fill=black','fill colours'],['fill=bogus','fill colours'],['fill=','fill colours'],['layout=0_0|w0_0:grid=2x1','Both layout and grid'],['inputs=3','No xstack layout or grid'],['inputs=1','bounded decimal'],['inputs=33','bounded decimal'],['inputs=0x2','bounded decimal'],
  ['grid=1x1','CxR'],['grid=33x1','CxR'],['grid=hd720','CxR'],['grid=2*2','CxR'],['grid=0x2','CxR'],['grid=9x4','CxR'],['enable=1','timeline'],['eof_action=pass','Unsupported xstack option'],['repeatlast=0','Unsupported xstack option'],['ts_sync_mode=nearest','Unsupported xstack option'],['shortest=2','Unsupported xstack option'],
  ['layout=','exactly 2 positions'],['layout=0_0','exactly 2 positions'],['layout=0_0|w0_0|0_h0','exactly 2 positions'],['layout=0_0||w0_0','exactly 2 positions'],['layout=0_0|w0','expected x_y'],['layout=0_0|w0_0_1','expected x_y'],['layout=0_0|w1_0','reference w1'],['layout=0_0|w2_0','reference w2'],['layout=h0_0|0_0','reference h0'],
  ['layout=0_0|-1_0','term'],['layout=0_0| w0_0','term'],['layout=0_0|w0+_0','term'],['layout=0_0|x0_0','term'],['layout=0_0|w0a_0','term'],['layout=0_0|2147483648_0','out of range'],['1:2:3:4:5:6','Missing filter option name']] as const)expect(()=>parseXstackOptions(options),options).toThrow(message);
 expect(()=>parseXstackOptions('fill=red')).toThrow(VideoFilterParseError);expect(()=>parseXstackOptions('layout=0_0|w1_0')).toThrow(VideoFilterParseError);
 expect(xstackPixelFormats).toEqual(negotiableFormats.filter(format=>!['monow','monob','pal8','bgr4','rgb4','xv30be','v30xbe'].includes(format)));expect(xstackPixelFormats.slice(0,9)).toEqual(['yuv420p','yuyv422','rgb24','bgr24','yuv422p','yuv444p','yuv410p','yuv411p','gray']);
 expect(xstackOperator.formats!(parseXstackOptions(null))).toBe(xstackPixelFormats);expect(Object.isFrozen(xstackPixelFormats)).toBe(true);expect(new Set(xstackPixelFormats).size).toBe(xstackPixelFormats.length);
 expect(videoOperator('xstack')).toBe(xstackOperator);expect(xstackOperator.role).toBe('join');expect(xstackOperator.paths).toEqual(['graph','stream','actor','timed']);expect(xstackOperator.timeline).toBeUndefined();expect(xstackOperator.geometryCommands).toBeUndefined();
 expect(xstackOperator.parse!({name:'xstack',options:'grid=2x3'} as never).inputs).toBe(6);expect(()=>compileVideoFilterChain('xstack')).toThrow();
});
it('computes grid and layout geometry with native w<i>/h<i> sums and refuses mismatched rows, gaps, overlaps and out-of-plane chroma',()=>{
 expect(xstackGeometry([shape(5,3),shape(4,3)],{kind:'grid',columns:2,rows:1})).toMatchObject({width:9,height:3});
 expect(xstackGeometry(Array(4).fill(shape(2,2,'yuv420p')),{kind:'grid',columns:2,rows:2}).regions.map(r=>r.map(p=>[p.x,p.y]))).toEqual([[[0,0],[0,0],[0,0]],[[2,0],[1,0],[1,0]],[[0,2],[0,1],[0,1]],[[2,2],[1,1],[1,1]]]);
 expect(xstackGeometry([shape(4,2),shape(2,2),shape(3,2),shape(3,2)],{kind:'grid',columns:2,rows:2})).toMatchObject({width:6,height:4});
 expect(()=>xstackGeometry([shape(4,2),shape(2,3),shape(3,2),shape(3,2)],{kind:'grid',columns:2,rows:2})).toThrow("Input 1 height 3 does not match current row's height 2");
 expect(()=>xstackGeometry([shape(4,2),shape(2,2),shape(3,2),shape(2,2)],{kind:'grid',columns:2,rows:2})).toThrow('Row 1 width 5 does not match previous row width 6');
 expect(()=>xstackGeometry([shape(3,3,'yuv420p'),shape(3,3,'yuv420p')],{kind:'grid',columns:2,rows:1})).toThrow('exceeds the output plane');
 expect(()=>xstackGeometry([shape(3,3,'nv12'),shape(3,3,'nv12')],{kind:'grid',columns:1,rows:2})).toThrow('exceeds the output plane');
 expect(xstackGeometry([shape(3,3,'yuv444p'),shape(3,3,'yuv444p')],{kind:'grid',columns:1,rows:2})).toMatchObject({width:3,height:6});
 // Native adds the referenced width for w<i> in the y coordinate too.
 expect(xstackGeometry([shape(3,3),shape(3,5)],layoutOf('0_0|0_w0',2))).toMatchObject({width:3,height:8});
 expect(()=>xstackGeometry([shape(3,2),shape(3,5)],layoutOf('0_0|0_w0',2))).toThrow('uncovered');expect(xstackGeometry([shape(3,2),shape(3,5)],layoutOf('0_0|0_h0',2))).toMatchObject({width:3,height:7});
 expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('0_0|w0_h0',2))).toThrow('uncovered');expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('0_0|5_0',2))).toThrow('uncovered');expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('1_0|w0+1_0',2))).toThrow('uncovered');
 expect(xstackGeometry([shape(4,4),shape(4,4),shape(4,4),shape(4,4)],layoutOf('0_0|0_h0|w0_0|w0_h0',4))).toMatchObject({width:8,height:8});
 // Native copies inputs on parallel slice jobs, so any overlap is racy there: refused, including full overwrites.
 expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('0_0|2_0',2))).toThrow('inputs 0 and 1 overlap in plane 0');expect(()=>xstackGeometry([shape(4,4),shape(2,2)],layoutOf('0_0|1_1',2))).toThrow('overlap');
 expect(()=>xstackGeometry([shape(4,4),shape(4,4),shape(4,4)],layoutOf('0_0|w0_0|0_0',3))).toThrow('inputs 0 and 2 overlap');expect(()=>xstackGeometry([shape(4,4,'nv12'),shape(4,4,'nv12'),shape(4,4,'nv12'),shape(4,4,'nv12')],layoutOf('0_0|2_0|0_2|2_2',4))).toThrow('overlap');
 expect(()=>xstackGeometry([shape(4,4),shape(4,4,'rgb24')],layoutOf('0_0|w0_0',2))).toThrow('pixel formats differ');expect(()=>xstackGeometry([shape(4,4)],layoutOf('0_0|w0_0',2))).toThrow('two to thirty-two');
 expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('0_0|2147483647_0',2))).toThrow('overflows');expect(()=>xstackGeometry([shape(4,4),shape(4,4)],layoutOf('0_0|0_0|0_0',3))).toThrow('does not match');
 expect(()=>xstackGeometry([shape(4,4),shape(4,4)],{kind:'grid',columns:3,rows:1})).toThrow('grid');
 for(const value of [xstackGeometry([shape(2,2),shape(2,2)],{kind:'grid',columns:2,rows:1})])for(const item of [value,value.regions,...value.regions,...value.regions.flat()])expect(Object.isFrozen(item)).toBe(true);
 // Geometry refusals surface when the graph is planned, before any frame.
 expect(()=>compileMultiInputVideoFilterGraph('[a][b]xstack=layout=0_0|w0_h0[o]').plan([shape(4,4),shape(4,4)],[null])).toThrow('uncovered');
});
it('copies each input into its own region, into owned tight planes without mutating padded inputs',()=>{
 const a=frame('gray',3,2,1,2),b=frame('gray',3,2,2,1),before=[Buffer.from(a.planes[0]!),Buffer.from(b.planes[0]!)];
 const out=xstackVideoFrames([a,b],layoutOf('0_0|w0_0',2),{maxFrameBytes:12});
 expect([out.width,out.height,out.pixelFormat]).toEqual([6,2,'gray']);expect(tight(out)).toEqual([[...tight(a)[0]!,...tight(b)[0]!],[...tight(a)[1]!,...tight(b)[1]!]]);
 expect(out.metadata).toEqual({});expect(out.pts).toEqual(pts);expect(out.pts).not.toBe(pts);expect(out.linesizes).toEqual([6]);
 const copy=Buffer.from(out.planes[0]!);out.planes[0]![0]=99;expect([Buffer.from(a.planes[0]!),Buffer.from(b.planes[0]!)]).toEqual(before);
 const back=xstackVideoFrames([b,a],layoutOf('w1_0|0_0',2),{maxFrameBytes:12});expect(Buffer.from(back.planes[0]!)).toEqual(copy);
 const column=xstackVideoFrames([a,b],layoutOf('0_h1|0_0',2),{maxFrameBytes:12});expect(tight(column)).toEqual([...tight(b),...tight(a)]);
 for(const format of ['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21']){
  const frames=[0,1,2,3].map(n=>frame(format,2,2,n,n)),grid=xstackVideoFrames(frames,{kind:'grid',columns:2,rows:2},{maxFrameBytes:4096}),custom=xstackVideoFrames([frames[0]!,frames[2]!,frames[1]!,frames[3]!],layoutOf('0_0|0_h0|w0_0|w0_h0',4),{maxFrameBytes:4096});
  expect(grid.planes.map(p=>p.length),format).toEqual(pixelLayout(format,4,4).planes.map(p=>p.bytes));expect(custom.planes,format).toEqual(grid.planes);
  expect(tight(grid,0).slice(0,2).map(row=>row.slice(0,row.length/2)),format).toEqual(tight(frames[0]!,0));
 }
});
it('refuses budgets, malformed storage, strides, timestamps and aborted signals',()=>{
 const a=frame('gray',3,2,1),b=frame('gray',3,2,2),grid:XstackLayout={kind:'grid',columns:2,rows:1};
 expect(()=>xstackVideoFrames([a,b],grid,{maxFrameBytes:11})).toThrow('frame budget');expect(()=>xstackVideoFrames([a,b],grid,{maxFrameBytes:1.5})).toThrow('frame budget');expect(xstackVideoFrames([a,b],grid,{maxFrameBytes:12}).planes[0]).toHaveLength(12);
 for(const bad of [{...b,planes:[new Uint8Array(5)]},{...b,linesizes:[2]},{...b,linesizes:[-3]},{...b,linesizes:[3.5]},{...b,planes:[]},{...b,linesizes:[3,3]},{...b,planes:[[1,2,3,4,5,6] as unknown as Uint8Array]}])expect(()=>xstackVideoFrames([a,bad],grid,{maxFrameBytes:64})).toThrow(/storage|layout/);
 expect(()=>xstackVideoFrames([a,{...b,planes:[new Uint8Array(100)]}],grid,{maxFrameBytes:12})).toThrow('storage exceeds');
 for(const bad of [{...b,pts:null},{...b,pts:{value:1n,timeBase:pts.timeBase}},{...b,pts:{value:1n,timeBase:{num:0n,den:25n}}},{...b,pts:{value:1n,timeBase:{num:1,den:25n} as never}}])expect(()=>xstackVideoFrames([a,bad],grid,{maxFrameBytes:64})).toThrow(/timestamp/);
 expect(xstackVideoFrames([a,{...b,pts:{value:pts.value*2n,timeBase:{num:1n,den:50n}}}],grid,{maxFrameBytes:64}).pts).toEqual(pts);
 const min={value:-(1n<<63n),timeBase:pts.timeBase};expect(xstackVideoFrames([{...a,pts:min},{...b,pts:min}],grid,{maxFrameBytes:64}).pts!.value).toBe(-(1n<<63n)+1n);
 expect(xstackVideoFrames([{...a,pts:null},{...b,pts:null}],grid,{maxFrameBytes:64}).pts).toBeNull();
 expect(()=>xstackVideoFrames([a,frame('gray',3,3,2)],layoutOf('0_0|w0_0',2),{maxFrameBytes:64})).toThrow('uncovered');
 const controller=new AbortController();controller.abort();expect(()=>xstackVideoFrames([a,b],grid,{maxFrameBytes:64,signal:controller.signal})).toThrow();
 let calls=0;const signal={throwIfAborted(){if(++calls>3)throw new Error('stop');}} as AbortSignal;expect(()=>xstackVideoFrames([a,b],grid,{maxFrameBytes:64,signal})).toThrow('stop');
});
it('plans branch joins on the graph path with mixed sizes that tile exactly',()=>{
 const plan=compileMultiInputVideoFilterGraph('[a][b][c]xstack=inputs=3:layout=0_0|0_h0|w1_h0[o]').plan([shape(4,2),shape(2,3),shape(2,3)],[null]),inputs=[frame('gray',4,2,1),frame('gray',2,3,2),frame('gray',2,3,3)];
 const mixed=plan.applyBatch(inputs,{maxFrameBytes:4096,maxStateBytes:plan.stateBytes,maxResidentBytes:1<<20})[0]!,[top,left,right]=inputs.map(input=>tight(input));expect([mixed.width,mixed.height]).toEqual([4,5]);expect(tight(mixed)).toEqual([...top!,...left!.map((row,y)=>[...row,...right![y]!])]);
 const graph=compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a][b][c][d]xstack=grid=2x2[o]').plan(shape(3,2),[null]),output=graph.apply(frame('gray',3,2,5),{maxFrameBytes:4096,maxStateBytes:graph.stateBytes,maxResidentBytes:1<<20})[0]!;
 expect([output.width,output.height]).toEqual([6,4]);const rows=tight(frame('gray',3,2,5));expect(tight(output)).toEqual([...rows,...rows].map(row=>[...row,...row]));
});
