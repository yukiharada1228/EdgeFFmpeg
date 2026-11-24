import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const widths={u8:1,s16:2,s32:4,flt:4,dbl:8} as const;
/** Deterministic frame: every byte pattern, planar formats split per channel. */
function frame(format:string,channels:number,samples:number,offset=0):AudioFrameData{
  const planar=format.endsWith('p'),width=widths[format.replace(/p$/,'') as keyof typeof widths],bytes=(index:number)=>(index*73+offset*31+17)&255;
  const planes=planar?Array.from({length:channels},(_,c)=>Uint8Array.from({length:samples*width},(_,i)=>bytes(c*997+i))):[Uint8Array.from({length:samples*channels*width},(_,i)=>bytes(i))];
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'unspecified',sampleFormat:format,samples,planes,pts:{value:BigInt(offset),timeBase:{num:1n,den:8000n}}};
}
it('accepts only the bare acopy token and refuses every option form with an exact message',()=>{
  expect(compileAudioFilterChain('acopy').steps).toEqual([{name:'acopy'}]);expect(Object.isFrozen(compileAudioFilterChain(' acopy ').steps[0])).toBe(true);
  for(const text of ['acopy=1','acopy=','acopy=a=b','acopy=1:2'])expect(()=>compileAudioFilterChain(text),text).toThrow(new AudioFilterError(`acopy takes no options: ${text}`));
  expect(()=>compileAudioFilterChain('acopyx')).toThrow('Unsupported audio filter: acopyx');
});
it('declares a stateless frame-allocating copy with no rate conversion, time selection or FLAC input',()=>{
  const chain=compileAudioFilterChain('acopy');
  expect(chain.capabilities).toEqual([{generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false}]);
  expect(chain.reframes).toBe(false);expect(chain.nativeFormatLists).toBe(false);expect(chain.maxBufferedSamples).toBe(0);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(AudioFilterError);expect(chain.rateBoundary('s16',8000,8000)).toBeNull();
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:3,channelLayout:'downmix'})).not.toThrow();
});
it('negotiates the input format for u8, s16, s32, flt and dbl and merges with its neighbours',()=>{
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const)for(const hint of ['s16','dbl'] as const){
    const chain=compileAudioFilterChain('acopy',{outputSampleFormat:hint});
    expect(chain.negotiatedSampleFormats(format),`${format} ${hint}`).toEqual([format]);expect(chain.resolvedSampleFormat(format)).toBe(format);expect(chain.requiresScalarRounding(format)).toBe(compileAudioFilterChain('anull',{outputSampleFormat:hint}).requiresScalarRounding(format));
    expect(compileAudioFilterChain('acopy,acopy',{outputSampleFormat:hint}).negotiatedSampleFormats(format)).toEqual([format,format]);
  }
  expect(compileAudioFilterChain('acopy,volume=0.5').negotiatedSampleFormats('s16')).toEqual(['s16','flt']);
  expect(compileAudioFilterChain('asetnsamples=7,acopy').negotiatedSampleFormats('u8')).toEqual(['u8','u8']);
});
it('plans unchanged counts, packet sections and one frame reservation',()=>{
  for(const samples of [0n,1n,13n,100000n]){
    const plan=compileAudioFilterChain('acopy').planSamples(samples,8000,{configuredInput:true,channels:2});
    expect(plan.samples).toBe(samples);expect(plan.buffers).toEqual([]);expect(plan.stages.map(stage=>[stage.inputSamples,stage.outputSamples,stage.packets])).toEqual([[samples,samples,undefined]]);
  }
  expect(compileAudioFilterChain('acopy').packetSections(13n,4n,8000,true,2)).toEqual([{samples:13n,span:4n}]);
  expect(compileAudioFilterChain('asetnsamples=7,acopy').packetSections(13n,4n,8000,true,2)).toEqual([{samples:14n,span:7n}]);
  expect(compileAudioFilterChain('apad=pad_len=9,acopy').packetSections(13n,4n,8000,true,2)).toEqual([{samples:13n,span:4n},{samples:9n,span:4096n}]);
  const reservations=compileAudioFilterChain('acopy,acopy').plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,configuredInput:true,channels:2});
  expect(reservations.map(entry=>[entry.reservation,entry.countBuffers])).toEqual([[{frames:1,buffers:[],stateBytes:0n},[]],[{frames:1,buffers:[],stateBytes:0n},[]]]);
  expect([...compileAudioFilterChain('acopy').reservations({sampleRate:8000,channels:3,sampleFormat:'dbl'})]).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
});
it('returns owned planes byte-equal to a transcription of av_frame_copy, without mutating the input, at any frame split',async()=>{
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const)for(const channels of [1,2,3]){
    const whole=frame(format,channels,29),copies=whole.planes.map(plane=>plane.slice());
    const output=compileAudioFilterChain('acopy,acopy').apply(whole,{maxFrameBytes:1<<16});
    // av_frame_copy: memcpy of every plane, linesize-bounded; frame properties copied.
    expect(output.planes).toEqual(copies);expect(whole.planes).toEqual(copies);
    expect({...output,planes:[]}).toEqual({...whole,planes:[]});
    expect(output.planes.every(plane=>whole.planes.every(source=>source.buffer!==plane.buffer))).toBe(true);
    for(const sizes of [[1,28],[7,7,7,8],[13,16]]){
      async function* frames(){let offset=0;for(const samples of sizes){const piece=whole.planes.map(plane=>plane.slice(offset*plane.length/29,(offset+samples)*plane.length/29));yield {...whole,samples,planes:piece,pts:{value:BigInt(offset),timeBase:whole.pts!.timeBase}};offset+=samples;}}
      const pieces:AudioFrameData[]=[];for await(const value of compileAudioFilterChain('acopy').process(frames(),{maxFrameBytes:1<<16}))pieces.push(value);
      expect(pieces.map(piece=>piece.samples)).toEqual(sizes);expect(pieces.map(piece=>piece.pts?.value)).toEqual(sizes.map((_,i)=>BigInt(sizes.slice(0,i).reduce((a,b)=>a+b,0))));
      expect(whole.planes.map((_,p)=>Buffer.concat(pieces.map(piece=>piece.planes[p]!)))).toEqual(copies.map(plane=>Buffer.from(plane)));
    }
  }
  const converted=compileAudioFilterChain('acopy,volume=1').apply(frame('s16',2,4),{maxFrameBytes:64});expect(converted.sampleFormat).toBe('flt');
});
it('enforces maxFrameBytes and observes AbortSignal',async()=>{
  const chain=compileAudioFilterChain('acopy'),input=frame('s16p',2,8);
  expect(chain.apply(input,{maxFrameBytes:32}).planes.map(plane=>plane.length)).toEqual([16,16]);
  expect(()=>chain.apply(input,{maxFrameBytes:31})).toThrow(AudioFilterError);
  const {acopy}=await import('../../packages/avfilter/src/audio/acopy.js');
  expect(()=>acopy.apply!({name:'acopy'},input,'s16p',{maxFrameBytes:31})).toThrow('acopy frame exceeds allocation limit');
  expect(()=>acopy.apply!({name:'acopy'},input,'s16p',{maxFrameBytes:0})).toThrow('acopy frame exceeds allocation limit');
  const controller=new AbortController();controller.abort(new Error('stop'));
  expect(()=>acopy.apply!({name:'acopy'},input,'s16p',{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
  expect(()=>chain.apply(input,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
  const late=new AbortController();let closed=false;async function* frames(){try{yield input;late.abort(new Error('late'));yield input;}finally{closed=true;}}
  const seen:AudioFrameData[]=[];await expect((async()=>{for await(const value of chain.process(frames(),{maxFrameBytes:64,signal:late.signal}))seen.push(value);})()).rejects.toThrow('late');
  expect(seen.length).toBe(1);expect(closed).toBe(true);
});
