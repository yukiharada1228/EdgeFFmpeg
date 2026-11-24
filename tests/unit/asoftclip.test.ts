import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {asoftclip,asoftclipFloatCoefficients,asoftclipKernel} from '../../packages/avfilter/src/audio/asoftclip.js';
import type {AudioSoftClipStep} from '../../packages/avfilter/src/audio/asoftclip.js';

async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>asoftclip.parse(text);
/** Direct transcription of filter_flt/filter_dbl for ASC_HARD and ASC_ALG at oversample=1, rounding through a Float32Array cell instead of Math.fround. */
function transcription(s:AudioSoftClipStep,values:readonly number[],float:boolean):number[]{
  if(!float){const threshold=s.threshold,gain=s.output*threshold,factor=1/threshold,param=s.param;return values.map(x=>{if(s.type==='hard'){const v=x*factor;return (v<-1?-1:v>1?1:v)*gain;}const sample=x*factor;return sample/Math.sqrt(param+sample*sample)*gain;});}
  const f=new Float32Array(1),r=(v:number)=>{f[0]=v;return f[0];};
  const threshold=r(s.threshold),gain=r(s.output*threshold),factor=r(1/threshold),param=r(s.param);
  return values.map(x=>{
    if(s.type==='hard'){let d=r(x*factor);d=d<-1?-1:d>1?1:d;return r(d*gain);}
    const sample=r(x*factor),square=r(sample*sample),root=r(Math.sqrt(r(param+square)));return r(r(sample/root)*gain);
  });
}
function frame(format:AudioSampleFormat,channels:number,values:readonly number[]):AudioFrameData{
  const width=format.startsWith('dbl')?8:4,samples=values.length/channels,data=new Uint8Array(values.length*width),view=new DataView(data.buffer),planar=format.endsWith('p');
  values.forEach((value,index)=>{const channel=index%channels,sample=Math.floor(index/channels),offset=(planar?channel*samples+sample:index)*width;if(width===4)view.setFloat32(offset,value,true);else view.setFloat64(offset,value,true);});
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples,planes:planar?Array.from({length:channels},(_,c)=>data.subarray(c*samples*width,(c+1)*samples*width)):[data],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
}
function read(output:AudioFrameData):number[]{
  const width=output.sampleFormat.startsWith('dbl')?8:4,planar=output.sampleFormat.endsWith('p'),values:number[]=[];
  for(let sample=0;sample<output.samples;sample++)for(let channel=0;channel<output.channels;channel++){const plane=output.planes[planar?channel:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),offset=(planar?sample:sample*output.channels+channel)*width;values.push(width===4?view.getFloat32(offset,true):view.getFloat64(offset,true));}
  return values;
}
const samples=(count:number)=>Array.from({length:count},(_,i)=>i===0?0:i===1?-0:Math.fround(Math.sin(i*0.37)*(1+i%5)*0.7));

it('parses hard and alg with named and positional options and refuses every libm type, oversampling and unscoped syntax with exact messages',()=>{
  expect(step('asoftclip=hard')).toEqual({name:'asoftclip',type:'hard',threshold:1,output:1,param:1});
  expect(step('asoftclip=type=alg:threshold=0.5:output=1.3:param=0.01:oversample=1')).toEqual({name:'asoftclip',type:'alg',threshold:0.5,output:1.3,param:0.01});
  expect(step('asoftclip=alg:0.001:16:3:1')).toEqual({name:'asoftclip',type:'alg',threshold:0.001,output:16,param:3});
  expect(step('asoftclip=hard:.5:output=2.')).toEqual({name:'asoftclip',type:'hard',threshold:0.5,output:2,param:1});
  expect(step('asoftclip=threshold=0.000001:type=hard:threshold=0.25')).toMatchObject({threshold:0.25});
  expect(step('asoftclip=hard:0.5:')).toEqual({name:'asoftclip',type:'hard',threshold:0.5,output:1,param:1});
  const refused:[string,string][]=[
    ['asoftclip','asoftclip type tanh requires unimplemented libm arithmetic'],
    ...['tanh','atan','cubic','exp','quintic','sin','erf'].map(type=>[`asoftclip=type=${type}`,`asoftclip type ${type} requires unimplemented libm arithmetic`] as [string,string]),
    ['asoftclip=-1','Unsupported asoftclip type: -1'],['asoftclip=type=4','Unsupported asoftclip type: 4'],['asoftclip=hard+alg','Unsupported asoftclip type: hard+alg'],
    ['asoftclip=hard:oversample=2','asoftclip oversample 2 requires its unimplemented sin/cos lowpass'],['asoftclip=alg:1:1:1:64','asoftclip oversample 64 requires its unimplemented sin/cos lowpass'],
    ['asoftclip=hard:oversample=0x2','Unsupported asoftclip oversample: 0x2'],
    ['asoftclip=hard:threshold=1e-3','Only plain decimal asoftclip threshold values are implemented: 1e-3'],['asoftclip=hard:output=1k','Only plain decimal asoftclip output values are implemented: 1k'],
    ['asoftclip=hard:threshold=0','asoftclip threshold 0 is outside 0.000001..1'],['asoftclip=hard:threshold=1.01','asoftclip threshold 1.01 is outside 0.000001..1'],
    ['asoftclip=hard:output=16.5','asoftclip output 16.5 is outside 0.000001..16'],['asoftclip=alg:param=0.001','asoftclip param 0.001 is outside 0.01..3'],['asoftclip=alg:param=-1','asoftclip param -1 is outside 0.01..3'],
    ['asoftclip=hard:enable=1','asoftclip timeline enable is not implemented'],['asoftclip=hard:foo=1','Unsupported asoftclip option: foo=1'],
    ['asoftclip=hard::0.5','Empty asoftclip option value'],['asoftclip=hard:0.5::2','Empty asoftclip option value'],['asoftclip=:hard','Empty asoftclip option value'],['asoftclip=hard::','Empty asoftclip option value'],
    ['asoftclip=type=hard:0.5','Unsupported asoftclip option: 0.5'],['asoftclip=hard:1:1:1:1:1','Unsupported asoftclip option: 1'],['asoftclipx','Unsupported audio filter: asoftclipx']
  ];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`));}
  for(const text of ['asoftclip','asoftclip=sin','asoftclip=hard:oversample=4'])expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);
});
it('mirrors the C float types: threshold rounds to float before 1/threshold and the double gain product, param rounds to float',()=>{
  const s=step('asoftclip=alg:threshold=0.3:output=1.3:param=0.7'),coefficients=asoftclipFloatCoefficients(s);
  const threshold=Math.fround(0.3);
  expect(coefficients).toEqual({factor:Math.fround(1/threshold),gain:Math.fround(1.3*threshold),param:Math.fround(0.7)});
  // Rounding 0.3 before the product differs from the double product rounded once.
  expect(Math.fround(1.3*threshold)).not.toBe(Math.fround(1.3*0.3));expect(coefficients.gain).toBe(Math.fround(1.3*threshold));
  expect(asoftclipKernel(step('asoftclip=hard:0.5:2'),true)(0.75)).toBe(2*Math.fround(0.5));
  expect(asoftclipKernel(step('asoftclip=hard:0.5:2'),false)(0.75)).toBe(1);
});
it('clips hard samples exactly at the threshold boundaries and keeps zero and negative zero',()=>{
  const hard=asoftclipKernel(step('asoftclip=hard:threshold=0.5:output=1'),true),gain=Math.fround(1*Math.fround(0.5));
  expect(hard(0.5)).toBe(gain);expect(hard(-0.5)).toBe(-gain);expect(hard(0.75)).toBe(gain);expect(hard(-10)).toBe(-gain);expect(hard(Math.fround(0.4999))).toBe(Math.fround(Math.fround(Math.fround(0.4999)*2)*gain));
  expect(Object.is(hard(0),0)).toBe(true);expect(Object.is(hard(-0),-0)).toBe(true);
  const alg=asoftclipKernel(step('asoftclip=alg'),true);expect(Object.is(alg(0),0)).toBe(true);expect(Object.is(alg(-0),-0)).toBe(true);
  const dbl=asoftclipKernel(step('asoftclip=hard:0.001:16'),false);expect(Object.is(dbl(-0),-0)).toBe(true);expect(dbl(1)).toBe(16*0.001);expect(dbl(-1)).toBe(-16*0.001);
  expect(()=>asoftclipKernel(step('asoftclip=alg:0.000001'),true)(3e38)).toThrow('asoftclip alg input overflows the float sample range');
  expect(asoftclipKernel(step('asoftclip=hard:0.000001'),true)(3e38)).toBe(Math.fround(Math.fround(0.000001)*1));
});
it('negotiates fltp for u8, s16, s32 and flt input and dblp for dbl input, with the native list and no rate conversion',()=>{
  const chain=compileAudioFilterChain('asoftclip=hard');
  expect(chain.nativeFormatLists).toBe(true);
  for(const [format,expected]of [['u8','fltp'],['s16','fltp'],['s32','fltp'],['flt','fltp'],['dbl','dblp'],['u8p','fltp'],['s16p','fltp'],['s32p','fltp'],['fltp','fltp'],['dblp','dblp']] as const)expect(chain.negotiatedSampleFormats(format),format).toEqual([expected]);
  expect(compileAudioFilterChain('asoftclip=alg,asoftclip=hard').negotiatedSampleFormats('s16')).toEqual(['fltp','fltp']);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:false,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('asoftclip with sample rate conversion is not implemented');
  for(const format of ['u8','s16','s32','flt','dbl'] as const)expect(chain.requiresScalarRounding(format),format).toBe(true);
  chain.validateInputFormat({sampleRate:8000,channels:3,channelLayout:'unspecified'});chain.validateInputFormat({sampleRate:8000,channels:2,channelLayout:'2 channels (FL+FC)'});
});
it('plans unchanged counts and packet sections and reserves one output frame',()=>{
  const chain=compileAudioFilterChain('asoftclip=hard');
  expect(chain.planSamples(13n,8000,{channels:2}).samples).toBe(13n);expect(chain.outputSamples(13n,8000,{channels:2})).toBe(13n);
  expect(chain.packetSections(13n,512n,8000,true,2)).toEqual([{samples:13n,span:512n}]);
  const reservations=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,channels:2,configuredInput:true});
  expect(reservations).toHaveLength(1);expect(reservations[0]!.reservation).toEqual({frames:1,buffers:[],stateBytes:0n});
  expect([...chain.reservations({sampleRate:8000,channels:2,sampleFormat:'s16'})]).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
});
it('matches the C transcription for hard and alg over the option grid in float and double, packed and planar, and is frame-split invariant',async()=>{
  const values=samples(2*37);let cases=0;
  for(const type of ['hard','alg'])for(const threshold of ['1','0.5','0.001'])for(const output of ['1','1.3','16'])for(const param of ['0.01','1','3']){
    const text=`asoftclip=${type}:${threshold}:${output}:${param}`,chain=compileAudioFilterChain(text),s=step(text);
    for(const format of ['flt','fltp','dbl','dblp'] as const){
      const float=format.startsWith('flt'),source=frame(format,2,values),before=source.planes.map(plane=>plane.slice());
      const output=chain.apply(source,{maxFrameBytes:4096}),expected=transcription(s,values.map(v=>float?v:v),float);
      expect(output.sampleFormat).toBe(float?'fltp':'dblp');
      const actual=read(output);expect(actual.length).toBe(expected.length);
      for(let i=0;i<actual.length;i++)if(!Object.is(actual[i],expected[i]))throw new Error(`${text} ${format} ${i}: ${actual[i]} != ${expected[i]}`);
      // Ownership: the input is untouched and the output shares none of its storage.
      source.planes.forEach((plane,index)=>expect(plane).toEqual(before[index]));for(const plane of output.planes)for(const original of source.planes)expect(plane.buffer).not.toBe(original.buffer);
      const parts=[frame(format,2,values.slice(0,2*5)),frame(format,2,values.slice(2*5,2*6)),frame(format,2,values.slice(2*6))];
      const split=(await collect(chain.process(input(...parts),{maxFrameBytes:4096}))).flatMap(read);
      expect(split.every((value,index)=>Object.is(value,actual[index]))&&split.length===actual.length,`${text} ${format} split`).toBe(true);cases++;
    }
  }
  expect(cases).toBe(216);
});
it('converts integer input to fltp exactly as the float transcription of the converted samples',()=>{
  const data=new Uint8Array(16),view=new DataView(data.buffer);[0,-32768,32767,12345,-1,1,-20000,16384].forEach((v,i)=>view.setInt16(i*2,v,true));
  const output=compileAudioFilterChain('asoftclip=alg:0.5:1.3:0.01').apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:8,planes:[data],pts:null},{maxFrameBytes:64});
  expect(output.sampleFormat).toBe('fltp');expect(read(output)).toEqual(transcription(step('asoftclip=alg:0.5:1.3:0.01'),[0,-32768,32767,12345,-1,1,-20000,16384].map(v=>v/32768),true));
});
it('enforces allocation limits, refuses non-finite input and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('asoftclip=hard'),values=samples(4096);
  expect(()=>chain.apply(frame('flt',1,values),{maxFrameBytes:4096*4-1})).toThrow('Audio filter frame exceeds allocation limit');
  expect(()=>asoftclip.apply!(step('asoftclip=hard'),frame('flt',1,values),'dblp',{maxFrameBytes:4096*8-1})).toThrow('Converted audio frame exceeds allocation limit');
  expect(()=>chain.apply(frame('flt',1,[0,Infinity]),{maxFrameBytes:64})).toThrow('Non-finite asoftclip input is not yet supported');
  expect(()=>chain.apply(frame('dbl',1,[Number.NaN]),{maxFrameBytes:64})).toThrow('Non-finite asoftclip input is not yet supported');
  const controller=new AbortController();controller.abort(new Error('stopped'));
  expect(()=>chain.apply(frame('flt',1,values),{maxFrameBytes:1<<20,signal:controller.signal})).toThrow('stopped');
  await expect(collect(chain.process(input(frame('flt',1,values)),{maxFrameBytes:1<<20,signal:controller.signal}))).rejects.toThrow('stopped');
});
