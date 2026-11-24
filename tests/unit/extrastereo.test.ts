import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import {extraStereoSamples} from '../../packages/avfilter/src/audio/extrastereo.js';

/** Direct transcription of af_extrastereo.c filter_frame: float locals, (left+right)/2. in double, av_clipf_c. */
function reference(input:Float32Array,mult:number,clip:boolean):Float32Array {
  const out=new Float32Array(input.length),m=Math.fround(mult),f=Math.fround;
  for(let n=0;n<input.length/2;n++){
    let left=input[n*2]!,right=input[n*2+1]!;
    const average=f(f(left+right)/2.);
    left=f(average+f(m*f(left-average)));right=f(average+f(m*f(right-average)));
    if(clip){left=Math.min(Math.max(left,-1),1);right=Math.min(Math.max(right,-1),1);}
    out[n*2]=left;out[n*2+1]=right;
  }
  return out;
}
const stereo=(values:Float32Array,pts:bigint|null=7n):AudioFrameData=>({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'flt',samples:values.length/2,planes:[new Uint8Array(values.buffer.slice(0))],pts:pts===null?null:{value:pts,timeBase:{num:1n,den:8000n}}});
const floats=(frame:AudioFrameData)=>new Float32Array(frame.planes[0]!.buffer.slice(frame.planes[0]!.byteOffset,frame.planes[0]!.byteOffset+frame.samples*8));
let seed=12345;
const random=()=>{seed=(seed*1103515245+12345)>>>0;return seed/4294967296;};
const input=Float32Array.from({length:4000},(_,index)=>index<16?[0,-0,0.5,-0.5,1,-1,-0,0,0.25,0.25,-1,1,3e-39,-3e-39,0.75,-0.25][index]!:Math.fround((random()*2-1)*(index%7===0?1.7:1)));

it('parses extrastereo options with native shorthand order and refuses everything else with exact messages',()=>{
  const step=(text:string)=>compileAudioFilterChain(text).steps[0];
  expect(step('extrastereo')).toEqual({name:'extrastereo',mult:2.5,clip:true});
  expect(step('extrastereo=m=-1:c=0')).toEqual({name:'extrastereo',mult:-1,clip:false});
  expect(step('extrastereo=10:1')).toEqual({name:'extrastereo',mult:10,clip:true});
  expect(step('extrastereo=0.1')).toEqual({name:'extrastereo',mult:Math.fround(0.1),clip:true});
  expect(step('extrastereo=c=false:m=-10')).toEqual({name:'extrastereo',mult:-10,clip:false});
  expect(step('extrastereo=m=1:m=3:c=true')).toEqual({name:'extrastereo',mult:3,clip:true});
  expect(step(' extrastereo=2:c=0 ')).toEqual({name:'extrastereo',mult:2,clip:false});
  const refusals:[string,string][]=[
    ['extrastereo=','Unsupported audio filter: extrastereo='],
    ['extrastereo=m=10.5','extrastereo m must be within [-10,10]'],
    ['extrastereo=-10.0001','extrastereo m must be within [-10,10]'],
    ['extrastereo=m=1+1','Only decimal extrastereo m values are implemented'],
    ['extrastereo=m=max','Only decimal extrastereo m values are implemented'],
    ['extrastereo=m=','Only decimal extrastereo m values are implemented'],
    ['extrastereo=c=2','Only 0, 1, true or false extrastereo c values are implemented'],
    ['extrastereo=c=yes','Only 0, 1, true or false extrastereo c values are implemented'],
    ['extrastereo=1:0:2','Unsupported extrastereo option: 2'],
    ['extrastereo=m=1:0','Unsupported extrastereo option: 0'],
    ['extrastereo=mult=1','Unsupported extrastereo option: mult=1'],
    ['extrastereo=enable=gt(t\\,1)','extrastereo timeline enable is not implemented'],
    ['extrastereo=m=2:enable=1','extrastereo timeline enable is not implemented']
  ];
  for(const [text,message]of refusals){let error:unknown;try{compileAudioFilterChain(text);}catch(caught){error=caught;}expect(error,text).toBeInstanceOf(AudioFilterError);expect((error as Error).message,text).toBe(message);}
});

it('pins packed flt for every input format and plans one frame-producing stage without count changes',()=>{
  for(const output of ['u8','s16','s32','flt','dbl'] as const){
    const chain=compileAudioFilterChain('extrastereo',{outputSampleFormat:output});
    for(const input of ['u8','s16','s32','flt','dbl'] as const)expect(chain.negotiatedSampleFormats(input),`${input}->${output}`).toEqual(['flt']);
    // Float work feeding an integer encoder needs the scalar float-to-integer path (-cpuflags 0 on the CLI).
    expect(chain.requiresScalarRounding('s16')).toBe(output!=='flt'&&output!=='dbl');
  }
  const chain=compileAudioFilterChain('extrastereo=m=-1:c=0');
  expect(chain.maxBytesPerSample).toBe(4);expect(chain.reframes).toBe(false);expect(chain.capabilities[0]).toMatchObject({stateless:true,allocatesFrames:true,generatesOutput:false,flacInput:false,rateConversion:false});
  expect(chain.planSamples(1234n,8000,{configuredInput:true,channels:2})).toMatchObject({samples:1234n,buffers:[]});
  expect(chain.packetSections(13n,512n,8000,true,2)).toEqual([{samples:13n,span:512n}]);
  const entries=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,configuredInput:true,channels:2});
  expect(entries.map(entry=>entry.reservation)).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(/^extrastereo with sample rate conversion is not implemented$/);
});

it('refuses every layout native would remix, including a masked two-channel WAV layout',()=>{
  const chain=compileAudioFilterChain('extrastereo');
  for(const [channels,channelLayout]of [[1,'mono'],[3,'unspecified'],[2,'2 channels (FL+FC)'],[2,'downmix'],[2,'unspecified'],[4,'quad']] as const){
    expect(()=>chain.validateInputFormat({sampleRate:8000,channels,channelLayout}),channelLayout).toThrow(`extrastereo requires stereo input; ${channelLayout} would be remixed implicitly`);
  }
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).not.toThrow();
  expect(()=>chain.apply({...stereo(new Float32Array(2)),channels:1,channelLayout:'mono',samples:2},{maxFrameBytes:64})).toThrow('extrastereo requires stereo input; mono would be remixed implicitly');
});

it('matches the C transcription per sample for every m and clip setting, including zeros, opposite signs and subnormals',()=>{
  for(const mult of [-10,-1,0,1,2.5,10,0.1,-3.3])for(const clip of [false,true]){
    const data=input.slice();extraStereoSamples(data,mult,clip);
    expect(Buffer.from(data.buffer).equals(Buffer.from(reference(input,mult,clip).buffer)),`${mult}/${clip}`).toBe(true);
  }
  // -0 - -0 is +0, m=-1 makes it -0, and -0 + -0 stays -0: only the all-negative-zero pair keeps its sign.
  const zeros=Float32Array.of(0,-0,-0,-0,0,0,-0,0);extraStereoSamples(zeros,-1,false);expect(Array.from(zeros).map(value=>Object.is(value,-0))).toEqual([false,false,true,true,false,false,false,false]);
  const negated=Float32Array.of(-0,-0);extraStereoSamples(negated,0,false);expect(Object.is(negated[0],0)&&Object.is(negated[1],0)).toBe(true);
  // Opposite signs: the average is +0 and the outputs scale the difference; clipping bounds them to [-1,1].
  const wide=Float32Array.of(0.5,-0.5,0.3,-0.3);extraStereoSamples(wide,10,true);expect(Array.from(wide)).toEqual([1,-1,1,-1]);
  const kept=Float32Array.of(0.5,-0.5);extraStereoSamples(kept,10,false);expect(Array.from(kept)).toEqual([5,-5]);
  const overflow=Float32Array.of(3e38,3e38,3e38,-3e38);extraStereoSamples(overflow,2.5,true);expect(Array.from(overflow)).toEqual([-1,-1,1,-1]);
  expect(()=>extraStereoSamples(Float32Array.of(3e38,3e38),2.5,false)).toThrow(/^NaN extrastereo output without clipping is not yet supported$/);
  const infinite=Float32Array.of(3e38,-3e38);extraStereoSamples(infinite,2.5,false);expect(Array.from(infinite)).toEqual([Infinity,-Infinity]);
  for(const bad of [NaN,Infinity,-Infinity])expect(()=>extraStereoSamples(Float32Array.of(bad,0),1,true)).toThrow(/^Non-finite extrastereo input is not yet supported$/);
});

it('produces frame-split invariant owned output from integer and float frames without mutating inputs',()=>{
  const chain=compileAudioFilterChain('extrastereo=m=2.5:c=1'),frame=stereo(input),before=Buffer.from(frame.planes[0]!);
  const whole=chain.apply(frame,{maxFrameBytes:1<<20});
  expect(Buffer.from(frame.planes[0]!).equals(before)).toBe(true);expect(whole.planes[0]!.buffer).not.toBe(frame.planes[0]!.buffer);expect(whole.pts).toEqual(frame.pts);expect(whole.sampleFormat).toBe('flt');
  expect(Buffer.from(floats(whole).buffer).equals(Buffer.from(reference(input,2.5,true).buffer))).toBe(true);
  const parts:Buffer[]=[];for(const [start,end]of [[0,2],[2,1002],[1002,1003],[1003,2000]] as const){parts.push(Buffer.from(floats(chain.apply(stereo(input.slice(start*2,end*2),BigInt(start)),{maxFrameBytes:1<<20})).buffer));}
  expect(Buffer.concat(parts).equals(Buffer.from(floats(whole).buffer))).toBe(true);
  // s16 input is converted to flt first (sample/32768), exactly as native's auto-inserted converter does.
  const pcm=new Int16Array([32767,-32768,1000,-1000,0,0,-1,1]),s16:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:4,planes:[new Uint8Array(pcm.buffer.slice(0))],pts:null};
  const converted=floats(chain.apply(s16,{maxFrameBytes:64}));expect(Buffer.from(converted.buffer).equals(Buffer.from(reference(Float32Array.from(pcm,value=>value/32768),2.5,true).buffer))).toBe(true);
});

it('observes allocation limits and cancellation',async()=>{
  const chain=compileAudioFilterChain('extrastereo');
  expect(()=>chain.apply(stereo(input),{maxFrameBytes:1024})).toThrow('allocation');
  const controller=new AbortController();controller.abort(new Error('stop'));
  expect(()=>chain.apply(stereo(input),{maxFrameBytes:1<<20,signal:controller.signal})).toThrow('stop');
  async function* frames(){yield stereo(input.slice(0,8));yield stereo(input.slice(8,16));}
  const later=new AbortController(),seen:AudioFrameData[]=[];
  await expect((async()=>{for await(const frame of chain.process(frames(),{maxFrameBytes:1<<20,signal:later.signal})){seen.push(frame);later.abort(new Error('halt'));}})()).rejects.toThrow('halt');
  expect(seen).toHaveLength(1);
});
