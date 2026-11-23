import { expect, it } from 'vitest';
import { compileAudioFilterChain } from '@edge-ffmpeg/avfilter';
import type { AudioFrameData } from '@edge-ffmpeg/avutil';
function frame(): AudioFrameData {
  const data=new Uint8Array(16),view=new DataView(data.buffer);[-1,-0,0.5,1].forEach((value,i)=>view.setFloat32(i*4,value,true));
  return {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'flt',samples:4,planes:[data],pts:{value:7n,timeBase:{num:1n,den:8000n}}};
}
it('keeps anull as an unmodified validated pass-through',()=>{
  const input=frame(),chain=compileAudioFilterChain('anull');expect(chain.apply(input,{maxFrameBytes:64})).toBe(input);
  expect(chain.outputSampleFormat).toBeNull();expect(Object.isFrozen(chain.steps)).toBe(true);
});
it('applies volume with owned output, precision negotiation and signed zero',()=>{
  const input=frame(),chain=compileAudioFilterChain('anull,volume=volume=-0.5:precision=double,anull');
  const output=chain.apply(input,{maxFrameBytes:64}),view=new DataView(output.planes[0]!.buffer);
  expect(output.sampleFormat).toBe('dbl');expect(chain.maxBytesPerSample).toBe(8);
  expect(Array.from({length:4},(_,i)=>view.getFloat64(i*8,true))).toEqual([0.5,0,-0.25,-0.5]);
  expect(output.pts).toEqual(input.pts);expect(output.planes[0]).not.toBe(input.planes[0]);
});
it('preserves filter order and rejects unsupported syntax before execution',()=>{
  const chain=compileAudioFilterChain('volume=0.5,volume=2');const output=chain.apply(frame(),{maxFrameBytes:64});expect(output.planes[0]).toEqual(frame().planes[0]);
  for(const text of ['', 'volume=foo','volume=1:precision=invalid','volume=1:eval=frame','volume=1e300','volume=NaN','anull;anull','anull,,anull',Array(34).fill('anull').join(',')])expect(()=>compileAudioFilterChain(text)).toThrow();
});
it('checks frame bounds, cancellation and unsupported non-finite inputs',()=>{
  const chain=compileAudioFilterChain('volume=0.5');expect(()=>chain.apply(frame(),{maxFrameBytes:4})).toThrow('allocation');
  const input=frame();new DataView(input.planes[0]!.buffer).setFloat32(0,NaN,true);expect(()=>chain.apply(input,{maxFrameBytes:64})).toThrow('Non-finite');
  const abort=new AbortController();abort.abort('stop');expect(()=>chain.apply(frame(),{maxFrameBytes:64,signal:abort.signal})).toThrow();
});
it('applies Q8 fixed volume with half-up rounding, clipping and independent owned buffers',()=>{
  const data=new Uint8Array(12),view=new DataView(data.buffer);[-32768,-3,-1,1,3,32767].forEach((value,i)=>view.setInt16(i*2,value,true));
  const input:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:6,planes:[data],pts:null};
  const chain=compileAudioFilterChain('volume=0.5:precision=fixed',{outputSampleFormat:'s16'}),output=chain.apply(input,{maxFrameBytes:64}),result=new DataView(output.planes[0]!.buffer);
  expect(Array.from({length:6},(_,i)=>result.getInt16(i*2,true))).toEqual([-16384,-1,0,1,2,16384]);expect(output.planes[0]).not.toBe(data);expect(chain.requiresScalarRounding('s16')).toBe(false);expect(chain.requiresScalarRounding('flt')).toBe(true);
  const muted=compileAudioFilterChain('volume=-1:precision=fixed').apply(input,{maxFrameBytes:64});expect([...muted.planes[0]!]).toEqual(Array(12).fill(0));
  const amplified=compileAudioFilterChain('volume=2:precision=fixed').apply(input,{maxFrameBytes:64}),clipped=new DataView(amplified.planes[0]!.buffer);expect(clipped.getInt16(0,true)).toBe(-32768);expect(clipped.getInt16(10,true)).toBe(32767);
  expect(()=>compileAudioFilterChain('volume=65536:precision=fixed')).toThrow('arithmetic profile');
});
it('negotiates fixed integer formats and detects scalar conversions inside mixed chains',()=>{
  const integer=compileAudioFilterChain('volume=0.5:precision=fixed',{outputSampleFormat:'u8'});expect(integer.apply(frame(),{maxFrameBytes:64}).sampleFormat).toBe('u8');
  const floating=compileAudioFilterChain('volume=0.5:precision=fixed',{outputSampleFormat:'flt'});expect(floating.apply(frame(),{maxFrameBytes:64}).sampleFormat).toBe('s32');
  const mixed=compileAudioFilterChain('volume=0.5,volume=0.5:precision=fixed,volume=0.5:precision=double',{outputSampleFormat:'dbl'});expect(mixed.requiresScalarRounding('s16')).toBe(true);expect(mixed.apply(frame(),{maxFrameBytes:64}).sampleFormat).toBe('dbl');
});

it('captures the output format hint when compiling a chain',()=>{
  const options:{outputSampleFormat:'u8'|'s32'}={outputSampleFormat:'u8'};
  const chain=compileAudioFilterChain('volume=0.5:precision=fixed',options);options.outputSampleFormat='s32';
  expect(chain.apply(frame(),{maxFrameBytes:64}).sampleFormat).toBe('u8');
});
it('reinterprets rate and bigint sample timestamps without copying or mutating PCM',()=>{
  const input=frame();input.pts={value:9007199254740993n,timeBase:{num:1n,den:8000n}};
  const chain=compileAudioFilterChain('asetrate=sample_rate=20000,anull,asetrate=r=11025'),output=chain.apply(input,{maxFrameBytes:64});
  expect(output.sampleRate).toBe(11025);expect(chain.outputSampleRate(8000)).toBe(11025);expect(output.pts).toEqual({value:9007199254740993n,timeBase:{num:1n,den:11025n}});expect(output.planes).toBe(input.planes);expect(input.sampleRate).toBe(8000);expect(input.pts.timeBase.den).toBe(8000n);
  expect(compileAudioFilterChain('asetrate').outputSampleRate(8000)).toBe(44100);
  expect(()=>chain.apply({...input,pts:{value:1n,timeBase:{num:1n,den:3n}}},{maxFrameBytes:64})).toThrow('sample-aligned');
  for(const spec of ['asetrate=0','asetrate=-1','asetrate=20000.5','asetrate=1e3','asetrate=r=2147483648','asetrate=foo=8000'])expect(()=>compileAudioFilterChain(spec)).toThrow();
});
