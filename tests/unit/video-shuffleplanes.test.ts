import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiationOrder,negotiableFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {shuffleplanesFormats,shuffleplanesOperator,shuffleVideoPlanes,VideoShuffleplanesError} from '../../packages/avfilter/src/video-ops/shuffleplanes.js';
import type {ShuffleplanesMap} from '../../packages/avfilter/src/video-ops/shuffleplanes.js';
const parse=(options:string|null)=>shuffleplanesOperator.parse!({name:'shuffleplanes',options} as never).configuration;
const frame=(pixelFormat:string,width:number,height:number,pad=0):VideoFrameData=>{const layout=pixelLayout(pixelFormat,width,height);return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},(_,i)=>index*64+i)),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}};};
it('parses the declared defaults, shorthand order and named maps into frozen steps',()=>{
 expect(parse(null)).toEqual({name:'shuffleplanes',map:[0,1,2,3]});expect(Object.isFrozen(parse(null))).toBe(true);expect(Object.isFrozen(parse(null).map)).toBe(true);
 expect(parse('3:1:2:0').map).toEqual([3,1,2,0]);expect(parse('0:0:0:0').map).toEqual([0,0,0,0]);expect(parse('map3=0:map0=3').map).toEqual([3,1,2,0]);expect(parse('0:2:1:0:map3=3').map).toEqual([0,2,1,3]);expect(parse('map1=2:map2=1:map3=0').map).toEqual([0,2,1,0]);
 for(const options of ['4','map0=-1','map0=1+0','map0=01','map0=','map0=0x1','map0=1.0','enable=1','0:0:0:0:enable=1','threads=1','map4=0','0:0:0:0:0'])expect(()=>parse(options),options).toThrow();
 expect(()=>parse('enable=1')).toThrow('timeline');
 // Native lists four-plane formats for every map, so 3:3:3:3 parses; its picks have no frame storage here and are refused by name.
 expect(parse('3:3:3:3').map).toEqual([3,3,3,3]);expect(parse('1:0:0:0:map0=3').map).toEqual([3,0,0,0]);expect(()=>compileVideoFilterChain('shuffleplanes=3:3:3:3').plan('yuva420p',4,2)).toThrow('Video filter shuffleplanes input negotiates yuva444p, which is not implemented');
});
it('derives every per-step format list from the native query_formats rule for all 256 tuples',()=>{
 let runnable=0,entries=0;
 for(let code=0;code<256;code++){
  // The members with frame storage, derived independently from the plane layouts.
  const map=[code&3,code>>2&3,code>>4&3,code>>6&3] as unknown as ShuffleplanesMap,expected=negotiationOrder.filter(format=>{
   const layout=pixelLayout(format,4,4),planes=layout.planes.length,subsampled=layout.planes.some(plane=>plane.height<4||plane.rowBytes/plane.width>0&&plane.width<4);
   for(let i=0;i<4;i++){if(map[i]!>=planes)return false;if(subsampled&&(i===1||i===2)!==(map[i]===1||map[i]===2))return false;}return true;
  }),list=shuffleplanesFormats(map),step=parse(map.join(':'));
  // Native lists every non-palette AVPixelFormat the rule admits, in AVPixelFormat order; four-plane formats admit every map.
  expect(list,map.join(':')).toEqual(negotiableFormats.filter(format=>list.includes(format)));expect(list.length,map.join(':')).toBeGreaterThan(0);expect(list).not.toContain('pal8');entries+=list.length;
  expect(list.filter(executableFormat),map.join(':')).toEqual(expected);expect(shuffleplanesOperator.formats!(step)).toBe(list);if(expected.length)runnable++;
  for(const format of negotiationOrder)if(expected.includes(format))expect(()=>shuffleplanesOperator.validate!(format,step)).not.toThrow();else expect(()=>shuffleplanesOperator.validate!(format,step),format).toThrow(VideoShuffleplanesError);
 }
 // 9,619 entries over the 256 lists, as the pinned libavutil gives them (av_pix_fmt_count_planes, log2_chroma_w/h, PAL flag).
 expect([runnable,entries]).toEqual([93,9619]);expect(shuffleplanesFormats([0,1,2,3])).toEqual('yuva420p yuva422p yuva444p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva444p9be yuva444p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva444p10be yuva444p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva444p16be yuva444p16le gbrap gbrap16be gbrap16le gbrap12be gbrap12le gbrap10be gbrap10le gbrapf32be gbrapf32le yuva422p12be yuva422p12le yuva444p12be yuva444p12le gbrap14be gbrap14le gbrapf16be gbrapf16le gbrap32be gbrap32le'.split(' '));expect(shuffleplanesFormats([0,1,2,3]).filter(executableFormat)).toEqual(['yuva420p']);
 expect(shuffleplanesFormats([0,1,1,0])).toContain('nv12');expect(shuffleplanesFormats([0,1,1,1])).not.toContain('nv12');
 expect(videoOperator('shuffleplanes')).toBe(shuffleplanesOperator);expect(shuffleplanesOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('remaps and duplicates planes into owned tight planes from padded input without mutating it',()=>{
 const input=frame('yuva420p',4,2,3),snapshot=input.planes.map(plane=>[...plane]),actual=shuffleVideoPlanes(input,parse('3:2:1:0'),{maxFrameBytes:64});
 expect(actual.linesizes).toEqual([4,2,2,4]);expect([...actual.planes[0]!]).toEqual([192,193,194,195,199,200,201,202]);expect([...actual.planes[1]!]).toEqual([128,129]);expect([...actual.planes[2]!]).toEqual([64,65]);expect([...actual.planes[3]!]).toEqual([0,1,2,3,7,8,9,10]);
 expect(input.planes.map(plane=>[...plane])).toEqual(snapshot);expect(actual.planes.every(plane=>!input.planes.some(source=>source.buffer===plane.buffer))).toBe(true);expect(actual.pts).toEqual(input.pts);expect(actual.pts).not.toBe(input.pts);expect(actual.metadata).toEqual({colorRange:2});
 const duplicated=shuffleVideoPlanes(frame('gbrp',2,1),parse('2:2:2:0'),{maxFrameBytes:6});expect(duplicated.planes.map(plane=>[...plane])).toEqual([[128,129],[128,129],[128,129]]);expect(duplicated.planes[0]).not.toBe(duplicated.planes[1]);
 const packed=shuffleVideoPlanes(frame('rgba',1,1),parse('0:0:0:0'),{maxFrameBytes:4});expect([...packed.planes[0]!]).toEqual([0,1,2,3]);
 expect(shuffleVideoPlanes({...frame('nv12',2,2),pts:null},parse('0:1:1:0'),{maxFrameBytes:6}).pts).toBeNull();
});
it('rejects unsupported formats, budgets, malformed strides and cancellation explicitly',()=>{
 const step=parse('0:0:0:0');
 for(const format of ['yuv420p','nv12','yuva420p'])expect(()=>shuffleVideoPlanes(frame(format,2,2),step,{maxFrameBytes:64}),format).toThrow('not supported for this mapping');
 expect(()=>shuffleVideoPlanes(frame('gray',3,2),parse(null),{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>shuffleVideoPlanes(frame('gray',3,2),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>shuffleVideoPlanes(frame('gray',3,2,1),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>shuffleVideoPlanes(frame('gray',3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 const short=frame('gray',3,2);short.planes[0]=new Uint8Array(5);expect(()=>shuffleVideoPlanes(short,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const narrow=frame('gray',3,2);narrow.linesizes[0]=2;expect(()=>shuffleVideoPlanes(narrow,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const fractional=frame('gray',3,2);fractional.linesizes[0]=3.5;expect(()=>shuffleVideoPlanes(fractional,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const missing=frame('gbrp',3,2);missing.planes.pop();expect(()=>shuffleVideoPlanes(missing,step,{maxFrameBytes:64})).toThrow('plane count');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>shuffleVideoPlanes(frame('gray',3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans shuffleplanes through linear, graph and actor planners and refuses timelines and commands',()=>{
 const plan=compileVideoFilterChain('shuffleplanes=0:2:1:0,hflip').plan('yuv444p',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['shuffleplanes','yuv444p'],['hflip','yuv444p']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('shuffleplanes').plan('yuv420p',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuva420p'],['shuffleplanes','yuva420p']]);
 // Native converts yuv444p, yuv422p and rgba to yuva444p, yuva422p and gbrap for the default map (tests/differential/video-shuffleplanes.test.ts).
 for(const [source,format]of [['yuv444p','yuva444p'],['yuv422p','yuva422p'],['rgba','gbrap']] as const)expect(()=>compileVideoFilterChain('shuffleplanes').plan(source,4,2),source).toThrow(`Video filter shuffleplanes input negotiates ${format}, which is not implemented`);
 const output=plan.apply(frame('yuv444p',5,3),{maxFrameBytes:45,maxStateBytes:0});expect(output.planes[1]![4]).toBe(128);expect(()=>plan.apply(frame('yuv444p',5,3),{maxFrameBytes:44,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]shuffleplanes=0:1:1:0[out]').plan({format:'nv12',width:4,height:2},[null]);expect(graph.negotiated.nodes[0]!.inputs[0]!.format).toBe('nv12');
 for(const description of ['shuffleplanes=enable=1','shuffleplanes=0:0:0:0:enable=gt(t\\,1)'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),description).toThrow();
 expect(shuffleplanesOperator.timeline).toBeUndefined();expect(shuffleplanesOperator.geometryCommands).toBeUndefined();
});
