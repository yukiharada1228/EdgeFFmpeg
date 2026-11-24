import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {stereowiden,stereoWidenAudio,stereoWidenLength} from '../../packages/avfilter/src/audio/stereowiden.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const parse=(text:string)=>stereowiden.parse(text);
const stereo=(samples:Float32Array,sampleRate=8000,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate,channels:2,channelLayout:'stereo',sampleFormat:'flt',samples:samples.length/2,planes:[new Uint8Array(samples.buffer.slice(samples.byteOffset,samples.byteOffset+samples.byteLength))],pts:null,...extra});
const floats=(frames:readonly AudioFrameData[])=>frames.flatMap(frame=>Array.from(new Float32Array(frame.planes[0]!.slice().buffer)));
/** Direct transcription of af_stereowiden.c config_input and filter_frame: every float operation is stored through a float32 slot. */
function transcription(source:Float32Array,sampleRate:number,{delay,feedback,crossfeed,drymix}:{delay:number;feedback:number;crossfeed:number;drymix:number}):Float32Array {
  const t=new Float32Array(4),r=(value:number)=>{t[0]=value;return t[0];};
  const scaled=r(r(r(delay)*r(sampleRate))/1000),low=Math.floor(scaled),lrintf=scaled-low===0.5?(low%2===0?low:low+1):Math.round(scaled);
  const length=lrintf*2,buffer=new Float32Array(length),dst=new Float32Array(source.length);let cur=0;
  for(let n=0;n<source.length/2;n++,cur+=2){
    const left=source[n*2]!,right=source[n*2+1]!;
    if(cur===length)cur=0;
    t[1]=r(drymix)*left;t[2]=r(crossfeed)*right;t[3]=r(feedback)*buffer[cur+1]!;dst[n*2]=r(r(t[1]-t[2])-t[3]);
    t[1]=r(drymix)*right;t[2]=r(crossfeed)*left;t[3]=r(feedback)*buffer[cur]!;dst[n*2+1]=r(r(t[1]-t[2])-t[3]);
    buffer[cur]=left;buffer[cur+1]=right;
  }
  return dst;
}
it('parses shorthand and named float options with native ranges and refuses everything else with exact messages',()=>{
  expect(parse('stereowiden')).toEqual({name:'stereowiden',delay:20,feedback:Math.fround(0.3),crossfeed:Math.fround(0.3),drymix:Math.fround(0.8)});
  expect(parse('stereowiden=5:0.5')).toEqual({name:'stereowiden',delay:5,feedback:0.5,crossfeed:Math.fround(0.3),drymix:Math.fround(0.8)});
  expect(parse('stereowiden=1:feedback=0.9:drymix=0:crossfeed=0.8:delay=100')).toEqual({name:'stereowiden',delay:100,feedback:Math.fround(0.9),crossfeed:Math.fround(0.8),drymix:0});
  expect(parse('stereowiden=1.5e1:.25:+0.1:1.')).toEqual({name:'stereowiden',delay:15,feedback:0.25,crossfeed:Math.fround(0.1),drymix:1});
  expect(Object.is(parse('stereowiden=feedback=-0').feedback,-0)).toBe(true);
  expect(parse('stereowiden=delay=3:delay=7').delay).toBe(7);
  const refusals:readonly [string,string][]=[
    ['stereowiden=0.5','stereowiden delay 0.5 is out of range [1 - 100]'],['stereowiden=100.0001','stereowiden delay 100.0001 is out of range [1 - 100]'],
    ['stereowiden=feedback=0.91','stereowiden feedback 0.91 is out of range [0 - 0.9]'],['stereowiden=crossfeed=-0.1','stereowiden crossfeed -0.1 is out of range [0 - 0.8]'],
    ['stereowiden=drymix=1.01','stereowiden drymix 1.01 is out of range [0 - 1]'],['stereowiden=20:0.3:0.3:0.8:1','Too many stereowiden positional options: 1'],
    ['stereowiden=delay=5:0.5','No stereowiden option name near \'0.5\''],['stereowiden=enable=1','stereowiden timeline enable is not implemented'],
    ['stereowiden=foo=1','Unsupported stereowiden option: foo'],['stereowiden=delay=2*3','Only constant numeric stereowiden delay values are implemented: 2*3'],
    ['stereowiden=','Only constant numeric stereowiden delay values are implemented: '],['stereowiden=delay=nan','Only constant numeric stereowiden delay values are implemented: nan'],
    ['stereowiden=1k','Only constant numeric stereowiden delay values are implemented: 1k']
  ];
  for(const [text,message]of refusals){expect(()=>parse(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('stereowidenx')).toThrow('Unsupported audio filter: stereowidenx');
});
it('computes the ring length with float lrintf (round half to even) and refuses a zero-length ring',()=>{
  const length=(delay:number,rate:number)=>stereoWidenLength(parse(`stereowiden=${delay}`),rate);
  expect(length(20,8000)).toBe(320);expect(length(1,44100)).toBe(88);expect(length(100,48000)).toBe(9600);expect(length(1,8000)).toBe(16);
  // 1.5 and 2.5 samples round to the even neighbour; 0.5 rounds to 0, which native refuses with EINVAL.
  expect(length(1.5,1000)).toBe(4);expect(length(2.5,1000)).toBe(4);expect(length(3.5,1000)).toBe(8);expect(length(1,500)).toBe(0);expect(length(1,1500)).toBe(4);
  // delay is a float: 1.1f * 44100 rounds in float before the division.
  expect(length(1.1,44100)).toBe(2*Math.round(Math.fround(Math.fround(Math.fround(1.1)*44100)/1000)));
  for(const rate of [0,1.5,2147483648])expect(()=>length(20,rate)).toThrow('Invalid stereowiden sample rate');
  const chain=compileAudioFilterChain('stereowiden=1');
  expect(()=>chain.validateInputFormat({sampleRate:500,channels:2,channelLayout:'stereo'})).toThrow('stereowiden delay rounds to zero samples at 500 Hz');
  expect(()=>chain.validateInputFormat({sampleRate:1500,channels:2,channelLayout:'stereo'})).not.toThrow();
});
it('refuses mono, multichannel and masked layouts and requires a configured format for empty input',async()=>{
  const chain=compileAudioFilterChain('stereowiden');
  for(const [channels,channelLayout]of [[1,'mono'],[3,'unspecified'],[2,'2 channels (FL+FC)'],[2,'downmix'],[2,'2 channels']] as const)expect(()=>chain.validateInputFormat({sampleRate:44100,channels,channelLayout}),channelLayout).toThrow('stereowiden requires stereo input');
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).not.toThrow();
  const mono:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  await expect(collect(chain.process(input(mono),{maxFrameBytes:1<<16}))).rejects.toThrow('stereowiden requires stereo input');
  await expect(collect(chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('stereowiden constraints require a configured empty input format');
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}}))).toEqual([]);
  expect(()=>chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:null}})).toThrow('stereowiden requires stereo input');
});
it('negotiates packed float for every input format, keeps counts and declares the ring as state',()=>{
  const chain=compileAudioFilterChain('stereowiden');
  expect(chain.nativeFormatLists).toBe(true);
  for(const format of ['u8','s16','s32','flt','dbl','s16p','fltp'] as const)expect(chain.negotiatedSampleFormats(format),format).toEqual(['flt']);
  expect(compileAudioFilterChain('stereowiden,volume=0.5').negotiatedSampleFormats('s16')).toEqual(['flt','flt']);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:false});
  expect(()=>chain.apply({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'flt',samples:1,planes:[new Uint8Array(8)],pts:null},{maxFrameBytes:64})).toThrow('stereowiden requires stream processing');
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  const plan=chain.planSamples(1000n,44100,{channels:2});expect(plan.samples).toBe(1000n);expect(plan.buffers).toEqual([]);
  expect(compileAudioFilterChain('stereowiden,asetnsamples=300:p=0').packetSections(1000n,512n,44100,false,2)).toEqual([{samples:1000n,span:300n}]);
  expect(chain.packetSections(1000n,512n,44100,false,2)).toEqual([{samples:1000n,span:512n}]);
  for(const [delay,rate,bytes]of [[20,8000,1280n],[1,44100,352n],[100,48000,38400n],[1,500,0n]] as const){
    const [entry]=compileAudioFilterChain(`stereowiden=${delay}`).plannedReservations({sampleRate:rate,channels:2,sampleFormat:'s16'},{samples:100n,channels:2});
    expect(entry!.reservation,`${delay}/${rate}`).toEqual({frames:1,buffers:[],stateBytes:bytes});expect(entry!.countBuffers).toEqual([]);
  }
  expect([...compileAudioFilterChain('stereowiden=100').reservations({sampleRate:48000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:38400n}]);
});
it('matches a direct C transcription across options, rates and frame splits, without touching input frames',async()=>{
  const total=3001,source=new Float32Array(total*2);for(let i=0;i<source.length;i++)source[i]=Math.fround(Math.sin(i*0.37+(i&1)*1.3)*(i%11===0?1.7:0.6)+((i*7919)%13-6)/97);
  for(const text of ['stereowiden','stereowiden=1:0.9:0.8:1','stereowiden=delay=100:feedback=0:crossfeed=0:drymix=0','stereowiden=2.5:0.45:0.65:0.33','stereowiden=7:feedback=-0'])for(const rate of [8000,44100,48000,1000]){
    const step=parse(text),expected=transcription(source,rate,step);
    for(const sizes of [[total],[1,2,3,500,7,2488],[160,160,160,2521],[1024,1024,953]]){
      const frames:AudioFrameData[]=[];let offset=0;for(const samples of sizes){frames.push(stereo(source.subarray(offset*2,(offset+samples)*2),rate,{pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}}));offset+=samples;}
      const copies=frames.map(frame=>frame.planes[0]!.slice()),output=await collect(compileAudioFilterChain(text).process(input(...frames),{maxFrameBytes:1<<16}));
      expect(frames.map(frame=>frame.planes[0])).toEqual(copies);
      expect(output.map(frame=>[frame.samples,frame.pts?.value,frame.sampleFormat])).toEqual(frames.map(frame=>[frame.samples,frame.pts?.value,'flt']));
      expect(output.every(frame=>!frames.some(f=>f.planes[0]!.buffer===frame.planes[0]!.buffer))).toBe(true);
      const actual=new Uint8Array(Float32Array.from(floats(output)).buffer),reference=new Uint8Array(expected.buffer);
      expect(Buffer.from(actual).equals(Buffer.from(reference)),`${text} ${rate} ${sizes.join('+')}`).toBe(true);
    }
  }
  // The ring wraps: with delay 1 ms at 1000 Hz (one stereo sample) each output reads the previous input of the opposite channel.
  const [wrapped]=await collect(stereoWidenAudio(input(stereo(Float32Array.of(1,2,3,4,5,6),1000)),parse('stereowiden=1:0.5:0:1'),{maxFrameBytes:64}));
  expect(Array.from(new Float32Array(wrapped!.planes[0]!.slice().buffer))).toEqual([1,2,3-1,4-0.5,5-2,6-1.5]);
});
it('converts integer and planar input to packed float and enforces allocation, format and cancellation limits',async()=>{
  const s16=new Uint8Array(8);new DataView(s16.buffer).setInt16(0,16384,true);new DataView(s16.buffer).setInt16(2,-8192,true);
  const [converted]=await collect(compileAudioFilterChain('stereowiden=1:0:0.5:1').process(input({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:2,planes:[s16],pts:null}),{maxFrameBytes:4096}));
  expect(converted!.sampleFormat).toBe('flt');expect(Array.from(new Float32Array(converted!.planes[0]!.slice().buffer))).toEqual([0.5+0.125,-0.25-0.25,0,0]);
  const frame=stereo(new Float32Array(4));
  await expect(collect(stereoWidenAudio(input(frame),parse('stereowiden=100'),{maxFrameBytes:6399}))).rejects.toThrow('stereowiden delay buffer exceeds allocation limit');
  expect(await collect(stereoWidenAudio(input(frame),parse('stereowiden=100'),{maxFrameBytes:6400}))).toHaveLength(1);
  await expect(collect(stereoWidenAudio(input(frame),parse('stereowiden'),{maxFrameBytes:0}))).rejects.toThrow('Invalid stereowiden allocation limit');
  await expect(collect(stereoWidenAudio(input(frame,stereo(new Float32Array(4),16000)),parse('stereowiden'),{maxFrameBytes:4096}))).rejects.toThrow('stereowiden requires a stable input format');
  await expect(collect(stereoWidenAudio(input(stereo(Float32Array.of(Number.NaN,0))),parse('stereowiden'),{maxFrameBytes:4096}))).rejects.toThrow('Non-finite stereowiden input is not yet supported');
  await expect(collect(stereoWidenAudio(input(frame),parse('stereowiden'),{maxFrameBytes:4096},()=>'fltp'))).rejects.toThrow('stereowiden cannot work in fltp');
  // Overflow saturates to infinity exactly as float arithmetic does; no NaN arises from finite input.
  const [huge]=await collect(stereoWidenAudio(input(stereo(Float32Array.of(3.4e38,-3.4e38))),parse('stereowiden=20:0:0.8:1'),{maxFrameBytes:4096}));
  expect(Array.from(new Float32Array(huge!.planes[0]!.slice().buffer))).toEqual([Infinity,-Infinity]);
  const controller=new AbortController();controller.abort();
  await expect(collect(stereoWidenAudio(input(frame),parse('stereowiden'),{maxFrameBytes:4096,signal:controller.signal}))).rejects.toThrow();
  const late=new AbortController();
  const stream=compileAudioFilterChain('stereowiden').process((async function*(){yield frame;late.abort();yield frame;})(),{maxFrameBytes:4096,signal:late.signal});
  await expect(collect(stream)).rejects.toThrow();
});
