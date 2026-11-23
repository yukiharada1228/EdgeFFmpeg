import {expect,it} from 'vitest';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
it('parses explicit aformat constraints and includes conversion width rounding and rate boundaries',()=>{
  for(const text of ['aformat=dbl','aformat=f=dbl','aformat=sample_fmts=dbl']){
    const chain=compileAudioFilterChain(text,{outputSampleFormat:'dbl'});expect(chain.steps).toEqual([{name:'aformat',sampleFormat:'dbl'}]);expect(chain.maxBytesPerSample).toBe(8);expect(chain.resolvedSampleFormat('s16')).toBe('dbl');expect(chain.rateBoundary('s16',8000,16000)).toMatchObject({beforeStep:0,inputFormat:'s16',outputFormat:'dbl'});
  }
  expect(compileAudioFilterChain('aformat').resolvedSampleFormat('s16')).toBe('s16');expect(compileAudioFilterChain('aformat=s16').requiresScalarRounding('dbl')).toBe(true);
  for(const text of ['aformat=s64p','aformat=flt|dbl','aformat=','aformat=f='])expect(()=>compileAudioFilterChain(text)).toThrow('aformat');
});
it('converts aformat into independently owned frames while preserving timing and budgets',()=>{
  const bytes=new Uint8Array([0,128,0,0,255,127]),frame={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:3,planes:[bytes],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}},chain=compileAudioFilterChain('aformat=dbl');
  const output=chain.apply(frame,{maxFrameBytes:24}),view=new DataView(output.planes[0]!.buffer);expect([view.getFloat64(0,true),view.getFloat64(8,true),view.getFloat64(16,true)]).toEqual([-1,0,32767/32768]);expect(output.pts).toEqual(frame.pts);expect(output.planes[0]!.buffer).not.toBe(bytes.buffer);expect(()=>chain.apply(frame,{maxFrameBytes:16})).toThrow('allocation');
});

it('negotiates planar constraints and fixed-volume packed transitions with bounded precision widths',()=>{
  const chain=compileAudioFilterChain('aformat=dblp,asetrate=11025,asetnsamples=7:p=1,aformat=fltp',{outputSampleFormat:'flt'});expect(chain.maxBytesPerSample).toBe(8);expect(chain.resolvedSampleFormat('s16')).toBe('fltp');expect(chain.rateBoundary('s16',8000,16000)).toMatchObject({beforeStep:4,inputRate:11025,inputFormat:'fltp',outputFormat:'flt'});
  expect(compileAudioFilterChain('aformat=dblp,volume=0.5:precision=fixed,aformat=s16p').resolvedSampleFormat('s16')).toBe('s16p');expect(compileAudioFilterChain('aformat=s16p').requiresScalarRounding('dblp')).toBe(true);
});
