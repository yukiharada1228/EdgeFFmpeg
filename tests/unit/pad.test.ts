import {expect,it} from 'vitest';
import {padAudio} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame():AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',samples:2,planes:[new Uint8Array([1,2]),new Uint8Array([9,8])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AudioFrameData[],padSamples=5n,maxFrameBytes=12){const result=[];for await(const value of padAudio(input(...frames),{padSamples,packetSamples:3,maxFrameBytes}))result.push(value);return result;}
it('preserves input packets and appends owned bounded silence with exact bigint timestamps',async()=>{
  const original=frame(),result=await collect([original]);expect(result[0]).toBe(original);expect(result.map(value=>value.samples)).toEqual([2,3,2]);expect(result.map(value=>value.pts?.value)).toEqual([9007199254740993n,9007199254740995n,9007199254740998n]);expect(result[1]!.planes.map(plane=>[...plane])).toEqual([[128,128,128],[128,128,128]]);expect(result[1]!.planes[0]!.buffer).not.toBe(result[2]!.planes[0]!.buffer);expect(await collect([])).toEqual([]);expect(await collect([original],0n)).toEqual([original]);
});
it('preflights finite padding limits and rejects discontinuous or malformed input',async()=>{
  await expect(collect([frame()],5n,4)).rejects.toThrow('allocation');await expect(collect([frame()],-1n)).rejects.toThrow('limits');await expect(collect([{...frame(),planes:Array<Uint8Array>(2)}])).rejects.toThrow('plane');await expect(collect([frame(),frame()])).rejects.toThrow('contiguous');
  const signal=AbortSignal.abort(new Error('stop'));let read=false;async function* frames(){read=true;yield frame();}await expect((async()=>{for await(const value of padAudio(frames(),{padSamples:1n,maxFrameBytes:8,signal}))void value;})()).rejects.toThrow('stop');expect(read).toBe(false);
});
it('retains backpressure through input and finite tail and closes input on early return',async()=>{
  let reads=0,closed=0;async function* frames(){try{for(let i=0;i<3;i++){reads++;yield {...frame(),pts:null};}}finally{closed++;}}
  const iterator=padAudio(frames(),{padSamples:100n,packetSamples:3,maxFrameBytes:12})[Symbol.asyncIterator]();await iterator.next();expect(reads).toBe(1);await iterator.return?.();expect(closed).toBe(1);expect(reads).toBe(1);
});

import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
it('compiles finite apad options and plans bounded packet sections without enumerating every packet',()=>{
  const chain=compileAudioFilterChain('asetnsamples=5:p=0,apad=pad_len=10:packet_size=7,apad=pad_len=3');expect(chain.outputSamples(13n)).toBe(26n);expect(chain.packetSections(13n,512n)).toEqual([{samples:13n,span:5n},{samples:10n,span:7n},{samples:3n,span:4096n}]);expect(chain.packetSections(0n,512n)).toEqual([]);expect(chain.outputSamples(0n)).toBe(0n);expect(chain.maxBufferedSamples).toBe(7);
  for(const text of ['apad','apad=pad_len=-1','apad=pad_len=1:whole_len=20','apad=pad_len=1:packet_size=0','apad=pad_len=9223372036854775808'])expect(()=>compileAudioFilterChain(text)).toThrow('apad');expect(()=>chain.apply(frame(),{maxFrameBytes:12})).toThrow('stream processing');
});
it('pads to minimum length and computes exact buffer reservations after preceding filters',async()=>{
  const original=frame(),result=[];for await(const value of padAudio(input(original),{wholeSamples:5n,packetSamples:3,maxFrameBytes:6}))result.push(value);expect(result.map(value=>value.samples)).toEqual([2,3]);expect(result[1]!.pts?.value).toBe(9007199254740995n);
  const noPad=[];for await(const value of padAudio(input(original),{wholeSamples:1n,maxFrameBytes:4}))noPad.push(value);expect(noPad).toEqual([original]);
  const chain=compileAudioFilterChain('apad=whole_len=3:packet_size=4096');expect(chain.requiredBufferSamples(13n)).toEqual([]);expect(chain.packetSections(13n,512n)).toEqual([{samples:13n,span:512n}]);expect(chain.outputSamples(13n)).toBe(13n);expect(chain.requiredBufferSamples(1n)).toEqual([2]);
  const nested=compileAudioFilterChain('asetnsamples=5:p=1,apad=whole_len=23:packet_size=7');expect(nested.requiredBufferSamples(13n)).toEqual([5,7]);expect(nested.packetSections(13n,512n)).toEqual([{samples:15n,span:5n},{samples:8n,span:7n}]);
});
it('rounds finite padding durations using the rate at each filter and rejects ambiguous modes',async()=>{
  const first=compileAudioFilterChain('apad=pad_dur=63us:packet_size=7,asetrate=11025,apad=pad_dur=0.0005:packet_size=7');expect(first.outputSamples(13n,8000)).toBe(20n);expect(first.requiredBufferSamples(13n,8000)).toEqual([1,6]);expect(first.packetSections(13n,512n,8000)).toEqual([{samples:13n,span:512n},{samples:1n,span:7n},{samples:6n,span:7n}]);
  expect(()=>first.outputSamples(13n)).toThrow('duration or rate');expect(()=>compileAudioFilterChain('apad=pad_dur=1ms:whole_len=20')).toThrow('exactly one');expect(()=>compileAudioFilterChain('apad=pad_dur=-1')).toThrow('Negative');
  const result=[];for await(const value of padAudio(input(frame()),{padDurationMicros:63n,packetSamples:3,maxFrameBytes:6}))result.push(value);expect(result.map(value=>value.samples)).toEqual([2,1]);
  const whole=[];for await(const value of padAudio(input(frame()),{wholeDurationMicros:500n,packetSamples:3,maxFrameBytes:6}))whole.push(value);expect(whole.map(value=>value.samples)).toEqual([2,2]);
});
it('pads configured empty streams with bounded planar silence and validates fallback metadata',async()=>{
  const format={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};
  const values=[];for await(const value of padAudio(input(),{emptyInput:format,padDurationMicros:625n,packetSamples:3,maxFrameBytes:6}))values.push(value);
  expect(values.map(value=>value.samples)).toEqual([3,2]);expect(values.map(value=>value.pts?.value)).toEqual([9007199254740993n,9007199254740996n]);expect(values[0]!.planes.map(plane=>[...plane])).toEqual([[128,128,128],[128,128,128]]);expect(values[0]!.planes[0]!.buffer).not.toBe(values[1]!.planes[0]!.buffer);
  const collect=async(emptyInput:typeof format,maxFrameBytes=6)=>{for await(const value of padAudio(input(),{emptyInput,wholeSamples:5n,packetSamples:3,maxFrameBytes}))void value;};
  await expect(collect({...format,sampleRate:0})).rejects.toThrow('configured');await expect(collect(format,4)).rejects.toThrow('allocation');await expect(collect({...format,pts:{value:1n,timeBase:{num:1n,den:3n}}})).rejects.toThrow('sample-aligned');
});
it('plans finite padding counts and actual reservations on both sides of a rate conversion',()=>{
  const chain=compileAudioFilterChain('aformat=dbl,apad=pad_dur=1ms:packet_size=7',{outputSampleFormat:'dbl'}),rateBoundary=chain.rateBoundary('s16',8000,16000)!;
  expect(chain.outputSamples(1n,8000,{rateBoundary,configuredInput:true})).toBe(16n);expect(chain.requiredBufferSamples(1n,8000,{rateBoundary,configuredInput:true})).toEqual([7]);expect(chain.outputSamples(1n,8000,{rateBoundary})).toBe(0n);
  const minimum=compileAudioFilterChain('aformat=dbl,apad=whole_len=100:packet_size=7',{outputSampleFormat:'dbl'}),boundary=minimum.rateBoundary('s16',8000,16000)!;
  expect(minimum.outputSamples(65n,8000,{rateBoundary:boundary,configuredInput:true})).toBe(130n);expect(minimum.requiredBufferSamples(65n,8000,{rateBoundary:boundary,configuredInput:true})).toEqual([]);
  expect(()=>chain.outputSamples(13n,8000,{rateBoundary:{...rateBoundary,beforeStep:3}})).toThrow('boundary');expect(()=>chain.outputSamples(13n,44100,{rateBoundary})).toThrow('match');
  expect(chain.outputSamples(0n,8000,{configuredInput:true})).toBe(8n);expect(chain.packetSections(0n,512n,8000,true)).toEqual([{samples:8n,span:7n}]);
});
