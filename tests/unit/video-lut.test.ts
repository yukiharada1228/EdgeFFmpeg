import {describe,expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {lutGeometry,lutPixelFormats,lutTables,lutVideoFrame,parseLutOptions,VideoLutError} from '../../packages/avfilter/src/video-lut.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {lutOperator} from '../../packages/avfilter/src/video-ops/lut.js';
import {lutrgbOperator} from '../../packages/avfilter/src/video-ops/lutrgb.js';
import {lutyuvOperator} from '../../packages/avfilter/src/video-ops/lutyuv.js';
const frame=(format:string,width:number,height:number,seed=7,pad=0):VideoFrameData=>{const layout=pixelLayout(format,width,height);return {width,height,pixelFormat:format,planes:layout.planes.map(plane=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;})),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:3n,timeBase:{num:1n,den:25n}},metadata:{}};};
const options={maxFrameBytes:1<<16};
describe('lut option parsing',()=>{
 it('parses defaults, the eleven-entry shorthand order and aliases with the later option winning into frozen steps',()=>{
  expect(parseLutOptions('lut',null)).toEqual({name:'lut',expressions:['clipval','clipval','clipval','clipval']});
  expect(parseLutOptions('lut','a:b:c:d:e').expressions).toEqual(['e','b','c','d']);
  expect(parseLutOptions('lutrgb','1:2:3:4:5:6:7:8:9:10:11').expressions).toEqual(['8','9','10','11']);
  expect(parseLutOptions('lutyuv','y=negval:c0=val:u=1:g=2:v=3:b=4:a=5').expressions).toEqual(['val','2','4','5']);
  expect(parseLutOptions('lut','c0=clip(val\\,16\\,235)').expressions[0]).toBe('clip(val,16,235)');
  const step=parseLutOptions('lut','r=negval');expect(Object.isFrozen(step)&&Object.isFrozen(step.expressions)).toBe(true);
 });
 it('refuses enable=, unknown options, gammaval, unported functions and ^ with named messages',()=>{
  const refused:readonly [string,string,string][]=[['lut','enable=1','Lut timeline expressions are not implemented'],['lutyuv','y=val:enable=gt(t\\,1)','Lutyuv timeline expressions are not implemented'],['lutrgb','x=1','Unsupported lutrgb option'],
   ['lut','gammaval(0.5)','Lut gammaval() and gammaval709() are not implemented'],['lut','c2=gammaval709(2.2)','Lut gammaval() and gammaval709() are not implemented'],['lut','sin(val)','Lut expression function sin() is not implemented'],
   ['lut','val*squish(1)','Lut expression function squish() is not implemented'],['lut','atan2(val\\,1)','Lut expression function atan2() is not implemented'],['lut','time(0)','Lut expression function time() is not implemented'],
   ['lut','root(val-ld(0)\\,1)','Lut expression function root() is not implemented'],['lut','val^ 2','Lut expression operator ^ is not implemented']];
  for(const [name,text,message]of refused){expect(()=>parseLutOptions(name as 'lut',text),text).toThrow(VideoFilterParseError);expect(()=>parseLutOptions(name as 'lut',text),text).toThrow(message);}
  // Syntax is checked in configure, for the components the negotiated format has, as native config_props does.
  expect(()=>parseLutOptions('lut','c1=clip(val)')).not.toThrow();
 });
});
describe('lut tables',()=>{
 it('builds limited YUV and full-range RGB, gray and legacy yuvj tables with truncation and the final 0..255 clip',()=>{
  const [y,u,v,a]=lutTables(parseLutOptions('lut','negval:negval:negval:negval'),'yuva420p',4,4) as Uint8Array[];
  expect([y![0],y![16],y![100],y![235],y![255]]).toEqual([235,235,151,16,16]);expect([u![0],u![240],v![128]]).toEqual([240,16,128]);expect([a![0],a![255]]).toEqual([255,0]);
  expect(lutTables(parseLutOptions('lut','negval'),'yuvj420p',2,2)[0]![10]).toBe(245);expect(lutTables(parseLutOptions('lut','negval'),'gray',2,2)[0]![10]).toBe(245);
  const [r,g,b]=lutTables(parseLutOptions('lutrgb','r=-val+300.7:g=val*1.5-0.5:b=-0.99'),'rgb24',1,1) as Uint8Array[];
  expect([r![0],r![50],r![255]]).toEqual([255,250,45]);expect([g![1],g![2],g![200]]).toEqual([1,2,255]);expect(b!.every(value=>value===0)).toBe(true);
  expect(lutTables(parseLutOptions('lut','w*10+h+val'),'gray',3,2)[0]![0]).toBe(32);expect(lutTables(parseLutOptions('lut','w*10+h+val'),'gray',4,2)[0]![0]).toBe(42);
  const state=lutTables(parseLutOptions('lut','st(0\\,ld(0)+1)'),'gray',1,1)[0]!;expect([state[0],state[9],state[254],state[255]]).toEqual([1,10,255,255]);
 });
 it('refuses NaN anywhere in the 65536 entries, out-of-int values in the used entries and profile-dependent results',()=>{
  const refused:readonly [string,string,string][]=[['0/0','gray','evaluates to NaN'],['if(gt(val\\,60000)\\,0/0\\,val)','gray','evaluates to NaN'],['clip(val)','gray','Invalid lut expression'],['c1=clip(val)','rgb24','Invalid lut expression'],
   ['1e10','gray','outside the int range'],['-2147483649','gray','outside the int range'],['(val+1)/0','rgba','outside the int range'],['hypot(val\\,20)','gray','depends on the numeric profile'],['while(1\\,1)','gray','failed for the value 0']];
  for(const [text,format,message]of refused){expect(()=>lutTables(parseLutOptions('lut',text),format,2,2),text).toThrow(VideoLutError);expect(()=>lutTables(parseLutOptions('lut',text),format,2,2),text).toThrow(message);}
  expect(lutTables(parseLutOptions('lut','if(gt(val\\,255)\\,1e10\\,val)'),'gray',1,1)[0]![255]).toBe(255);
  expect(lutTables(parseLutOptions('lut','-2147483648.9+val'),'gray',1,1)[0]![0]).toBe(0);
  expect(lutTables(parseLutOptions('lut','c1=clip(val):c3=0/0'),'gray',1,1)).toHaveLength(1);
  expect(()=>lutTables(parseLutOptions('lutrgb',null),'yuv420p',2,2)).toThrow('Lut pixel format yuv420p is not supported');
  expect(()=>lutTables(parseLutOptions('lut',null),'gray',0,2)).toThrow('Invalid lut frame size');
 });
 it('refuses in geometry on the negotiated input and leaves formats without storage to the negotiators',()=>{
  expect(lutGeometry(parseLutOptions('lut','val'),{format:'gray',width:5,height:3})).toEqual({width:5,height:3});
  expect(()=>lutGeometry(parseLutOptions('lut','0/0'),{format:'rgb24',width:5,height:3})).toThrow('evaluates to NaN');
  expect(lutGeometry(parseLutOptions('lutyuv','0/0'),{format:'yuva444p',width:5,height:3})).toEqual({width:5,height:3});
 });
});
describe('lut frames',()=>{
 it('maps packed components through ff_fill_rgba_map and gbrp planes through their components',()=>{
  const step=parseLutOptions('lutrgb','r=1:g=2:b=3:a=4');
  for(const [format,expected]of [['rgb24',[1,2,3]],['bgr24',[3,2,1]],['rgba',[1,2,3,4]],['bgra',[3,2,1,4]],['argb',[4,1,2,3]],['abgr',[4,3,2,1]]] as const)expect(Array.from(lutVideoFrame(frame(format,2,1),step,options).planes[0]!),format).toEqual([...expected,...expected]);
  expect(lutVideoFrame(frame('gbrp',2,1),step,options).planes.map(plane=>Array.from(plane))).toEqual([[2,2],[3,3],[1,1]]);
  expect(lutVideoFrame(frame('yuva420p',3,3),parseLutOptions('lut','1:2:3:4'),options).planes.map(plane=>plane[0])).toEqual([1,2,3,4]);
 });
 it('uses the full range for a legacy yuvj link tagged with the JPEG range',()=>{
  const input={...frame('yuv420p',2,2),metadata:{colorRange:2}},output=lutVideoFrame(input,parseLutOptions('lutyuv','negval'),options);
  expect(Array.from(output.planes[0]!)).toEqual(Array.from(input.planes[0]!,value=>255-value));expect(output.pixelFormat).toBe('yuv420p');
  const limited=lutVideoFrame(frame('yuv420p',2,2),parseLutOptions('lutyuv','negval'),options);expect(limited.planes[0]!.every(value=>value>=16&&value<=235)).toBe(true);
  expect(lutVideoFrame({...frame('yuva420p',2,2),metadata:{colorRange:2}},parseLutOptions('lut','negval'),options).planes[0]!.every(value=>value>=16&&value<=235)).toBe(true);
 });
 it('reads padded strides, does not mutate the input, returns owned tight planes and keeps pts and metadata',()=>{
  const input=frame('yuv422p',5,3,11,3),copy=input.planes.map(plane=>plane.slice()),output=lutVideoFrame({...input,metadata:{note:1}},parseLutOptions('lut','negval'),options);
  expect(input.planes).toEqual(copy);expect(output.linesizes).toEqual([5,3,3]);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
  expect(output.planes[0]![5]).toBe(Math.min(235,Math.max(16,251-input.planes[0]![8]!)));expect(output.pts).toEqual({value:3n,timeBase:{num:1n,den:25n}});expect(output.metadata).toEqual({note:1});
 });
 it('refuses oversized frames, malformed strides and storage, bad time bases, bad settings and aborted signals',()=>{
  const step=parseLutOptions('lut','negval'),input=frame('gray',4,4);
  expect(()=>lutVideoFrame(input,step,{maxFrameBytes:15})).toThrow('Lut frame exceeds allocation limit');
  expect(()=>lutVideoFrame({...frame('gray',4,4,7,4)},step,{maxFrameBytes:20})).toThrow('Lut input plane storage exceeds allocation limit');
  expect(()=>lutVideoFrame({...input,linesizes:[3]},step,options)).toThrow('Invalid lut plane stride or storage');
  expect(()=>lutVideoFrame({...input,planes:[input.planes[0]!.subarray(1)]},step,options)).toThrow('Invalid lut plane stride or storage');
  expect(()=>lutVideoFrame({...input,planes:[]},step,options)).toThrow('Invalid lut plane count');
  expect(()=>lutVideoFrame({...input,pts:{value:0n,timeBase:{num:0n,den:1n}}},step,options)).toThrow('Invalid lut timestamp time base');
  expect(()=>lutVideoFrame(input,{name:'lut',expressions:['val']} as never,options)).toThrow('Invalid lut settings');
  expect(()=>lutVideoFrame(frame('nv12',2,2),step,options)).toThrow('Lut pixel format nv12 is not supported');
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>lutVideoFrame(input,step,{...options,signal:controller.signal})).toThrow('stop');
 });
});
describe('lut descriptors',()=>{
 it('declare the native lists in order on every path and refuse runtime commands',()=>{
  expect(lutyuvOperator.formats!(parseLutOptions('lutyuv',null) as never)).toEqual(lutPixelFormats.lutyuv);expect(lutPixelFormats.lutyuv.slice(0,4)).toEqual(['yuv444p','yuv422p','yuv420p','yuv411p']);
  expect(lutrgbOperator.formats!(parseLutOptions('lutrgb',null) as never).slice(0,6)).toEqual(['argb','rgba','abgr','bgra','rgb24','bgr24']);
  expect(lutOperator.formats!(parseLutOptions('lut',null) as never)).toEqual([...lutPixelFormats.lutrgb,...lutPixelFormats.lutyuv,'gray','gray9le','gray10le','gray12le','gray14le','gray16le']);
  for(const operator of [lutOperator,lutrgbOperator,lutyuvOperator]){expect(operator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(operator.timeline).toBeUndefined();expect(operator.geometryCommands).toBeUndefined();expect(operator.jpegSiblings).toBeUndefined();}
  expect(lutrgbOperator.parse!({name:'lutrgb',options:'g=negval'} as never).configuration).toEqual({name:'lutrgb',expressions:['clipval','negval','clipval','clipval']});
 });
});
