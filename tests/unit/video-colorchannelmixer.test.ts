import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiableFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {colorchannelmixerOperator,colorchannelmixerPixelFormats,colorchannelmixerTables,mixVideoChannels,parseColorchannelmixerOptions,VideoColorchannelmixerError} from '../../packages/avfilter/src/video-ops/colorchannelmixer.js';
const parse=(options:string|null)=>colorchannelmixerOperator.parse!({name:'colorchannelmixer',options} as never).configuration;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const frame=(pixelFormat:string,width:number,height:number,pad=0):VideoFrameData=>{const layout=pixelLayout(pixelFormat,width,height);return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},(_,i)=>(index*64+i*37)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}};};
it('parses defaults, the declared shorthand order, named gains, constants and pa into frozen steps',()=>{
 expect(parse(null)).toEqual({name:'colorchannelmixer',gains:identity,preserveAmount:0});expect(Object.isFrozen(parse(null))).toBe(true);expect(Object.isFrozen(parse(null).gains)).toBe(true);
 expect(parse('.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131').gains).toEqual([.393,.769,.189,0,.349,.686,.168,0,.272,.534,.131,0,0,0,0,1]);
 expect(parse('rr=-2:gg=2:aa=0.5:ar=1e-1').gains).toEqual([-2,0,0,0,0,2,0,0,0,0,1,0,.1,0,0,.5]);
 expect(parse('1:0:0:0:0:1:0:0:0:0:1:0:0:0:0:1:none:0.25')).toEqual({name:'colorchannelmixer',gains:identity,preserveAmount:.25});
 expect(parse('rr=max:gg=min:bb=none:aa=default').gains).toEqual([2,0,0,0,0,-2,0,0,0,0,0,0,0,0,0,1]);
 expect(parse('pc=none:pa=1').preserveAmount).toBe(1);expect(parse('pc=0').preserveAmount).toBe(0);expect(parse('pc=0.5').preserveAmount).toBe(0);expect(parse('pa=max').preserveAmount).toBe(1);
 expect(parseColorchannelmixerOptions('rb=+.5').gains[2]).toBe(.5);
});
it('refuses preserve modes, timelines, out-of-range and non-constant values, and unknown options before planning',()=>{
 for(const pc of ['lum','max','avg','sum','nrm','pwr','1','6','1.5','0.6'])expect(()=>parse(`pc=${pc}`),pc).toThrow('pc other than none');
 expect(()=>parse('pc=lum:pa=0')).toThrow('pc other than none');
 for(const pc of ['7','-1','all','2.5e1'])expect(()=>parse(`pc=${pc}`),pc).toThrow('outside 0..6');
 for(const options of ['rr=2.0001','rr=-3','gg=1e1','pa=-0.1','pa=1.5','ar=all'])expect(()=>parse(options),options).toThrow(/outside|Only constant/);
 for(const options of ['rr=1/3','rr=0x1','rr=nan','rr=inf','rr=','rr=1k','pc=lum+0','pa=sqrt(0.25)'])expect(()=>parse(options),options).toThrow('Only constant');
 expect(()=>parse('enable=1')).toThrow('timeline');expect(()=>parse('rr=1:enable=gt(t\\,1)')).toThrow('timeline');
 for(const options of ['threads=1','r=1','1:0:0:0:0:1:0:0:0:0:1:0:0:0:0:1:none:0:1'])expect(()=>parse(options),options).toThrow();
});
it('lists native query_formats in declared order and executes only the members with frame storage',()=>{
 expect(colorchannelmixerPixelFormats.every(format=>negotiableFormats.includes(format))).toBe(true);expect(new Set(colorchannelmixerPixelFormats).size).toBe(26);
 expect(colorchannelmixerPixelFormats.filter(executableFormat)).toEqual(['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']);
 expect(colorchannelmixerOperator.formats!(parse(null))).toBe(colorchannelmixerPixelFormats);expect(videoOperator('colorchannelmixer')).toBe(colorchannelmixerOperator);
 expect(colorchannelmixerOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('builds lrint tables with round-half-to-even products',()=>{
 const lut=colorchannelmixerTables([.5,-.5,1.5,-1.5,.25,-.25,2,-2,0,1,.125,.75,-.75,.1,-.1,1]);
 expect([...lut.subarray(0,8)]).toEqual([0,0,1,2,2,2,3,4]);expect([...lut.subarray(256,264)]).toEqual([0,0,-1,-2,-2,-2,-3,-4]);
 expect([...lut.subarray(512,518)]).toEqual([0,2,3,4,6,8]);expect([...lut.subarray(768,772)]).toEqual([0,-2,-3,-4]);
 expect([lut[1024+2],lut[1024+6],lut[1024+10],lut[1280+2],lut[1280+6]]).toEqual([0,2,2,0,-2]);expect(lut[1536+255]).toBe(510);expect(lut[1792+255]).toBe(-510);
 expect([lut[2560+4],lut[2560+12],lut[2560+20]]).toEqual([0,2,2]);expect(lut[3328+5]).toBe(0);expect(lut[3328+15]).toBe(2);expect(lut[3840+255]).toBe(255);
});
it('mixes packed and planar channels into owned tight planes from padded input without mutating it',()=>{
 const sepia=parse('.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
 const rgba=frame('rgba',3,2,5),snapshot=rgba.planes.map(plane=>[...plane]),out=mixVideoChannels(rgba,parse('rr=0:ra=1:ga=-1:gg=1:ba=0.5:ar=1:aa=0'),{maxFrameBytes:34});
 expect(rgba.planes.map(plane=>[...plane])).toEqual(snapshot);expect(out.linesizes).toEqual([12]);expect(out.planes[0]!.buffer).not.toBe(rgba.planes[0]!.buffer);expect(out.pts).toEqual(rgba.pts);expect(out.pts).not.toBe(rgba.pts);expect(out.metadata).toEqual({colorRange:2});
 // Independent reference: lrint with ties to even, summed per output channel and clipped to 0..255.
 const even=(v:number)=>{const f=Math.floor(v);return v-f===0.5?(f%2===0?f:f+1):Math.round(v);},c=(v:number)=>Math.min(255,Math.max(0,v)),source=rgba.planes[0]!;
 for(let y=0;y<2;y++)for(let x=0;x<3;x++){const o=y*17+x*4,[r,g,b,a]=[source[o]!,source[o+1]!,source[o+2]!,source[o+3]!];expect([...out.planes[0]!.subarray(y*12+x*4,y*12+x*4+4)]).toEqual([c(a),c(g-a),c(b+even(a*.5)),c(r)]);}
 // bgra, argb and abgr reorder the same mix through the rgba map.
 const pixel=(format:string,bytes:number[])=>[...mixVideoChannels({width:1,height:1,pixelFormat:format,planes:[Uint8Array.from(bytes)],linesizes:[bytes.length],pts:null,metadata:{}},sepia,{maxFrameBytes:4}).planes[0]!];
 const expected=pixel('rgba',[200,100,50,7]);expect(expected).toEqual([Math.min(255,Math.round(200*.393)+Math.round(100*.769)+Math.round(50*.189)),Math.round(200*.349)+Math.round(100*.686)+Math.round(50*.168),Math.round(200*.272)+Math.round(100*.534)+Math.round(50*.131),7]);
 expect(pixel('bgra',[50,100,200,7])).toEqual([expected[2],expected[1],expected[0],7]);expect(pixel('argb',[7,200,100,50])).toEqual([7,...expected.slice(0,3)]);expect(pixel('abgr',[7,50,100,200])).toEqual([7,expected[2],expected[1],expected[0]]);
 expect(pixel('rgb24',[200,100,50])).toEqual(expected.slice(0,3));expect(pixel('bgr24',[50,100,200])).toEqual([expected[2],expected[1],expected[0]]);
 // rgb24 has no alpha: ra and aa are never applied.
 expect(pixel('rgb24',[10,20,30])).toEqual(pixel('rgb24',[10,20,30]));expect([...mixVideoChannels({width:1,height:1,pixelFormat:'rgb24',planes:[Uint8Array.of(10,20,30)],linesizes:[3],pts:null,metadata:{}},parse('ra=2:ga=2:ba=2'),{maxFrameBytes:3}).planes[0]!]).toEqual([10,20,30]);
 // gbrp planes are G, B, R.
 const planar=mixVideoChannels({width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(100,0),Uint8Array.of(50,255),Uint8Array.of(200,9)],linesizes:[2,2,2],pts:null,metadata:{}},sepia,{maxFrameBytes:6});
 expect(planar.planes.map(plane=>plane[0])).toEqual([expected[1],expected[2],expected[0]]);expect(planar.pts).toBeNull();
});
it('rejects unsupported formats, budgets, malformed strides and cancellation explicitly',()=>{
 const step=parse(null);
 for(const format of ['yuv420p','gray','nv12','yuva420p','rgb0','0rgb'])expect(()=>mixVideoChannels(frame(format,2,2),step,{maxFrameBytes:64}),format).toThrow(VideoColorchannelmixerError);
 expect(()=>mixVideoChannels(frame('rgb24',3,2),step,{maxFrameBytes:17})).toThrow('allocation limit');expect(()=>mixVideoChannels(frame('rgb24',3,2,1),step,{maxFrameBytes:19})).toThrow('storage exceeds');expect(()=>mixVideoChannels(frame('rgb24',3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 const short=frame('rgba',3,2);short.planes[0]=new Uint8Array(23);expect(()=>mixVideoChannels(short,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const narrow=frame('rgba',3,2);narrow.linesizes[0]=11;expect(()=>mixVideoChannels(narrow,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const fractional=frame('gbrp',3,2);fractional.linesizes[1]=3.5;expect(()=>mixVideoChannels(fractional,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const missing=frame('gbrp',3,2);missing.planes.pop();expect(()=>mixVideoChannels(missing,step,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>mixVideoChannels(frame('rgb24',1,1),{name:'colorchannelmixer',gains:[3,...identity.slice(1)],preserveAmount:0},{maxFrameBytes:64})).toThrow('settings');
 expect(()=>mixVideoChannels({...frame('rgb24',1,1),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>mixVideoChannels(frame('rgb24',3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans colorchannelmixer through linear, graph and actor planners and refuses timelines and commands',()=>{
 const plan=compileVideoFilterChain('colorchannelmixer=rr=0.5,hflip').plan('rgba',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['colorchannelmixer','rgba'],['hflip','rgba']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('colorchannelmixer').plan('gray',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','rgb24'],['colorchannelmixer','rgb24']]);
 const output=plan.apply(frame('rgba',5,3),{maxFrameBytes:60,maxStateBytes:0});expect(output.planes[0]!.length).toBe(60);expect(()=>plan.apply(frame('rgba',5,3),{maxFrameBytes:59,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]colorchannelmixer[out]').plan({format:'gbrp',width:4,height:2},[null]);expect(graph.negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
 for(const description of ['colorchannelmixer=enable=1','colorchannelmixer=rr=1:enable=gt(t\\,1)','colorchannelmixer=pc=lum'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),description).toThrow();
 expect(colorchannelmixerOperator.timeline).toBeUndefined();expect(colorchannelmixerOperator.geometryCommands).toBeUndefined();
});
