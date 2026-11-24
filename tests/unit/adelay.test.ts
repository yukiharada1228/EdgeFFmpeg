import {expect,it} from 'vitest';
import {AudioDelayError,audioDelayPlan,audioDelaySamples,compileAudioFilterChain,delayAudio,parseAudioDelay} from '@edge-ffmpeg/avfilter';
import type {AudioDelayStep} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>parseAudioDelay(text);
it('parses positional and named options, skips empty fields and defers unsupported tokens to the channel that reads them',()=>{
  expect(step('adelay')).toEqual({name:'adelay',delays:[],all:false});
  expect(step('adelay=5S|1.5|2s:1')).toEqual({name:'adelay',delays:[{samples:5n},{value:1.5,divisor:1000},{value:2,divisor:1}],all:true});
  expect(step('adelay=all=true:delays=||7S|')).toEqual({name:'adelay',delays:[{samples:7n}],all:true});
  // Native reads an int64 then one character, so a fractional 's' or 'S' suffix falls back to milliseconds.
  expect(step('adelay=1.5s|1.5S|.5s|7.').delays).toEqual([{value:1.5,divisor:1000},{value:1.5,divisor:1000},{value:0.5,divisor:1000},{value:7,divisor:1000}]);
  for(const token of ['5ms','1e1','+5S','-0','nan','inf','0x10',' 10','9223372036854775808S'])expect(step(`adelay=${token}`).delays).toEqual([{unsupported:token}]);
  for(const text of ['adelay=5S:all=yes','adelay=5S:1:1','adelay=delays=5S:5S','adelay=5S:foo=1','adelay=delays=a=b'])expect(()=>compileAudioFilterChain(text),text).toThrow(AudioDelayError);
  expect(()=>audioDelaySamples(step('adelay=5ms'),8000,1)).toThrow('Unsupported adelay delay: 5ms');
  expect(audioDelaySamples(step('adelay=5S|5ms|nan'),8000,1)).toEqual([5n]);
});
it('resolves per-channel delays with float32 arithmetic truncated toward zero and native defaults for missing channels',()=>{
  const delays=(text:string,rate:number,channels=1)=>audioDelaySamples(step(text),rate,channels);
  expect(delays('adelay=110.839',11025)).toEqual([1222n]);expect(delays('adelay=50.839',22050)).toEqual([1121n]);expect(delays('adelay=268.39',11025)).toEqual([2959n]);
  expect(delays('adelay=0.99',8000)).toEqual([7n]);expect(delays('adelay=0.06',8000)).toEqual([0n]);expect(delays('adelay=2s|1.5s',44100,2)).toEqual([88200n,66n]);
  // 1523 s at 11025 Hz is 16791075 exactly, which rounds to an even float32 before truncation.
  expect(delays('adelay=1523s',11025)).toEqual([16791076n]);
  expect(delays('adelay=5S|9S',8000,4)).toEqual([5n,9n,0n,0n]);expect(delays('adelay=5S|9S:all=1',8000,4)).toEqual([5n,9n,9n,9n]);expect(delays('adelay=all=1',8000,3)).toEqual([0n,0n,0n]);
  expect(audioDelayPlan(step('adelay=700S|1300S|3S'),8000,3)).toEqual({padding:3n,flush:1297n});expect(audioDelayPlan(step('adelay=9S'),8000,1)).toEqual({padding:9n,flush:0n});
  expect(()=>audioDelaySamples(step('adelay=1e39'.replace('1e39','1'+'0'.repeat(39))),8000,1)).toThrow('signed64');
  for(const [rate,channels]of [[0,1],[8000,0],[8000.5,1],[2147483648,1]] as const)expect(()=>audioDelaySamples(step('adelay=1S'),rate,channels)).toThrow(AudioDelayError);
  expect(()=>audioDelayPlan(step('adelay=1S'),8000,undefined)).toThrow('channel count');
});
it('plans counts, packet sections and buffers in the filter rate, and rejects stateless or resampled use',()=>{
  const chain=compileAudioFilterChain('asetrate=16000,adelay=1|0.5,asetnsamples=5:p=0');
  expect(chain.reframes).toBe(true);expect(chain.outputSamples(13n,8000,{channels:2})).toBe(29n);expect(chain.requiredBufferSamples(13n,8000,{channels:2})).toEqual([8,8,5]);
  expect(()=>chain.outputSamples(13n,8000)).toThrow('channel count');
  const sections=compileAudioFilterChain('apad=pad_len=10:packet_size=7,adelay=2100S|2S');
  expect(sections.packetSections(13n,512n,8000,true,2)).toEqual([{samples:2n,span:2048n},{samples:13n,span:512n},{samples:10n,span:7n},{samples:2098n,span:2048n}]);
  expect(compileAudioFilterChain('adelay=0S|0S').packetSections(13n,512n,8000,true,2)).toEqual([{samples:13n,span:512n}]);
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  expect(()=>compileAudioFilterChain('adelay=1S').apply(frame,{maxFrameBytes:16})).toThrow('stream processing');
  expect(()=>compileAudioFilterChain('adelay=1S').rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');expect(compileAudioFilterChain('adelay=1S').rateBoundary('s16',8000,8000)).toBeNull();
});
it('negotiates the planar input precision and reproduces native fixed-volume precision when adelay blocks the encoder format',()=>{
  const format=(text:string,input:'s16'|'flt'|'u8'|'dbl',output:'s16'|'flt'='s16')=>compileAudioFilterChain(text,{outputSampleFormat:output}).resolvedSampleFormat(input);
  expect(format('adelay',  's16')).toBe('s16p');expect(format('adelay','flt')).toBe('fltp');expect(format('adelay,aformat=s32','u8')).toBe('s32');
  expect(format('volume=0.5:precision=fixed','flt')).toBe('s16');expect(format('volume=0.5:precision=fixed,adelay','flt')).toBe('s32p');expect(format('adelay,anull,volume=0.5:precision=fixed','dbl')).toBe('s32');
  expect(format('adelay,volume=0.5,volume=0.5:precision=fixed','flt')).toBe('s16');expect(format('volume=0.5:precision=fixed,adelay','s16')).toBe('s16p');
  expect(()=>format('volume=0.5:precision=fixed,adelay,aformat=s16p','flt')).toThrow('adelay with fixed volume');
  expect(compileAudioFilterChain('volume=0.5:precision=fixed,adelay',{outputSampleFormat:'s16'}).requiresScalarRounding('flt')).toBe(true);
});
it('streams per-channel delays through rings identically to a naive shift for packed/planar inputs and arbitrary frame sizes',async()=>{
  for(const [format,width]of [['u8',1],['s16',2],['dbl',8],['s32p',4],['fltp',4]] as const)for(const delays of ['adelay=0S|5S|11S','adelay=3S|3S|3S','adelay=13S|1S','adelay=2049S|2S|4100S']){
    const channels=3,planar=format.endsWith('p'),sizes=[1,4,7,2,13,3,600],total=sizes.reduce((a,b)=>a+b),source=Uint8Array.from({length:total*channels*width},(_,i)=>(i*37+11)&255);
    const frames:AudioFrameData[]=[];let offset=0;
    for(const samples of sizes){
      const planes=planar?Array.from({length:channels},(_,c)=>source.slice((c*total+offset)*width,(c*total+offset+samples)*width)):[source.slice(offset*channels*width,(offset+samples)*channels*width)];
      frames.push({sampleRate:8000,channels,channelLayout:'3.0',sampleFormat:format,samples,planes,pts:{value:BigInt(offset)*2n+90071992547409920n,timeBase:{num:1n,den:16000n}}});offset+=samples;
    }
    const copies=frames.map(frame=>frame.planes.map(plane=>plane.slice())),parsed=step(delays),shift=audioDelaySamples(parsed,8000,channels).map(Number),{padding,flush}=audioDelayPlan(parsed,8000,channels);
    const output=await collect(delayAudio(input(...frames),parsed,{maxFrameBytes:1<<16}));
    expect(frames.map(frame=>frame.planes),`${format} ${delays} input untouched`).toEqual(copies);
    expect(output.every(frame=>frame.sampleFormat===`${format.replace(/p$/,'')}p`&&frame.planes.every(plane=>!frames.some(f=>f.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
    const length=total+Number(padding+flush),fill=format==='u8'?128:0;expect(output.reduce((sum,frame)=>sum+frame.samples,0)).toBe(length);
    let position=0n;for(const frame of output){expect(frame.pts).toEqual({value:45035996273704960n+position,timeBase:{num:1n,den:8000n}});position+=BigInt(frame.samples);}
    for(let c=0;c<channels;c++){
      const actual=Buffer.concat(output.map(frame=>frame.planes[c]!)),expected=Buffer.alloc(length*width,fill);
      for(let s=0;s<total;s++)for(let b=0;b<width;b++)expected[(s+shift[c]!)*width+b]=source[(planar?c*total+s:s*channels+c)*width+b]!;
      expect(actual.equals(expected),`${format} ${delays} channel ${c}`).toBe(true);
    }
    expect(output.slice(0,Number(padding)?Math.ceil(Number(padding)/2048):0).every(frame=>frame.samples<=2048)).toBe(true);
  }
});
it('emits configured silence for empty input and enforces allocation, format, timestamp and cancellation limits',async()=>{
  const parsed=step('adelay=3S|5S'),empty={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8',pts:{value:7n,timeBase:{num:1n,den:8000n}}};
  const silent=await collect(delayAudio(input(),parsed,{maxFrameBytes:64,emptyInput:empty}));
  expect(silent.map(frame=>[frame.samples,frame.pts?.value,frame.sampleFormat])).toEqual([[3,7n,'u8p'],[2,10n,'u8p']]);expect(silent.every(frame=>frame.planes.every(plane=>plane.every(value=>value===128)))).toBe(true);
  await expect(collect(delayAudio(input(),parsed,{maxFrameBytes:64}))).rejects.toThrow('configured empty input');
  const frame=(samples:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples,planes:[new Uint8Array(samples*4)],pts:null,...extra});
  await expect(collect(delayAudio(input(frame(1)),step('adelay=0S|9S'),{maxFrameBytes:17}))).rejects.toThrow('delay buffer exceeds');
  await expect(collect(delayAudio(input(frame(1)),step('adelay=5000S:all=1'),{maxFrameBytes:4096}))).rejects.toThrow('frame exceeds');
  await expect(collect(delayAudio(input(frame(1),frame(1,{sampleRate:16000})),parsed,{maxFrameBytes:64}))).rejects.toThrow('stable input format');
  await expect(collect(delayAudio(input(frame(1,{pts:{value:1n,timeBase:{num:1n,den:3n}}})),parsed,{maxFrameBytes:64}))).rejects.toThrow('sample-aligned');
  await expect(collect(delayAudio(input(frame(1,{sampleFormat:'s24'})),parsed,{maxFrameBytes:64}))).rejects.toThrow(AudioDelayError);
  await expect(collect(delayAudio(input(frame(1,{sampleFormat:'s16p',planes:[new Uint8Array(2),new Uint8Array(1)]})),parsed,{maxFrameBytes:64}))).rejects.toThrow('plane');
  await expect(collect(delayAudio(input(frame(1)),parsed,{maxFrameBytes:0}))).rejects.toThrow('allocation limit');
  const controller=new AbortController();let closed=false;async function* frames(){try{yield frame(1);controller.abort(new Error('stop'));yield frame(1);}finally{closed=true;}}
  await expect(collect(delayAudio(frames(),parsed,{maxFrameBytes:64,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  const typed:AudioDelayStep=parsed;expect(Object.isFrozen(typed)&&Object.isFrozen(typed.delays)).toBe(true);
});
