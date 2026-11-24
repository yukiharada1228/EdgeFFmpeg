import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {adynamicsmooth,smoothAudio} from '../../packages/avfilter/src/audio/adynamicsmooth.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const parse=(text:string)=>adynamicsmooth.parse(text);
/** Direct transcription of af_adynamicsmooth.c filter_frame over one whole channel. */
function reference(source:readonly number[],sensitivity:number,basefreq:number,rate:number):number[] {
  const wc=basefreq/rate,out:number[]=[];let low1=0,low2=0,inz=0;
  for(const x of source){
    const low1z=low1,low2z=low2,bandz=low2z-low1z,wd=wc+sensitivity*Math.abs(bandz);
    const g=Math.min(1,wd*(5.9948827+wd*(-11.969296+wd*15.959062)));
    low1=low1z+g*(0.5*(x+inz)-low1z);low2=low2z+g*(0.5*(low1+low1z)-low2z);inz=x;out.push(low2);
  }
  return out;
}
const signal=(length:number,channel:number)=>Array.from({length},(_,i)=>i===0?-0:Math.sin(i*0.731+channel)*((i%13)/12)+(i%7===0?0.9:0));
function planar(channels:number[][],offset:number,samples:number):AudioFrameData {
  return {sampleRate:44100,channels:channels.length,channelLayout:channels.length===1?'mono':channels.length===2?'stereo':'unspecified',sampleFormat:'dblp',samples,
    planes:channels.map(values=>{const plane=new Uint8Array(samples*8),view=new DataView(plane.buffer);for(let n=0;n<samples;n++)view.setFloat64(n*8,values[offset+n]!,true);return plane;}),pts:{value:BigInt(offset),timeBase:{num:1n,den:44100n}}};
}
const read=(frames:AudioFrameData[],channel:number)=>frames.flatMap(frame=>{const plane=frame.planes[channel]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:frame.samples},(_,n)=>view.getFloat64(n*8,true));});
it('parses named and positional plain decimals and refuses every other form with exact messages',()=>{
  expect(parse('adynamicsmooth')).toEqual({name:'adynamicsmooth',sensitivity:2,basefreq:22050});
  expect(parse('adynamicsmooth=sensitivity=0:basefreq=2')).toEqual({name:'adynamicsmooth',sensitivity:0,basefreq:2});
  expect(parse('adynamicsmooth=1000:1e6'.replace('1e6','1000000'))).toEqual({name:'adynamicsmooth',sensitivity:1000,basefreq:1000000});
  expect(parse('adynamicsmooth=.5')).toEqual({name:'adynamicsmooth',sensitivity:0.5,basefreq:22050});
  expect(parse('adynamicsmooth=basefreq=1000.25:sensitivity=7.')).toEqual({name:'adynamicsmooth',sensitivity:7,basefreq:1000.25});
  expect(parse('adynamicsmooth=3:basefreq=100')).toEqual({name:'adynamicsmooth',sensitivity:3,basefreq:100});
  expect(Object.isFrozen(parse('adynamicsmooth'))).toBe(true);
  const refusals:[string,string][]=[
    ['adynamicsmooth=1e3','Unsupported adynamicsmooth sensitivity: 1e3'],['adynamicsmooth=-1','Unsupported adynamicsmooth sensitivity: -1'],['adynamicsmooth=+1','Unsupported adynamicsmooth sensitivity: +1'],
    ['adynamicsmooth=basefreq=0x10','Unsupported adynamicsmooth basefreq: 0x10'],['adynamicsmooth=basefreq=1k','Unsupported adynamicsmooth basefreq: 1k'],['adynamicsmooth=','Unsupported adynamicsmooth sensitivity: '],
    ['adynamicsmooth=1000001','adynamicsmooth sensitivity 1000001 is out of range [0 - 1000000]'],['adynamicsmooth=basefreq=1.99','adynamicsmooth basefreq 1.99 is out of range [2 - 1000000]'],['adynamicsmooth=2:1000000.5','adynamicsmooth basefreq 1000000.5 is out of range [2 - 1000000]'],
    ['adynamicsmooth=enable=1','adynamicsmooth timeline enable is not implemented'],['adynamicsmooth=2:enable=between(t\\,0\\,1)','adynamicsmooth timeline enable is not implemented'],
    ['adynamicsmooth=1:2:3','Unsupported adynamicsmooth option: 3'],['adynamicsmooth=basefreq=3:2','Unsupported adynamicsmooth option: 2'],['adynamicsmooth=s=2','Unsupported adynamicsmooth option: s=2'],['adynamicsmoothx','Unsupported audio filter: adynamicsmoothx']
  ];
  for(const [text,message]of refusals){expect(()=>parse(text),text).toThrow(AudioFilterError);expect(()=>parse(text),text).toThrow(message);}
  for(const [text,message]of refusals.slice(0,-1))expect(()=>compileAudioFilterChain(text),text).toThrow(message);
});
it('negotiates pinned dblp for every input format, reproduces native neighbours and declares its capabilities',()=>{
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as AudioSampleFormat[])for(const output of ['u8','s16','s32','flt','dbl'] as AudioSampleFormat[]){
    const chain=compileAudioFilterChain('adynamicsmooth',{outputSampleFormat:output});
    expect(chain.negotiatedSampleFormats(format),`${format}->${output}`).toEqual(['dblp']);expect(chain.resolvedSampleFormat(format)).toBe('dblp');expect(chain.nativeFormatLists).toBe(true);
  }
  expect(compileAudioFilterChain('volume=0.5,adynamicsmooth,asetnsamples=4').negotiatedSampleFormats('s16')).toEqual(['flt','dblp','dblp']);
  expect(compileAudioFilterChain('adynamicsmooth,adynamicsmooth=0:2').negotiatedSampleFormats('flt')).toEqual(['dblp','dblp']);
  const chain=compileAudioFilterChain('adynamicsmooth');
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('adynamicsmooth with sample rate conversion is not implemented');
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  expect(()=>chain.apply(frame,{maxFrameBytes:64})).toThrow('adynamicsmooth requires stream processing');
});
it('has no format constraint: every rate, channel count and container layout name passes validation',()=>{
  const chain=compileAudioFilterChain('adynamicsmooth=2:1000');
  for(const [sampleRate,channels,channelLayout]of [[8000,1,'mono'],[44100,2,'stereo'],[96000,3,'unspecified'],[8000,2,'2 channels (FL+FC)'],[22050,3,'3.0(back)'],[8000,5,'5 channels']] as const)expect(()=>chain.validateInputFormat({sampleRate,channels,channelLayout})).not.toThrow();
});
it('plans unchanged counts and packets and reserves one frame plus three doubles per channel',()=>{
  const chain=compileAudioFilterChain('adynamicsmooth');
  expect(chain.planSamples(13n,8000,{channels:2})).toMatchObject({samples:13n,buffers:[]});expect(chain.outputSamples(0n,8000)).toBe(0n);
  expect(chain.packetSections(13n,4n,8000,true,2)).toEqual([{samples:13n,span:4n}]);expect(chain.outputPacketSamples(1024n)).toBe(1024n);expect(chain.maxBufferedSamples).toBe(0);
  for(const channels of [1,2,3,8]){
    const [entry]=chain.plannedReservations({sampleRate:8000,channels,sampleFormat:'s16'},{samples:1000n,channels,configuredInput:true});
    expect(entry!.reservation).toEqual({frames:1,buffers:[],stateBytes:BigInt(channels*24)});expect(entry!.countBuffers).toEqual([]);
    expect([...chain.reservations({sampleRate:8000,channels,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:BigInt(channels*24)}]);
  }
  const composed=compileAudioFilterChain('asetnsamples=5,adynamicsmooth').plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,channels:2});
  expect(composed.map(entry=>entry.reservation.stateBytes)).toEqual([0n,48n]);
});
it('matches a direct transcription of the C loop bit for bit and is invariant to frame splits',async()=>{
  const total=1500;
  for(const [sensitivity,basefreq]of [[0,2],[2,1000],[2,22050],[1000,22050],[1000,1000000],[2,1000000],[0.37,44.1]] as const)for(const count of [1,2,3]){
    const channels=Array.from({length:count},(_,c)=>signal(total,c)),step=parse(`adynamicsmooth=${sensitivity}:${basefreq}`);
    const expected=channels.map(values=>reference(values,sensitivity,basefreq,44100));
    for(const sizes of [[total],[1,2,3,500,994],[7,1493],Array<number>(15).fill(100)]){
      const frames:AudioFrameData[]=[];let offset=0;for(const samples of sizes){frames.push(planar(channels,offset,samples));offset+=samples;}
      const output=await collect(smoothAudio(step,input(...frames),{maxFrameBytes:1<<20}));
      expect(output.map(frame=>frame.samples)).toEqual(sizes);expect(output.map(frame=>frame.pts)).toEqual(frames.map(frame=>frame.pts));
      for(let c=0;c<count;c++)expect(read(output,c).map(value=>Object.is(value,-0)?'-0':value.toString(16)),`${sensitivity}:${basefreq} ${count}ch ${sizes.length}`).toEqual(expected[c]!.map(value=>Object.is(value,-0)?'-0':value.toString(16)));
    }
  }
});
it('runs through the chain from packed integer input, leaves inputs untouched and owns its output planes',async()=>{
  const chain=compileAudioFilterChain('asetnsamples=3:p=0,adynamicsmooth=2:1000',{outputSampleFormat:'s16'}),samples=10,data=Uint8Array.from({length:samples*4},(_,i)=>(i*73+37)&255),copy=data.slice();
  const frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples,planes:[data],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
  const output=await collect(chain.process(input(frame),{maxFrameBytes:4096}));
  expect(data).toEqual(copy);expect(output.map(entry=>[entry.samples,entry.sampleFormat])).toEqual([[3,'dblp'],[3,'dblp'],[3,'dblp'],[1,'dblp']]);
  expect(output.every(entry=>entry.planes.every(plane=>plane.buffer!==data.buffer))).toBe(true);
  const view=new DataView(data.buffer);
  for(let c=0;c<2;c++)expect(read(output,c)).toEqual(reference(Array.from({length:samples},(_,n)=>view.getInt16((n*2+c)*2,true)/32768),2,1000,8000));
  // dblp input is copied, never smoothed in place.
  const source=planar([signal(8,0)],0,8),before=source.planes.map(plane=>plane.slice()),[smoothed]=await collect(smoothAudio(parse('adynamicsmooth'),input(source),{maxFrameBytes:64}));
  expect(source.planes).toEqual(before);expect(smoothed!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);
  expect(await collect(chain.process(input(),{maxFrameBytes:64,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}}))).toEqual([]);
});
it('enforces allocation, channel, finiteness and cancellation limits',async()=>{
  const step=parse('adynamicsmooth'),frame=planar([signal(8,0),signal(8,1)],0,8);
  await expect(collect(smoothAudio(step,input(frame),{maxFrameBytes:127}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  expect((await collect(smoothAudio(step,input(frame),{maxFrameBytes:128})))[0]!.samples).toBe(8);
  await expect(collect(smoothAudio(step,input(frame,planar([signal(8,0)],0,8)),{maxFrameBytes:128}))).rejects.toThrow('adynamicsmooth requires a stable channel count');
  for(const value of [Number.NaN,Infinity,-Infinity])await expect(collect(smoothAudio(step,input(planar([[0.5,value]],0,2)),{maxFrameBytes:64})),String(value)).rejects.toThrow('Non-finite adynamicsmooth input is not yet supported');
  const controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(collect(smoothAudio(step,input(frame),{maxFrameBytes:128,signal:controller.signal}))).rejects.toThrow('stopped');
  const late=new AbortController(),frames=(async function*(){yield frame;late.abort(new Error('late'));yield frame;})(),seen:AudioFrameData[]=[];
  await expect((async()=>{for await(const value of smoothAudio(step,frames,{maxFrameBytes:128,signal:late.signal}))seen.push(value);})()).rejects.toThrow('late');expect(seen).toHaveLength(1);
});
