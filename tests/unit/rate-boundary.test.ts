import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {compileAudioFilterChain,AudioFilterError} from '@edge-ffmpeg/avfilter';
it('locates rate conversion at the final format boundary after the last rate constraint',()=>{
  expect(compileAudioFilterChain('volume=0.5:precision=double,asetnsamples=7:p=1',{outputSampleFormat:'dbl'}).rateBoundary('s16',8000,16000)).toEqual({beforeStep:0,inputRate:8000,outputRate:16000,inputFormat:'s16',outputFormat:'dbl'});
  expect(compileAudioFilterChain('volume=0.5:precision=float,volume=0.5:precision=double',{outputSampleFormat:'dbl'}).rateBoundary('dbl',8000,16000)).toEqual({beforeStep:1,inputRate:8000,outputRate:16000,inputFormat:'flt',outputFormat:'dbl'});
  expect(compileAudioFilterChain('volume=0.5:precision=double',{outputSampleFormat:'s16'}).rateBoundary('s16',8000,16000)).toEqual({beforeStep:1,inputRate:8000,outputRate:16000,inputFormat:'dbl',outputFormat:'s16'});
});
it('stops output-rate propagation at asetrate and leaves equal-rate graphs unchanged',()=>{
  const before=compileAudioFilterChain('volume=0.5:precision=double,asetrate=11025',{outputSampleFormat:'dbl'}).rateBoundary('s16',8000,16000);expect(before).toMatchObject({beforeStep:2,inputRate:11025,inputFormat:'dbl'});expect(Object.isFrozen(before)).toBe(true);
  expect(compileAudioFilterChain('asetrate=11025,volume=0.5:precision=double',{outputSampleFormat:'dbl'}).rateBoundary('s16',8000,16000)).toMatchObject({beforeStep:1,inputRate:11025,inputFormat:'s16'});
  expect(compileAudioFilterChain('asetrate=11025').rateBoundary('s16',8000,11025)).toBeNull();expect(()=>compileAudioFilterChain('anull').rateBoundary('s16',0,16000)).toThrow(AudioFilterError);
});

it('inserts stream processing before a selected filter and preserves per-execution FIFO isolation',async()=>{
  const chain=compileAudioFilterChain('volume=0.5:precision=double,asetnsamples=3:p=1',{outputSampleFormat:'dbl'});
  const data=new Uint8Array(16),view=new DataView(data.buffer);view.setFloat64(0,1,true);view.setFloat64(8,-1,true);
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples:2,planes:[data],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
  async function* input(){yield frame;}
  const insertion={beforeStep:0,transform:async function*(frames:AsyncIterable<AudioFrameData>){for await(const source of frames)yield {...source,sampleRate:16000,pts:{value:0n,timeBase:{num:1n,den:16000n}}};}};
  const stream=chain.process(input(),{maxFrameBytes:64},insertion);insertion.beforeStep=2;
  const output=[];for await(const value of stream)output.push(value);expect(output).toHaveLength(1);expect(output[0]!.samples).toBe(3);expect(output[0]!.sampleRate).toBe(16000);expect(new DataView(output[0]!.planes[0]!.buffer).getFloat64(0,true)).toBe(0.5);expect(output[0]!.pts?.timeBase.den).toBe(16000n);
  expect(()=>chain.process(input(),{maxFrameBytes:64},{...insertion,beforeStep:3})).toThrow('boundary');
});
it('closes upstream iterators on inserted conversion failure and early consumer return',async()=>{
  const chain=compileAudioFilterChain('anull,volume=0.5:precision=double',{outputSampleFormat:'dbl'}),data=new Uint8Array(8);new DataView(data.buffer).setFloat64(0,1,true);
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples:1,planes:[data],pts:null};
  for(const failure of [true,false]){
    let closed=0,reads=0;async function* input(){try{for(let i=0;i<10;i++){reads++;yield frame;}}finally{closed++;}}
    const stream=chain.process(input(),{maxFrameBytes:64},{beforeStep:1,transform:async function*(source){for await(const value of source){if(failure)throw new Error('conversion failed');yield value;}}});
    if(failure)await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('conversion failed');else for await(const value of stream){expect(value.samples).toBe(1);break;}
    expect(reads).toBe(1);expect(closed).toBe(1);
  }
});
