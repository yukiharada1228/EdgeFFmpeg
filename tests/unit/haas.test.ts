import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {haas,haasCoefficients,haasDelays} from '../../packages/avfilter/src/audio/haas.js';
import type {AudioHaasStep} from '../../packages/avfilter/src/audio/haas.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>|(()=>AsyncIterable<AudioFrameData>)){if(typeof frames==='function')frames=frames();const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>haas.parse(text);
/** Direct transcription of af_haas.c config_input + filter_frame, with native's power-of-two ring and uint32 index arithmetic. */
function reference(s:AudioHaasStep,rate:number,src:Float64Array):Float64Array {
  const min=Math.trunc(rate*40*0.001);let size=1;while(size<min)size*=2;
  const buffer=new Float64Array(size),mask=size-1,delay=[Math.trunc(s.leftDelay*0.001*rate)>>>0,Math.trunc(s.rightDelay*0.001*rate)>>>0];
  const phase0=s.leftPhase?1.0:-1.0,phase1=s.rightPhase?1.0:-1.0;
  const bl=[(s.leftBalance+1)/2*s.leftGain*phase0,(s.rightBalance+1)/2*s.rightGain*phase1],br=[(1.0-(s.leftBalance+1)/2)*s.leftGain*phase0,(1.0-(s.rightBalance+1)/2)*s.rightGain*phase1];
  const dst=new Float64Array(src.length);let write=0;
  for(let n=0;n<src.length/2;n++){
    let mid=s.middleSource===0?src[2*n]!:s.middleSource===1?src[2*n+1]!:s.middleSource===2?(src[2*n]!+src[2*n+1]!)*0.5:(src[2*n]!-src[2*n+1]!)*0.5;
    mid*=s.levelIn;buffer[write]=mid;
    const s0=((write+size-delay[0]!)>>>0)&mask,s1=((write+size-delay[1]!)>>>0)&mask;
    if(s.middlePhase)mid=-mid;
    const side0=buffer[s0]!*s.sideGain,side1=buffer[s1]!*s.sideGain,sideL=side0*bl[0]!-side1*bl[1]!,sideR=side1*br[1]!-side0*br[0]!;
    dst[2*n]=(mid+sideL)*s.levelOut;dst[2*n+1]=(mid+sideR)*s.levelOut;write=(write+1)&mask;
  }
  return dst;
}
const doubles=(frames:readonly AudioFrameData[])=>Float64Array.from(frames.flatMap(frame=>Array.from(new Float64Array(frame.planes[0]!.slice().buffer))));
function frames(samples:Float64Array,sizes:readonly number[],rate:number):AudioFrameData[] {
  const result:AudioFrameData[]=[];let offset=0;
  for(const size of sizes){result.push({sampleRate:rate,channels:2,channelLayout:'stereo',sampleFormat:'dbl',samples:size,planes:[new Uint8Array(samples.slice(offset*2,(offset+size)*2).buffer)],pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}});offset+=size;}
  return result;
}
it('parses named and positional options with native defaults, names and ranges, and refuses everything else with exact messages',()=>{
  expect(step('haas')).toEqual({name:'haas',levelIn:1,levelOut:1,sideGain:1,middleSource:2,middlePhase:false,leftDelay:2.05,leftBalance:-1,leftGain:1,leftPhase:false,rightDelay:2.12,rightBalance:1,rightGain:1,rightPhase:true});
  expect(Object.isFrozen(step('haas=level_in=2'))).toBe(true);
  expect(step('haas=middle_source=left').middleSource).toBe(0);expect(step('haas=middle_source=right').middleSource).toBe(1);expect(step('haas=middle_source=side').middleSource).toBe(3);expect(step('haas=middle_source=+2').middleSource).toBe(2);
  expect(step('haas=middle_phase=YES:left_phase=On:right_phase=disabled')).toMatchObject({middlePhase:true,leftPhase:true,rightPhase:false});
  expect(step('haas=middle_phase=1:left_phase=+1:right_phase=00')).toMatchObject({middlePhase:true,leftPhase:true,rightPhase:false});
  expect(step('haas=2:0.5:1.5:side:1:7.5:0.25:3:1:13:-0.5:0.75:0')).toEqual({name:'haas',levelIn:2,levelOut:0.5,sideGain:1.5,middleSource:3,middlePhase:true,leftDelay:7.5,leftBalance:0.25,leftGain:3,leftPhase:true,rightDelay:13,rightBalance:-0.5,rightGain:0.75,rightPhase:false});
  expect(step('haas=3:side_gain=.5:level_in=4e-1')).toMatchObject({levelIn:0.4,sideGain:0.5});
  expect(step('haas=left_delay=40:right_delay=0:left_balance=-1:right_balance=1:level_in=0.015625:level_out=64')).toMatchObject({leftDelay:40,rightDelay:0,levelIn:0.015625,levelOut:64});
  const refused:[string,string][]=[
    ['haas=level_in=0','Value 0 for haas option level_in out of range [0.015625 - 64]'],['haas=left_delay=40.0001','Value 40.0001 for haas option left_delay out of range [0 - 40]'],
    ['haas=right_balance=-1.01','Value -1.01 for haas option right_balance out of range [-1 - 1]'],['haas=left_gain=1e400','Value 1e400 for haas option left_gain out of range [0.015625 - 64]'],
    ['haas=middle_source=-1','Value -1 for haas option middle_source out of range [0 - 3]'],['haas=middle_source=Mid','Only left, right, mid, side or an integer are implemented for haas option middle_source'],
    ['haas=middle_phase=auto','Unable to parse haas option middle_phase value auto as boolean'],['haas=right_phase=-1','Unable to parse haas option right_phase value -1 as boolean'],['haas=left_phase=0.5','Only 0, 1 and boolean names are implemented for haas option left_phase'],
    ['haas=level_out=1+1','Only constant decimal values are implemented for haas option level_out'],['haas=side_gain=1k','Only constant decimal values are implemented for haas option side_gain'],['haas=level_in=','Only constant decimal values are implemented for haas option level_in'],
    ['haas=bar=1','Unsupported haas option: bar'],['haas=enable=1','Unsupported haas option: enable'],['haas=level_in=1:2','No haas option name near 2'],[`haas=${Array(14).fill('1').join(':')}`,'Too many haas option values near 1'],
    ["haas=level_in='1'",'Quoted or escaped haas options are not implemented'],['haas=level_in=1\\:2','Quoted or escaped haas options are not implemented'],['haasx','Unsupported audio filter: haasx']];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('haas=level_in=0')).toThrow('Value 0 for haas option level_in out of range [0.015625 - 64]');
});
it('truncates delays as config_input does, reduces them modulo native\'s power-of-two ring and derives balance coefficients',()=>{
  const delays=(text:string,rate:number)=>haasDelays(step(text),rate);
  // 2.05 ms and 2.12 ms truncate (uint32_t) to 16/16 at 8000 Hz, 90/93 at 44100 Hz and 98/101 at 48000 Hz.
  expect(delays('haas',8000)).toEqual({delays:[16,16],ring:17});expect(delays('haas',44100)).toEqual({delays:[90,93],ring:94});expect(delays('haas',48000)).toEqual({delays:[98,101],ring:102});
  expect(delays('haas=left_delay=40:right_delay=0',8000)).toEqual({delays:[320,0],ring:321});expect(delays('haas=left_delay=40:right_delay=40',48000)).toEqual({delays:[1920,1920],ring:1921});
  expect(delays('haas=left_delay=0:right_delay=0',44100)).toEqual({delays:[0,0],ring:1});
  // 0.1 ms at 44100 Hz is 4.41 samples; 0.0226757 ms is 0.99999837 and truncates to 0.
  expect(delays('haas=left_delay=0.1:right_delay=0.0226757',44100).delays).toEqual([4,0]);
  // At 6400/12800/25600 Hz the 40 ms delay equals native's ring size, so the read index is the write index.
  expect(delays('haas=left_delay=40:right_delay=39.99',6400)).toEqual({delays:[0,255],ring:256});expect(delays('haas=left_delay=40:right_delay=1',25600)).toEqual({delays:[0,25],ring:26});
  expect(delays('haas=left_delay=40',1)).toEqual({delays:[0,0],ring:1});
  for(const rate of [0,-1,8000.5,2147483648])expect(()=>delays('haas',rate)).toThrow('Invalid haas sample rate');
  expect(haasCoefficients(step('haas'))).toEqual({left:[-0,1],right:[-1,0]});
  expect(haasCoefficients(step('haas=left_balance=0.5:right_balance=-0.5:left_gain=2:right_gain=4:left_phase=1:right_phase=0'))).toEqual({left:[1.5,-1],right:[0.5,-3]});
  expect(haasCoefficients(step('haas=left_balance=0:right_balance=0:left_phase=1'))).toEqual({left:[0.5,0.5],right:[0.5,0.5]});
});
it('pins dbl for every input format, refuses non-stereo layouts and plans an unchanged count with an exact ring reservation',()=>{
  const chain=compileAudioFilterChain('haas=left_delay=40:right_delay=1');
  expect(chain.nativeFormatLists).toBe(true);
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as AudioSampleFormat[])expect(chain.negotiatedSampleFormats(format),format).toEqual(['dbl']);
  expect(compileAudioFilterChain('haas',{outputSampleFormat:'s16'}).requiresScalarRounding('s16')).toBe(true);
  expect(compileAudioFilterChain('haas,aformat=fltp').negotiatedSampleFormats('s16')).toEqual(['dbl','fltp']);
  expect(chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).toBeUndefined();
  for(const format of [{sampleRate:44100,channels:1,channelLayout:'mono'},{sampleRate:44100,channels:3,channelLayout:'unspecified'},{sampleRate:44100,channels:2,channelLayout:'2 channels (FL+FC)'},{sampleRate:44100,channels:2,channelLayout:'downmix'},{sampleRate:44100,channels:2,channelLayout:'2 channels'}])
    expect(()=>chain.validateInputFormat(format),format.channelLayout).toThrow('haas requires a stereo layout');
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  expect(chain.planSamples(1234n,8000,{channels:2}).samples).toBe(1234n);expect(chain.outputSamples(0n,8000,{channels:2})).toBe(0n);
  expect(chain.packetSections(5000n,1024n,8000,false,2)).toEqual([{samples:5000n,span:1024n}]);
  const [entry]=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:5000n,channels:2});
  expect(entry!.reservation).toEqual({frames:1,buffers:[],stateBytes:321n*8n});expect(entry!.countBuffers).toEqual([]);
  expect([...compileAudioFilterChain('haas').reservations({sampleRate:48000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:102n*8n}]);
  expect(()=>chain.apply(frames(new Float64Array(2),[1],8000)[0]!,{maxFrameBytes:64})).toThrow('haas requires stream processing');
});
it('matches a transcription of the C loop for every option family, independent of frame splits, without touching its input',async()=>{
  const total=3000,source=Float64Array.from({length:total*2},(_,i)=>i===0?-0:Math.sin(i*0.37)*((i%17)/16)*1.5);
  const tokens=['haas','haas=middle_source=left','haas=middle_source=right','haas=middle_source=side:middle_phase=1','haas=left_delay=40:right_delay=0','haas=left_delay=0:right_delay=0','haas=left_phase=1:right_phase=0:left_balance=0.3:right_balance=-0.6:left_gain=5:right_gain=0.02','haas=level_in=0.5:level_out=3:side_gain=7',...haas.examples];
  let compared=0;
  for(const rate of [100,6400,8000,44100,48000])for(const token of tokens){
    const expected=reference(step(token),rate,source),chain=compileAudioFilterChain(token);
    for(const sizes of [[total],[1,1,7,991,2000],[300,300,300,300,300,300,300,300,300,300],Array(30).fill(100)]){
      const inputs=frames(source,sizes,rate),copies=inputs.map(frame=>frame.planes[0]!.slice());
      const output=await collect(chain.process(input(...inputs),{maxFrameBytes:1<<16}));
      expect(output.map(frame=>frame.samples),`${token} ${rate}`).toEqual(sizes);
      expect(output.map(frame=>frame.pts),`${token} pts`).toEqual(inputs.map(frame=>frame.pts));
      expect(Object.is(doubles(output)[0],expected[0])&&doubles(output).every((value,index)=>Object.is(value,expected[index])),`${token} ${rate} ${sizes.length}`).toBe(true);
      expect(inputs.map(frame=>frame.planes[0]),`${token} input untouched`).toEqual(copies);
      for(const [index,frame]of output.entries())expect(frame.planes[0]!.buffer,`${token} owned`).not.toBe(inputs[index]!.planes[0]!.buffer);
      compared++;
    }
  }
  expect(compared).toBe(5*(8+haas.examples.length)*4);
  // Non-dbl input is converted to the negotiated dbl first: s16 into the chain equals the reference on s16/32768.
  const s16=new Int16Array(400).map((_,i)=>(i*997)%65536-32768),frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:200,planes:[new Uint8Array(s16.buffer)],pts:null};
  const [converted]=await collect(compileAudioFilterChain('haas=left_delay=1').process(input(frame),{maxFrameBytes:1<<16}));
  expect(converted!.sampleFormat).toBe('dbl');expect(doubles([converted!])).toEqual(reference(step('haas=left_delay=1'),8000,Float64Array.from(s16,value=>value/32768)));
});
it('refuses non-stereo frames, rate changes, oversized rings and frames, emits nothing for empty input and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('haas=left_delay=40'),one=(rate:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({...frames(new Float64Array(8),[4],rate)[0]!,...extra});
  // A configured empty input passes the stereo constraint and yields nothing, as native emits no frame; mono or unconfigured empty input is refused.
  const empty={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16' as const,pts:null};
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:empty}))).toEqual([]);
  await expect(collect(()=>chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{...empty,channels:1,channelLayout:'mono'}}))).rejects.toThrow('haas requires a stereo layout');
  await expect(collect(()=>chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('haas constraints require a configured empty input format');
  await expect(collect(()=>chain.process(input(one(8000,{channels:1,channelLayout:'mono',planes:[new Uint8Array(32)]})),{maxFrameBytes:1<<16}))).rejects.toThrow('haas requires a stereo layout');
  await expect(collect(()=>chain.process(input(one(8000,{channelLayout:'2 channels (FL+FC)'})),{maxFrameBytes:1<<16}))).rejects.toThrow('haas requires a stereo layout');
  await expect(collect(()=>chain.process(input(one(8000),one(16000)),{maxFrameBytes:1<<16}))).rejects.toThrow('haas sample rate changed between frames');
  // 40 ms at 48000 Hz needs a 1921-double ring (15368 bytes).
  await expect(collect(()=>chain.process(input(one(48000)),{maxFrameBytes:15367}))).rejects.toThrow('haas delay buffer exceeds allocation limit');
  expect((await collect(chain.process(input(one(48000)),{maxFrameBytes:15368}))).length).toBe(1);
  await expect(collect(()=>compileAudioFilterChain('haas').process(input(...frames(new Float64Array(400),[200],8000)),{maxFrameBytes:3199}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  const controller=new AbortController();controller.abort();
  await expect(collect(()=>chain.process(input(one(8000)),{maxFrameBytes:1<<16,signal:controller.signal}))).rejects.toThrow();
  const late=new AbortController();let yielded=0;
  await expect((async()=>{for await(const frame of chain.process(input(one(8000),one(8000)),{maxFrameBytes:1<<16,signal:late.signal})){yielded+=frame.samples>0?1:0;late.abort();}})()).rejects.toThrow();
  expect(yielded).toBe(1);
});
