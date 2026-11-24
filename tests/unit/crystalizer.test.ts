import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {crystalizer} from '../../packages/avfilter/src/audio/crystalizer.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
/** Direct transcription of af_crystalizer.c's filters() macro: float storage (Float32Array cells) rounds after every C operation; prv is a one-sample frame per channel. */
function transcription(samples:readonly (readonly number[])[],mult:number,clip:boolean,single:boolean):number[][]{
  const Cell=single?Float32Array:Float64Array,m=new Cell([mult])[0]!,one=1,scale=new Cell([one/new Cell([-m+one])[0]!])[0]!;
  return samples.map(channel=>{
    const prv=new Cell(1),dst=new Cell(channel.length),t=new Cell(1);
    for(let n=0;n<channel.length;n++){
      const current=new Cell([channel[n]!])[0]!;
      if(m<0){t[0]=prv[0]!*m;t[0]=current-t[0]!;dst[n]=t[0]!*scale;prv[0]=dst[n]!;}
      else{t[0]=current-prv[0]!;t[0]=t[0]!*m;dst[n]=current+t[0]!;prv[0]=current;}
      if(clip){t[0]=dst[n]!>-one?dst[n]!:-one;dst[n]=t[0]!>one?one:t[0]!;}
    }
    return Array.from(dst);
  });
}
/** Per-channel test signal in [-1.3,1.3] (clipping engages), with -0. */
const signal=(channels:number,count:number)=>Array.from({length:channels},(_,c)=>Array.from({length:count},(_,n)=>n===0&&c===0?-0:Math.sin(n*0.37+c)*1.3*((n*7+c)%11)/10));
function frame(values:readonly (readonly number[])[],format:'flt'|'fltp'|'dbl'|'dblp',start=0,count=values[0]!.length):AudioFrameData{
  const channels=values.length,width=format.startsWith('flt')?4:8,planar=format.endsWith('p'),data=new Uint8Array(channels*count*width),view=new DataView(data.buffer);
  for(let c=0;c<channels;c++)for(let n=0;n<count;n++){const offset=(planar?c*count+n:n*channels+c)*width,value=values[c]![start+n]!;if(width===4)view.setFloat32(offset,value,true);else view.setFloat64(offset,value,true);}
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'unspecified',sampleFormat:format,samples:count,planes:planar?Array.from({length:channels},(_,c)=>data.subarray(c*count*width,(c+1)*count*width)):[data],pts:null};
}
function values(frames:readonly AudioFrameData[]):number[][]{
  const channels=frames[0]!.channels,result:number[][]=Array.from({length:channels},()=>[]);
  for(const output of frames){
    const width=output.sampleFormat.startsWith('flt')?4:8,planar=output.sampleFormat.endsWith('p');
    for(let c=0;c<channels;c++){const plane=output.planes[planar?c:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);for(let n=0;n<output.samples;n++){const offset=(planar?n:n*channels+c)*width;result[c]!.push(width===4?view.getFloat32(offset,true):view.getFloat64(offset,true));}}
  }
  return result;
}
it('parses positional and named i/c options as native does and refuses every unimplemented form with an exact message',()=>{
  expect(crystalizer.parse('crystalizer')).toEqual({name:'crystalizer',intensity:2,clip:true});
  expect(crystalizer.parse('crystalizer=-3:0')).toEqual({name:'crystalizer',intensity:-3,clip:false});
  expect(crystalizer.parse('crystalizer=i=2.5:c=false')).toEqual({name:'crystalizer',intensity:2.5,clip:false});
  expect(crystalizer.parse('crystalizer=c=no:i=1e1')).toEqual({name:'crystalizer',intensity:10,clip:false});
  expect(crystalizer.parse('crystalizer=0.1:c=ON')).toEqual({name:'crystalizer',intensity:Math.fround(0.1),clip:true});
  expect(crystalizer.parse('crystalizer=i=-10:c=+1').intensity).toBe(-10);expect(Object.is(crystalizer.parse('crystalizer=-0').intensity,-0)).toBe(true);
  expect(crystalizer.parse('crystalizer=i=1:i=-.5').intensity).toBe(-0.5);
  const refusals:[string,string][]=[
    ['crystalizer=11','crystalizer intensity 11 out of range [-10 - 10]'],['crystalizer=i=-10.0001','crystalizer intensity -10.0001 out of range [-10 - 10]'],
    ['crystalizer=i=1+1','Only constant numeric crystalizer intensity is implemented'],['crystalizer=i=nan','Only constant numeric crystalizer intensity is implemented'],['crystalizer=i=1k','Only constant numeric crystalizer intensity is implemented'],['crystalizer=i=','Only constant numeric crystalizer intensity is implemented'],
    ['crystalizer=c=2','Unsupported crystalizer clipping value: 2'],['crystalizer=c=auto','Unsupported crystalizer clipping value: auto'],['crystalizer=1:maybe','Unsupported crystalizer clipping value: maybe'],
    ['crystalizer=1:1:1','Too many crystalizer options'],['crystalizer=i=1:0','crystalizer positional option after a named option: 0'],
    ['crystalizer=enable=1','crystalizer timeline enable is not implemented'],['crystalizer=intensity=2','Unsupported crystalizer option: intensity'],['crystalizer=i=\'2\'','Quoted or escaped crystalizer options are not implemented']
  ];
  for(const [text,message]of refusals){expect(()=>crystalizer.parse(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(new RegExp(`^${message.replace(/[[\]+.\\]/g,'\\$&')}$`));}
});
it('negotiates the native list: integers widen to flt, floats keep their type, planar input stays planar, and the encoder format merges',()=>{
  const formats=(output:AudioSampleFormat,inputs:readonly AudioSampleFormat[])=>inputs.map(format=>compileAudioFilterChain('crystalizer',{outputSampleFormat:output}).negotiatedSampleFormats(format)[0]);
  expect(formats('s16',['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'])).toEqual(['flt','flt','flt','flt','dbl','fltp','fltp','fltp','fltp','dblp']);
  expect(formats('flt',['u8','s16','s32','flt','dbl'])).toEqual(['flt','flt','flt','flt','dbl']);
  expect(formats('dbl',['u8','s16','s32','flt','dbl'])).toEqual(['dbl','dbl','dbl','flt','dbl']);
  expect(compileAudioFilterChain('aformat=f=fltp,crystalizer',{outputSampleFormat:'s16'}).negotiatedSampleFormats('s16')).toEqual(['fltp','fltp']);
  expect(compileAudioFilterChain('crystalizer',{outputSampleFormat:'s16'}).requiresScalarRounding('s16')).toBe(true);expect(compileAudioFilterChain('crystalizer',{outputSampleFormat:'flt'}).requiresScalarRounding('s16')).toBe(false);
  const chain=compileAudioFilterChain('crystalizer');
  expect([chain.nativeFormatLists,chain.maxBytesPerSample,chain.outputSampleFormat,chain.reframes]).toEqual([true,8,null,true]);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(/^crystalizer with sample rate conversion is not implemented$/);
});
it('declares no constraint, keeps counts and packet sections, and reserves one frame plus the per-channel previous value',()=>{
  const chain=compileAudioFilterChain('crystalizer');
  for(const [channels,channelLayout]of [[1,'mono'],[2,'stereo'],[2,'2 channels (FL+FC)'],[3,'unspecified']] as const)expect(()=>chain.validateInputFormat({sampleRate:8000,channels,channelLayout})).not.toThrow();
  expect(chain.planSamples(1300n,8000)).toMatchObject({samples:1300n,buffers:[]});expect(chain.outputSamples(0n,8000)).toBe(0n);
  expect(chain.packetSections(1300n,512n,8000,false,2)).toEqual([{samples:1300n,span:512n}]);expect(chain.outputPacketSamples(512n)).toBe(512n);
  expect(compileAudioFilterChain('crystalizer,asetnsamples=7').packetSections(13n,4n,8000,false,1)).toEqual([{samples:14n,span:7n}]);
  const planned=chain.plannedReservations({sampleRate:8000,channels:3,sampleFormat:'s16'},{samples:1300n});
  expect(planned.map(entry=>({reservation:entry.reservation,countBuffers:entry.countBuffers}))).toEqual([{reservation:{frames:1,buffers:[],stateBytes:24n},countBuffers:[]}]);
  expect([...chain.reservations({sampleRate:8000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:16n}]);
});
it('matches a direct C transcription for forward and inverse recurrences, packed and planar, with state carried across arbitrary frame splits',async()=>{
  let cases=0;
  for(const format of ['flt','fltp','dbl','dblp'] as const)for(const text of ['crystalizer','crystalizer=i=-3:c=0','crystalizer=i=-10','crystalizer=0:0','crystalizer=10:0','crystalizer=i=2.5:c=0','crystalizer=-0.7:1'])for(const channels of [1,2,3]){
    const step=crystalizer.parse(text),source=signal(channels,97),expected=transcription(source,step.intensity,step.clip,format.startsWith('flt')),rounded=values([frame(source,format)]);
    const output=format.startsWith('flt')?'flt':'dbl',chain=compileAudioFilterChain(text,{outputSampleFormat:output});
    for(const splits of [[97],[1,96],[13,13,13,58],[50,1,1,45]]){
      const frames:AudioFrameData[]=[];let start=0;for(const count of splits){frames.push(frame(rounded,format,start,count));start+=count;}
      const result=await collect(chain.process(input(...frames),{maxFrameBytes:1<<16}));
      expect(result.map(entry=>[entry.sampleFormat,entry.samples]),`${format}/${text}`).toEqual(splits.map(count=>[format,count]));
      expect(values(result),`${format}/${text}/${channels}/${splits.join('+')}`).toEqual(expected);
      cases++;
    }
  }
  expect(cases).toBe(4*7*3*4);
  // The forward filter starts from a silent previous sample: y0 = x0 + x0*mult; the inverse divides by 1 - mult.
  expect(values(await collect(compileAudioFilterChain('crystalizer=2:0',{outputSampleFormat:'dbl'}).process(input(frame([[0.25,0.5]],'dbl')),{maxFrameBytes:64})))).toEqual([[0.75,1]]);
  expect(values(await collect(compileAudioFilterChain('crystalizer=-1:0',{outputSampleFormat:'dbl'}).process(input(frame([[0.5,0.5]],'dbl')),{maxFrameBytes:64})))).toEqual([[0.25,0.375]]);
  // av_clipf maps NaN to -1, while the NaN previous sample keeps propagating; finite overshoot clips to either bound.
  expect(values(await collect(compileAudioFilterChain('crystalizer',{outputSampleFormat:'flt'}).process(input(frame([[Number.NaN,2,-2]],'flt')),{maxFrameBytes:64})))).toEqual([[-1,-1,-1]]);
  expect(values(await collect(compileAudioFilterChain('crystalizer',{outputSampleFormat:'flt'}).process(input(frame([[0.5,-0.5]],'flt')),{maxFrameBytes:64})))).toEqual([[1,-1]]);
});
it('converts integer input to its negotiated float format, owns every output plane and leaves inputs untouched',async()=>{
  const data=new Uint8Array(8),view=new DataView(data.buffer);[1000,-2000,16384,-32768].forEach((value,index)=>view.setInt16(index*2,value,true));
  const source:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:2,planes:[data],pts:null},copy=data.slice();
  const [output]=await collect(compileAudioFilterChain('crystalizer=1:0',{outputSampleFormat:'s16'}).process(input(source),{maxFrameBytes:64}));
  expect(data).toEqual(copy);expect(output!.sampleFormat).toBe('flt');expect(output!.planes[0]!.buffer).not.toBe(data.buffer);
  const x=[1000,-2000,16384,-32768].map(value=>Math.fround(value/32768));
  expect(values([output!])).toEqual(transcription([[x[0]!,x[2]!],[x[1]!,x[3]!]],1,false,true));
  const planar=frame(signal(2,5),'dblp'),before=planar.planes.map(plane=>plane.slice());
  const [owned]=await collect(compileAudioFilterChain('crystalizer',{outputSampleFormat:'dbl'}).process(input(planar),{maxFrameBytes:256}));
  expect(planar.planes).toEqual(before);expect(owned!.planes.every(plane=>planar.planes.every(other=>plane.buffer!==other.buffer))).toBe(true);
});
it('enforces the frame allocation limit, refuses a channel count change and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('crystalizer',{outputSampleFormat:'flt'});
  await expect(collect(chain.process(input(frame(signal(2,9),'flt')),{maxFrameBytes:71}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  await expect(collect(chain.process(input(frame(signal(2,3),'flt'),frame(signal(1,3),'flt')),{maxFrameBytes:64}))).rejects.toThrow(/^crystalizer channel count changed$/);
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(collect(chain.process(input(frame(signal(1,3),'flt')),{maxFrameBytes:64,signal:controller.signal}))).rejects.toThrow('stop');
  const later=new AbortController();let yielded=0;
  async function* frames(){yield frame(signal(1,3),'flt');later.abort(new Error('late'));yield frame(signal(1,3),'flt');}
  await expect((async()=>{for await(const output of chain.process(frames(),{maxFrameBytes:64,signal:later.signal}))yielded+=output.samples/3;})()).rejects.toThrow('late');
  expect(yielded).toBe(1);
  expect(await collect(chain.process(input(),{maxFrameBytes:64,inputFormat:{sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:null}}))).toEqual([]);
});
