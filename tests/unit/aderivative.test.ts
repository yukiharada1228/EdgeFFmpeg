import {expect,it} from 'vitest';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const widths={s16:2,s32:4,flt:4,dbl:8} as const;
/** Direct transcription of DERIVATIVE(name,type) in af_aderivative.c over one whole planar stream: int16_t/int32_t subtraction truncates to the type. */
function reference(format:'s16'|'s32'|'flt'|'dbl',planes:number[][]):number[][]{
  return planes.map(src=>{let prv=0;return src.map(current=>{const dst=format==='s16'?(current-prv)<<16>>16:format==='s32'?(current-prv)|0:format==='flt'?Math.fround(current-prv):current-prv;prv=current;return dst;});});
}
function read(format:'s16'|'s32'|'flt'|'dbl',plane:Uint8Array):number[]{
  const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),width=widths[format];
  return Array.from({length:plane.length/width},(_,i)=>format==='s16'?view.getInt16(i*2,true):format==='s32'?view.getInt32(i*4,true):format==='flt'?view.getFloat32(i*4,true):view.getFloat64(i*8,true));
}
function write(format:'s16'|'s32'|'flt'|'dbl',values:number[]):Uint8Array{
  const width=widths[format],data=new Uint8Array(values.length*width),view=new DataView(data.buffer);
  values.forEach((value,i)=>format==='s16'?view.setInt16(i*2,value,true):format==='s32'?view.setInt32(i*4,value,true):format==='flt'?view.setFloat32(i*4,value,true):view.setFloat64(i*8,value,true));
  return data;
}
/** Planar frames of the given sizes cut from per-channel sample arrays. */
function frames(format:'s16'|'s32'|'flt'|'dbl',planes:number[][],sizes:number[]):AudioFrameData[]{
  const result:AudioFrameData[]=[];let offset=0;
  for(const samples of sizes){result.push({sampleRate:8000,channels:planes.length,channelLayout:planes.length===1?'mono':planes.length===2?'stereo':'unspecified',sampleFormat:`${format}p`,samples,planes:planes.map(plane=>write(format,plane.slice(offset,offset+samples))),pts:{value:BigInt(offset),timeBase:{num:1n,den:8000n}}});offset+=samples;}
  return result;
}
const extremes={s16:[32767,-32768,32767,0,-32768,-32768,32767,1,-1],s32:[2147483647,-2147483648,2147483647,0,-2147483648,-2147483648,2147483647,1,-1],flt:[1,-1,Math.fround(0.1),-0,Math.fround(3e38),Math.fround(-3e38),Math.fround(1e-45),Math.fround(1/3)],dbl:[1,-1,0.1,-0,1.7e308,-1.7e308,5e-324,1/3]} as const;
it('accepts only the bare token and refuses every option, timeline enable and empty argument with exact messages',()=>{
  expect(compileAudioFilterChain('aderivative').steps).toEqual([{name:'aderivative'}]);
  expect(Object.isFrozen(compileAudioFilterChain('aderivative').steps[0])).toBe(true);
  for(const [text,message]of [['aderivative=1','Unsupported aderivative option: 1'],['aderivative=foo=1','Unsupported aderivative option: foo=1'],['aderivative=','Unsupported aderivative option: '],['aderivative=enable=1','aderivative timeline enable is not implemented'],['aderivative=enable','aderivative timeline enable is not implemented'],['aderivative=enable=between(t\\,0\\,1)','aderivative timeline enable is not implemented']] as const){
    expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(message);
  }
  expect(()=>compileAudioFilterChain('aderivativex')).toThrow('Unsupported audio filter: aderivativex');
});
it('declares a stream step that allocates frames, keeps counts and packets, and refuses rate conversion and FLAC input',()=>{
  const chain=compileAudioFilterChain('aderivative'),[step]=chain.steps;
  expect(audioFilterCapabilities(step!)).toEqual({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(chain.reframes).toBe(true);expect(chain.nativeFormatLists).toBe(true);
  for(const samples of [0n,1n,7n,20000n]){const plan=chain.planSamples(samples,8000,{channels:2});expect(plan.samples).toBe(samples);expect(plan.buffers).toEqual([]);expect(plan.stages[0]!.packets).toBeUndefined();expect(chain.outputSamples(samples,8000,{channels:2})).toBe(samples);}
  expect(chain.packetSections(20000n,1024n,8000,true,2)).toEqual([{samples:20000n,span:1024n}]);
  expect(compileAudioFilterChain('asetnsamples=7,aderivative').packetSections(20000n,1024n,8000,true,2)).toEqual([{samples:20006n,span:7n}]);
  expect(compileAudioFilterChain('aderivative,apad=pad_len=5').packetSections(20000n,1024n,8000,true,2)).toEqual([{samples:20000n,span:1024n},{samples:5n,span:4096n}]);
  expect(chain.outputPacketSamples(1024n)).toBe(1024n);expect(chain.maxBufferedSamples).toBe(0);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('aderivative with sample rate conversion is not implemented');
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  expect(()=>chain.apply(frame,{maxFrameBytes:16})).toThrow('aderivative requires stream processing');
  expect(()=>chain.validateInputFormat({sampleRate:8000,channels:3,channelLayout:'2 channels (FL+FC)'})).not.toThrow();
});
it('reserves one output frame plus the per-channel previous sample at the working width on both planners',()=>{
  const chain=compileAudioFilterChain('aderivative');
  for(const [format,width]of [['u8',2],['s16',2],['s32',4],['flt',4],['dbl',8],['s16p',2],['dblp',8]] as const)for(const channels of [1,2,3]){
    const expected={frames:1,buffers:[],stateBytes:BigInt(channels*width)},input={sampleRate:8000,channels,sampleFormat:format};
    expect([...chain.reservations(input)],`${format}/${channels}`).toEqual([expected]);
    const [entry]=chain.plannedReservations(input,{samples:20000n,configuredInput:true,channels});
    expect(entry!.reservation,`${format}/${channels}`).toEqual(expected);expect(entry!.countBuffers).toEqual([]);
  }
  // Later in a chain the step sees the previous step's negotiated output.
  const [,entry]=compileAudioFilterChain('aformat=dbl,aderivative').plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:5n,channels:2});
  expect(entry!.reservation.stateBytes).toBe(16n);
});
it('negotiates native picks: u8 and s16 to s16p, s32 to s32p, flt to fltp and dbl to dblp, with a single rounding only from float input',()=>{
  const table={u8:'s16p',s16:'s16p',s32:'s32p',flt:'fltp',dbl:'dblp',u8p:'s16p',s16p:'s16p',s32p:'s32p',fltp:'fltp',dblp:'dblp'} as const;
  for(const hint of ['s16','s32','flt','dbl','u8'] as const){
    const chain=compileAudioFilterChain('aderivative',{outputSampleFormat:hint});
    for(const [format,expected]of Object.entries(table)){expect(chain.negotiatedSampleFormats(format as AudioSampleFormat),`${hint}/${format}`).toEqual([expected]);expect(chain.resolvedSampleFormat(format as AudioSampleFormat)).toBe(expected);}
  }
  const chain=compileAudioFilterChain('aderivative',{outputSampleFormat:'s16'});
  expect(chain.requiresScalarRounding('flt')).toBe(true);expect(chain.requiresScalarRounding('s16')).toBe(false);
  // Neighbour merges native would make into another working type are refused explicitly.
  expect(()=>compileAudioFilterChain('volume=0.5:precision=fixed,aderivative',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toThrow(/requires unimplemented format negotiation/);
  for(const format of ['u8','dbl'] as const)expect(()=>compileAudioFilterChain('volume=0.5:precision=fixed,aderivative',{outputSampleFormat:'s16'}).negotiatedSampleFormats(format)).toThrow(`aderivative with ${format} input requires unimplemented format negotiation`);
  // Merges native does make are reproduced: an s16p pin after it merges into its list, fixed volume after it keeps the encoder out.
  expect(compileAudioFilterChain('aderivative,aformat=s16p',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toEqual(['s16p','s16p']);
  expect(compileAudioFilterChain('aderivative,volume=0.5:precision=fixed',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toEqual(['s32p','s32']);
});
it('matches a C transcription with two\'s-complement wrap and float32 rounding, independent of frame splits',async()=>{
  const chain=compileAudioFilterChain('aderivative');
  for(const format of ['s16','s32','flt','dbl'] as const)for(const channels of [1,2,3]){
    const length=257,ramp=extremes[format],planes=Array.from({length:channels},(_,c)=>Array.from({length},(_,i)=>{const value=ramp[(i*(c+2)+c)%ramp.length]!;return format==='s16'||format==='s32'||i%5?value:format==='flt'?Math.fround(Math.sin(i*0.37+c)):Math.sin(i*0.37+c);}));
    const expected=reference(format,planes);
    for(const sizes of [[257],[1,1,1,254],[7,100,3,147],Array.from({length:257},()=>1)]){
      const source=frames(format,planes,sizes),copies=source.map(frame=>frame.planes.map(plane=>plane.slice()));
      const output=await collect(chain.process(input(...source),{maxFrameBytes:1<<16}));
      expect(source.map(frame=>frame.planes),`${format}/${channels} input untouched`).toEqual(copies);
      expect(output.map(frame=>frame.samples)).toEqual(sizes);expect(output.map(frame=>frame.pts)).toEqual(source.map(frame=>frame.pts));
      expect(output.every(frame=>frame.sampleFormat===`${format}p`)).toBe(true);
      const owned=new Set(source.flatMap(frame=>frame.planes.map(plane=>plane.buffer)));expect(output.some(frame=>frame.planes.some(plane=>owned.has(plane.buffer)))).toBe(false);
      const joined=Array.from({length:channels},(_,c)=>output.flatMap(frame=>read(format,frame.planes[c]!)));
      expect(joined.map(plane=>plane.map(value=>Object.is(value,-0)?'-0':value)),`${format}/${channels}/${sizes.length}`).toEqual(expected.map(plane=>plane.map(value=>Object.is(value,-0)?'-0':value)));
    }
  }
  // Full-scale wrap: 32767-(-32768) wraps to -1 and -32768-32767 to 1; int32 likewise.
  const [s16]=await collect(chain.process(input(...frames('s16',[[-32768,32767,-32768]],[3])),{maxFrameBytes:64}));
  expect(read('s16',s16!.planes[0]!)).toEqual([-32768,-1,1]);
  const [s32]=await collect(chain.process(input(...frames('s32',[[-2147483648,2147483647,-2147483648]],[3])),{maxFrameBytes:64}));
  expect(read('s32',s32!.planes[0]!)).toEqual([-2147483648,-1,1]);
});
it('converts packed and u8 input to the negotiated planar format before differencing',async()=>{
  const chain=compileAudioFilterChain('aderivative');
  const u8:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8',samples:3,planes:[Uint8Array.from([0,255,255,0,128,128])],pts:null};
  const [output]=await collect(chain.process(input(u8),{maxFrameBytes:64}));
  // u8 widens as (v-128)<<8: -32768, 32512, 0 on the left and 32512, -32768, 0 on the right.
  expect(output!.sampleFormat).toBe('s16p');expect(read('s16',output!.planes[0]!)).toEqual([-32768,(32512+32768)<<16>>16,-32512]);expect(read('s16',output!.planes[1]!)).toEqual([32512,(-32768-32512)<<16>>16,32768<<16>>16]);
  expect(u8.planes[0]).toEqual(Uint8Array.from([0,255,255,0,128,128]));
  const packed:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'dbl',samples:2,planes:[write('dbl',[0.5,-0.25,0.75,0.25])],pts:null};
  const [dbl]=await collect(chain.process(input(packed),{maxFrameBytes:64}));
  expect(dbl!.sampleFormat).toBe('dblp');expect(read('dbl',dbl!.planes[0]!)).toEqual([0.5,0.25]);expect(read('dbl',dbl!.planes[1]!)).toEqual([-0.25,0.5]);
  expect(await collect(chain.process(input(),{maxFrameBytes:64}))).toEqual([]);
});
it('refuses non-finite floating input, enforces the frame allocation limit and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('aderivative');
  for(const value of [Number.NaN,Infinity,-Infinity])for(const format of ['flt','dbl'] as const)await expect(collect(chain.process(input(...frames(format,[[0,value]],[2])),{maxFrameBytes:64}))).rejects.toThrow('Non-finite aderivative input is not yet supported');
  await expect(collect(chain.process(input(...frames('s32',[[1,2,3,4]],[4])),{maxFrameBytes:15}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(collect(chain.process(input(...frames('s16',[[1,2]],[2])),{maxFrameBytes:64,signal:controller.signal}))).rejects.toThrow('stop');
  const later=new AbortController(),source=frames('s16',[[1,2,3,4]],[2,2]);
  async function* aborting(){yield source[0]!;later.abort(new Error('late'));yield source[1]!;}
  const seen:AudioFrameData[]=[];
  await expect((async()=>{for await(const frame of chain.process(aborting(),{maxFrameBytes:64,signal:later.signal}))seen.push(frame);})()).rejects.toThrow('late');
  expect(seen.length).toBe(1);
});
