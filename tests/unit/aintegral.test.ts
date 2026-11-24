import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const options={maxFrameBytes:1<<20};
/** Packed flt or dbl frame from interleaved values. */
function frame(format:'flt'|'dbl'|'s16',channels:number,values:readonly number[],pts:bigint|null=0n):AudioFrameData{
  const width=format==='dbl'?8:format==='flt'?4:2,data=new Uint8Array(values.length*width),view=new DataView(data.buffer);
  values.forEach((value,index)=>{if(format==='dbl')view.setFloat64(index*8,value,true);else if(format==='flt')view.setFloat32(index*4,value,true);else view.setInt16(index*2,value,true);});
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'unspecified',sampleFormat:format,samples:values.length/channels,planes:[data],pts:pts===null?null:{value:pts,timeBase:{num:1n,den:8000n}}};
}
/** Planar output plane values. */
const plane=(output:AudioFrameData,channel:number)=>{const bytes=output.planes[channel]!,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=output.sampleFormat==='dblp'?8:4;return Array.from({length:bytes.length/width},(_,index)=>width===8?view.getFloat64(index*8,true):view.getFloat32(index*4,true));};
/** Direct transcription of INTEGRAL(flt, float) / INTEGRAL(dbl, double): dst[n]=current+prv[0]; prv[0]=dst[n], per channel. */
function reference(values:readonly number[],channels:number,float:boolean){
  const prv=new Array<number>(channels).fill(0),dst=Array.from({length:channels},()=>[] as number[]);
  for(let n=0;n<values.length/channels;n++)for(let c=0;c<channels;c++){const current=float?Math.fround(values[n*channels+c]!):values[n*channels+c]!;const value=float?Math.fround(current+prv[c]!):current+prv[c]!;dst[c]!.push(value);prv[c]=value;}
  return dst;
}
const signal=(count:number,seed:number)=>Array.from({length:count},(_,index)=>Math.sin(index*0.37+seed)*0.3+((index*7919+seed*31)%17-8)/1000);
it('accepts only the bare token and refuses options and timeline enable with exact messages',()=>{
  expect(compileAudioFilterChain('aintegral').steps).toEqual([{name:'aintegral'}]);
  expect(compileAudioFilterChain(' aintegral ').steps).toEqual([{name:'aintegral'}]);
  for(const text of ['aintegral=','aintegral=1','aintegral=foo=1','aintegral=c=1'])expect(()=>compileAudioFilterChain(text),text).toThrow(new AudioFilterError('aintegral accepts no options'));
  for(const text of ['aintegral=enable=1','aintegral=enable=between(t\\,0\\,1)','aintegral=foo=1:enable=1'])expect(()=>compileAudioFilterChain(text),text).toThrow(new AudioFilterError('aintegral timeline enable is not implemented'));
  for(const text of ['aintegralx','aintegral@x'])expect(()=>compileAudioFilterChain(text),text).toThrow(`Unsupported audio filter: ${text}`);
});
it('negotiates fltp for u8, s16, s32 and flt input and dblp for dbl input, with stream capabilities',()=>{
  const chain=compileAudioFilterChain('aintegral');
  const expected:Record<string,AudioSampleFormat>={u8:'fltp',s16:'fltp',s32:'fltp',flt:'fltp',dbl:'dblp',u8p:'fltp',s16p:'fltp',s32p:'fltp',fltp:'fltp',dblp:'dblp'};
  for(const [format,target]of Object.entries(expected))expect(chain.negotiatedSampleFormats(format as AudioSampleFormat),format).toEqual([target]);
  expect(chain.nativeFormatLists).toBe(true);expect(chain.reframes).toBe(true);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:false});
  expect(compileAudioFilterChain('aintegral',{outputSampleFormat:'s16'}).requiresScalarRounding('s16')).toBe(true);
  expect(compileAudioFilterChain('aintegral',{outputSampleFormat:'flt'}).requiresScalarRounding('s16')).toBe(false);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('aintegral with sample rate conversion is not implemented');
  expect(chain.rateBoundary('s16',8000,8000)).toBeNull();
  expect(()=>chain.apply(frame('flt',1,[0.5]),options)).toThrow('aintegral requires stream processing');
});
it('plans unchanged counts and packets and reserves one frame plus a double accumulator per channel',()=>{
  const chain=compileAudioFilterChain('aintegral');
  expect(chain.planSamples(29n,8000,{channels:2})).toMatchObject({samples:29n,buffers:[]});
  expect(chain.packetSections(29n,7n,8000,true,2)).toEqual([{samples:29n,span:7n}]);
  expect(chain.packetSections(0n,7n,8000,true,2)).toEqual([]);
  for(const [format,channels]of [['s16',1],['flt',2],['dbl',3],['u8',6]] as const){
    expect([...chain.reservations({sampleRate:8000,channels,sampleFormat:format})]).toEqual([{frames:1,buffers:[],stateBytes:BigInt(channels*8)}]);
    expect(chain.plannedReservations({sampleRate:8000,channels,sampleFormat:format},{samples:29n,channels})).toEqual([{step:{name:'aintegral'},reservation:{frames:1,buffers:[],stateBytes:BigInt(channels*8)},countBuffers:[]}]);
  }
  expect(compileAudioFilterChain('asetnsamples=4,aintegral').plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:9n,channels:2}).map(entry=>entry.reservation)).toEqual([{frames:0,buffers:[{samples:4,copies:2}],stateBytes:0n},{frames:1,buffers:[],stateBytes:16n}]);
});
it('matches the C transcription across frames and frame splits for float and double',async()=>{
  for(const [format,channels]of [['flt',1],['flt',2],['dbl',2],['dbl',3]] as const){
    const values=signal(60*channels,channels),expected=reference(values,channels,format==='flt');
    for(const splits of [[60],[1,59],[7,7,7,39],[30,30],Array.from({length:60},()=>1)]){
      let start=0;const frames=splits.map(count=>{const part=frame(format,channels,values.slice(start*channels,(start+count)*channels),BigInt(start));start+=count;return part;});
      const outputs=await collect(compileAudioFilterChain('aintegral').process(input(...frames),options));
      expect(outputs.map(output=>output.sampleFormat)).toEqual(splits.map(()=>format==='flt'?'fltp':'dblp'));
      expect(outputs.map(output=>output.samples)).toEqual(splits);expect(outputs.map(output=>output.pts?.value)).toEqual(frames.map(part=>part.pts?.value));
      for(let channel=0;channel<channels;channel++)expect(outputs.flatMap(output=>plane(output,channel)),`${format}/${channels}/${splits.length}`).toEqual(expected[channel]);
    }
  }
  // s16 input converts to fltp (sample/32768) before the float sum; the accumulator keeps float rounding at every step.
  const ints=[1000,-2000,3000,32767,-32768,5,7,9],floats=ints.map(value=>value/32768);
  const outputs=await collect(compileAudioFilterChain('aintegral').process(input(frame('s16',2,ints.slice(0,4)),frame('s16',2,ints.slice(4))),options));
  const expected=reference(floats,2,true);for(const channel of [0,1])expect(outputs.flatMap(output=>plane(output,channel))).toEqual(expected[channel]);
  // A non-dyadic float sum that differs from the double sum: 0.1f accumulated ten times.
  const tenths=await collect(compileAudioFilterChain('aintegral').process(input(frame('flt',1,new Array(10).fill(0.1))),options));
  expect(plane(tenths[0]!,0).at(-1)).toBe(reference(new Array(10).fill(0.1),1,true)[0]!.at(-1));expect(plane(tenths[0]!,0).at(-1)).not.toBe(Math.fround(1));
  expect(await collect(compileAudioFilterChain('aintegral').process(input(),options))).toEqual([]);
});
it('keeps input frames untouched and returns owned planes',async()=>{
  const source=frame('flt',2,[0.25,0.5,0.25,0.5]),copy=source.planes[0]!.slice();
  const [output]=await collect(compileAudioFilterChain('aintegral').process(input(source),options));
  expect(source.planes[0]).toEqual(copy);expect(output!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);expect(plane(output!,0)).toEqual([0.25,0.5]);expect(plane(output!,1)).toEqual([0.5,1]);
  const planar:AudioFrameData={...source,sampleFormat:'fltp',samples:2,planes:[new Uint8Array(new Float32Array([0.25,0.25]).buffer),new Uint8Array(new Float32Array([0.5,0.5]).buffer)]};
  const before=planar.planes.map(bytes=>bytes.slice()),[planarOutput]=await collect(compileAudioFilterChain('aintegral').process(input(planar),options));
  expect(planar.planes).toEqual(before);expect(planarOutput!.planes[0]!.buffer).not.toBe(planar.planes[0]!.buffer);expect(plane(planarOutput!,1)).toEqual([0.5,1]);
});
it('fails explicitly at the frame limit, on a later integer conversion beyond the scalar bound, on a format change, and on abort',async()=>{
  await expect(collect(compileAudioFilterChain('aintegral').process(input(frame('s16',2,[1,2,3,4])),{maxFrameBytes:15}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  expect((await collect(compileAudioFilterChain('aintegral').process(input(frame('s16',2,[1,2,3,4])),{maxFrameBytes:16}))).length).toBe(1);
  // 40000 samples of 1.0 integrate past 32768: the following float-to-s16 conversion refuses instead of clipping.
  const ones=frame('flt',1,new Array(40000).fill(1));
  await expect(collect(compileAudioFilterChain('aintegral,aformat=f=s16').process(input(ones),options))).rejects.toThrow('Non-finite or out-of-range floating PCM requires an unimplemented runtime conversion profile');
  const within=await collect(compileAudioFilterChain('aintegral,aformat=f=s16').process(input(frame('flt',1,new Array(4).fill(0.25))),options));
  expect(Array.from(new Int16Array(within[0]!.planes[0]!.slice().buffer))).toEqual([8192,16384,24576,32767]);
  async function* changing(){yield frame('flt',1,[0.5]);yield frame('dbl',1,[0.5]);}
  await expect(collect(compileAudioFilterChain('aintegral').process(changing(),options))).rejects.toThrow('aintegral input format changed between frames');
  async function* widening(){yield frame('flt',1,[0.5]);yield frame('flt',2,[0.5,0.5]);}
  await expect(collect(compileAudioFilterChain('aintegral').process(widening(),options))).rejects.toThrow('aintegral input format changed between frames');
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(collect(compileAudioFilterChain('aintegral').process(input(frame('flt',1,[0.5])),{...options,signal:controller.signal}))).rejects.toThrow('stop');
  const late=new AbortController();
  async function* abortAfterFirst(){yield frame('flt',1,[0.5]);late.abort(new Error('late'));yield frame('flt',1,[0.5]);}
  const seen:AudioFrameData[]=[];
  await expect((async()=>{for await(const output of compileAudioFilterChain('aintegral').process(abortAfterFirst(),{...options,signal:late.signal}))seen.push(output);})()).rejects.toThrow('late');
  expect(seen.length).toBe(1);
});
it('refuses FLAC input before decoding, untimed and timed',()=>{
  expect(()=>compileFlacTransform(parseArgv(['-i','/in.flac','-af','aintegral','/out.pcm']),{format:'f32le',codec:'pcm_f32le'})).toThrow(/^FLAC input to aintegral requires additional Native evidence$/);
  expect(()=>compileFlacTransform(parseArgv(['-i','/in.flac','-af','volume=0.5,aintegral','/out.pcm']),{format:'s16le',codec:'pcm_s16le'})).toThrow(/^FLAC input to aintegral requires additional Native evidence$/);
  expect(()=>compileFlacTransform(parseArgv(['-i','/in.flac','-t','0.002','-af','aintegral','/out.pcm']),{format:'s16le',codec:'pcm_s16le'})).toThrow('Combined FLAC time selection and filters/rate conversion require additional Native packet scheduling');
});
