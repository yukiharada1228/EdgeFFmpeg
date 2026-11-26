import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {alimiter,audioLimiterSizes,audioLimiterStateBytes} from '../../packages/avfilter/src/audio/alimiter.js';
import type {AudioLimiterStep} from '../../packages/avfilter/src/audio/alimiter.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>|(()=>AsyncIterable<AudioFrameData>)){if(typeof frames==='function')frames=frames();const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>alimiter.parse(text);
const FFMAX=(a:number,b:number)=>a>b?a:b,FFMIN=(a:number,b:number)=>a>b?b:a;
/** Direct transcription of af_alimiter.c init + config_input + filter_frame (auto_release = 0, latency = 0) on interleaved doubles. */
function reference(s:AudioLimiterStep,rate:number,channels:number,src:Float64Array):Float64Array {
  const attack=s.attack/1000.,release=s.release/1000.,limit=s.limit,level=s.level?1/limit:1;
  const obuffer=Math.trunc(rate*channels*100/1000.+channels),buffer=new Float64Array(obuffer),nextdelta=new Float64Array(obuffer),nextpos=new Int32Array(obuffer).fill(-1);
  let bufferSize=Math.trunc(rate*attack*channels);bufferSize-=bufferSize%channels;
  let pos=0,att=1.,delta=0,nextiter=0,nextlen=0;const dst=new Float64Array(src.length);
  for(let n=0;n<src.length/channels;n++){
    const o=n*channels;let peak=0;
    for(let c=0;c<channels;c++){const sample=src[o+c]!*s.levelIn;buffer[pos+c]=sample;peak=FFMAX(peak,Math.abs(sample));}
    if(peak>limit){
      const patt=FFMIN(limit/peak,1.),rdelta=(1.0-patt)/(rate*release),d=(limit/peak-att)/bufferSize*channels;let found=0,i:number;
      if(d<delta){delta=d;nextpos[0]=pos;nextpos[1]=-1;nextdelta[0]=rdelta;nextlen=1;nextiter=0;}
      else{
        for(i=nextiter;i<nextiter+nextlen;i++){
          const j=i%bufferSize;let ppeak=0;
          if(nextpos[j]!>=0)for(let c=0;c<channels;c++)ppeak=FFMAX(ppeak,Math.abs(buffer[nextpos[j]!+c]!));
          const pdelta=(limit/peak-limit/ppeak)/Math.floor(((bufferSize-nextpos[j]!+pos)%bufferSize)/channels);
          if(pdelta<nextdelta[j]!){nextdelta[j]=pdelta;found=1;break;}
        }
        if(found){nextlen=i-nextiter+1;nextpos[(nextiter+nextlen)%bufferSize]=pos;nextdelta[(nextiter+nextlen)%bufferSize]=rdelta;nextpos[(nextiter+nextlen+1)%bufferSize]=-1;nextlen++;}
      }
    }
    const b=(pos+channels)%bufferSize;peak=0;
    for(let c=0;c<channels;c++)peak=FFMAX(peak,Math.abs(buffer[b+c]!));
    att+=delta;
    for(let c=0;c<channels;c++)dst[o+c]=buffer[b+c]!*att;
    if((pos+channels)%bufferSize===nextpos[nextiter]){delta=nextdelta[nextiter]!;att=limit/peak;nextlen-=1;nextpos[nextiter]=-1;nextiter=(nextiter+1)%bufferSize;}
    if(att>1.){att=1.;delta=0.;nextiter=0;nextlen=0;nextpos[0]=-1;}
    if(att<=0.){att=0.0000000000001;delta=(1.0-att)/(rate*release);}
    if(att!==1.&&(1.-att)<0.0000000000001)att=1.;
    if(delta!==0.&&Math.abs(delta)<0.00000000000001)delta=0.;
    for(let c=0;c<channels;c++)dst[o+c]=FFMIN(FFMAX(dst[o+c]!,-limit),limit)*level*s.levelOut;
    pos=(pos+channels)%bufferSize;
  }
  return dst;
}
const doubles=(frames:readonly AudioFrameData[])=>Float64Array.from(frames.flatMap(frame=>Array.from(new Float64Array(frame.planes[0]!.slice().buffer))));
function frames(samples:Float64Array,sizes:readonly number[],rate:number,channels:number):AudioFrameData[] {
  const result:AudioFrameData[]=[],layout=channels===1?'mono':channels===2?'stereo':'unspecified';let offset=0;
  for(const size of sizes){result.push({sampleRate:rate,channels,channelLayout:layout,sampleFormat:'dbl',samples:size,planes:[new Uint8Array(samples.slice(offset*channels,(offset+size)*channels).buffer)],pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}});offset+=size;}
  return result;
}
/** Quiet passages, noise above the limit, isolated bursts and alternating rising peaks. */
function signal(count:number,channels:number):Float64Array {
  return Float64Array.from({length:count*channels},(_,index)=>{
    const i=Math.floor(index/channels),c=index%channels,segment=Math.floor(i/400)%4,k=i%400,noise=Math.sin(i*12.9898+c*78.233)*43758.5453;
    if(index===0)return -0;
    if(segment===0)return Math.sin(i*0.05+c)*0.04;
    if(segment===1)return (noise-Math.floor(noise))*2.8-1.4;
    if(segment===2)return k%100===c?(k%200?0.95:-1.6):0;
    return (k%2?-1:1)*Math.min(1.6,0.05+k*0.006)*(1+c*0.1);
  });
}
it('parses named and positional options with native defaults, names and ranges, and refuses everything else with exact messages',()=>{
  expect(step('alimiter')).toEqual({name:'alimiter',levelIn:1,levelOut:1,limit:1,attack:5,release:50,ascLevel:0.5,level:true});
  expect(Object.isFrozen(step('alimiter=limit=0.5'))).toBe(true);
  expect(step('alimiter=2:0.5:0.0625:80:8000:0:0.25:1:0')).toEqual({name:'alimiter',levelIn:2,levelOut:0.5,limit:0.0625,attack:80,release:8000,ascLevel:0.25,level:true});
  expect(step('alimiter=1.5:limit=.3:level=off:asc=no:latency=false:asc_level=-0')).toEqual({name:'alimiter',levelIn:1.5,levelOut:1,limit:0.3,attack:5,release:50,ascLevel:0,level:false});
  expect(step('alimiter=level_in=0.015625:level_out=64:limit=1:attack=0.1:release=1:level=0:asc=0:latency=0')).toMatchObject({levelIn:0.015625,levelOut:64,limit:1,attack:0.1,release:1,level:false});
  expect(step('alimiter=level=YES:attack=4e1:release=+8e3')).toMatchObject({level:true,attack:40,release:8000});
  expect(Object.keys(step('alimiter=asc=0:latency=0'))).toEqual(['name','levelIn','levelOut','limit','attack','release','ascLevel','level']);
  const refused:[string,string][]=[
    ['alimiter=asc=1','alimiter asc requires unimplemented libm arithmetic'],['alimiter=asc=on:asc_level=0','alimiter asc requires unimplemented libm arithmetic'],['alimiter=1:1:1:5:50:1','alimiter asc requires unimplemented libm arithmetic'],
    ['alimiter=latency=1','alimiter latency compensation drops leading samples, which the audio chain cannot express'],['alimiter=1:1:1:5:50:0:0.5:1:true','alimiter latency compensation drops leading samples, which the audio chain cannot express'],
    ['alimiter=level_in=0.0156','Value 0.0156 for alimiter option level_in out of range [0.015625 - 64]'],['alimiter=level_out=64.1','Value 64.1 for alimiter option level_out out of range [0.015625 - 64]'],
    ['alimiter=limit=0.0624','Value 0.0624 for alimiter option limit out of range [0.0625 - 1]'],['alimiter=attack=80.01','Value 80.01 for alimiter option attack out of range [0.1 - 80]'],
    ['alimiter=release=0.99','Value 0.99 for alimiter option release out of range [1 - 8000]'],['alimiter=asc_level=-0.1','Value -0.1 for alimiter option asc_level out of range [0 - 1]'],
    ['alimiter=limit=1e400','Value 1e400 for alimiter option limit out of range [0.0625 - 1]'],['alimiter=level=2','Unable to parse alimiter option level value 2 as boolean'],
    ['alimiter=asc=auto','Unable to parse alimiter option asc value auto as boolean'],['alimiter=latency=0.5','Only 0, 1 and boolean names are implemented for alimiter option latency'],
    ['alimiter=limit=1/2','Only constant decimal values are implemented for alimiter option limit'],['alimiter=attack=5ms','Only constant decimal values are implemented for alimiter option attack'],['alimiter=limit=','Only constant decimal values are implemented for alimiter option limit'],
    ['alimiter=limit=nan','Only constant decimal values are implemented for alimiter option limit'],
    ['alimiter=enable=1','alimiter timeline enable is not implemented'],['alimiter=limit=0.5:enable=gte(t\\,1)','Quoted or escaped alimiter options are not implemented'],["alimiter=limit='0.5'",'Quoted or escaped alimiter options are not implemented'],
    ['alimiter=foo=1','Unsupported alimiter option: foo'],['alimiter=limit=0.5:2','No alimiter option name near 2'],['alimiter=1:1:1:5:50:0:0.5:1:0:1','Too many alimiter option values near 1'],['alimiterx','Unsupported audio filter: alimiterx']];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('alimiter=asc=1')).toThrow('alimiter asc requires unimplemented libm arithmetic');
});
it('sizes the lookahead as config_input does and refuses attacks too small for the rate and channel count',()=>{
  const sizes=(text:string,rate:number,channels:number)=>audioLimiterSizes(step(text),rate,channels);
  // 5 ms: 40 samples at 8000 Hz, 220.5 -> 220 at 44100 Hz mono, 441 -> 440 for stereo (rounded to a multiple of channels).
  expect(sizes('alimiter',8000,1)).toEqual({buffer:40,allocated:801});expect(sizes('alimiter',44100,1)).toEqual({buffer:220,allocated:4411});
  expect(sizes('alimiter',44100,2)).toEqual({buffer:440,allocated:8822});expect(sizes('alimiter',48000,3)).toEqual({buffer:720,allocated:14403});
  expect(sizes('alimiter=attack=80',48000,3)).toEqual({buffer:11520,allocated:14403});expect(sizes('alimiter=attack=0.2',8000,2)).toEqual({buffer:2,allocated:1602});
  // 0.1 ms at 44100 Hz: 4.41 -> 4 mono, 8.82 -> 8 stereo, 13.23 -> 13 -> 12 for three channels.
  expect(sizes('alimiter=attack=0.1',44100,1).buffer).toBe(4);expect(sizes('alimiter=attack=0.1',44100,2).buffer).toBe(8);expect(sizes('alimiter=attack=0.1',44100,3).buffer).toBe(12);
  for(const [text,rate,channels]of [['alimiter=attack=0.1',8000,1],['alimiter=attack=0.1',8000,2],['alimiter=attack=0.1',8000,3],['alimiter=attack=0.12',8000,1],['alimiter',100,1]] as const)
    expect(()=>sizes(text,rate,channels),`${text} ${rate} ${channels}`).toThrow('alimiter attack is too small');
  expect(()=>sizes('alimiter',21474837,1)).toThrow('alimiter sample rate and channel count overflow native buffer arithmetic');
  for(const [rate,channels]of [[0,1],[8000.5,1],[8000,0],[2147483648,1]] as const)expect(()=>sizes('alimiter',rate,channels)).toThrow('Invalid alimiter input format');
  expect(audioLimiterStateBytes(step('alimiter'),8000,1)).toBe(801n*20n);
  const chain=compileAudioFilterChain('alimiter=attack=0.1');
  expect(chain.validateInputFormat({sampleRate:44100,channels:1,channelLayout:'mono'})).toBeUndefined();
  for(const channels of [1,2,3])expect(()=>chain.validateInputFormat({sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'unspecified'})).toThrow('alimiter attack is too small');
});
it('pins dbl for every input format and plans an unchanged count with an exact state reservation',()=>{
  const chain=compileAudioFilterChain('alimiter=limit=0.5');
  expect(chain.nativeFormatLists).toBe(true);
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as AudioSampleFormat[])expect(chain.negotiatedSampleFormats(format),format).toEqual(['dbl']);
  for(const format of ['u8','s16','s32'] as AudioSampleFormat[])expect(compileAudioFilterChain('alimiter',{outputSampleFormat:format}).requiresScalarRounding(format),format).toBe(true);
  expect(compileAudioFilterChain('alimiter',{outputSampleFormat:'dbl'}).requiresScalarRounding('dbl')).toBe(false);
  expect(compileAudioFilterChain('alimiter,aformat=fltp').negotiatedSampleFormats('s16')).toEqual(['dbl','fltp']);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  expect(chain.planSamples(1234n,8000,{channels:2}).samples).toBe(1234n);expect(chain.outputSamples(0n,8000,{channels:2})).toBe(0n);
  expect(chain.packetSections(5000n,1024n,8000,false,2)).toEqual([{samples:5000n,span:1024n}]);
  const [entry]=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:5000n,channels:2});
  expect(entry!.reservation).toEqual({frames:1,buffers:[],stateBytes:1602n*20n});expect(entry!.countBuffers).toEqual([]);
  expect([...compileAudioFilterChain('alimiter').reservations({sampleRate:48000,channels:3,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:14403n*20n}]);
  expect(()=>chain.apply(frames(new Float64Array(2),[1],8000,2)[0]!,{maxFrameBytes:64})).toThrow('alimiter requires stream processing');
});
it('matches a transcription of the C loop for every option family on 1-3 channels, independent of 1/7/29/50-sample splits, without touching its input',async()=>{
  const total=1800;let compared=0;
  const tokens=['alimiter','alimiter=limit=0.0625','alimiter=limit=0.3','alimiter=limit=0.3:level=0','alimiter=attack=0.2:limit=0.5','alimiter=attack=80:release=8000:limit=0.2','alimiter=release=1:limit=0.0625:attack=2','alimiter=level_in=4:level_out=0.5:limit=0.4','alimiter=asc_level=1:limit=0.25',...alimiter.examples];
  for(const channels of [1,2,3]){
    const source=signal(total,channels);
    for(const rate of [8000,44100])for(const token of tokens){
      const expected=reference(step(token),rate,channels,source),chain=compileAudioFilterChain(token);
      expect(expected.some((value,index)=>value!==source[index]),token).toBe(true);
      for(const size of [total,1,7,29,50]){
        const sizes=Array.from({length:Math.ceil(total/size)},(_,index)=>Math.min(size,total-index*size)),inputs=frames(source,sizes,rate,channels),copies=inputs.map(frame=>frame.planes[0]!.slice());
        const output=await collect(chain.process(input(...inputs),{maxFrameBytes:1<<20}));
        expect(output.map(frame=>frame.samples),`${token} ${rate}`).toEqual(sizes);
        expect(output.map(frame=>frame.pts),`${token} pts`).toEqual(inputs.map(frame=>frame.pts));
        const actual=doubles(output);
        expect(actual.length===expected.length&&actual.every((value,index)=>Object.is(value,expected[index])),`${token} ${rate} ${channels} ${size}`).toBe(true);
        expect(inputs.map(frame=>frame.planes[0]),`${token} input untouched`).toEqual(copies);
        for(const [index,frame]of output.entries())expect(frame.planes[0]!.buffer,`${token} owned`).not.toBe(inputs[index]!.planes[0]!.buffer);
        compared++;
      }
    }
  }
  expect(compared).toBe(3*2*(9+alimiter.examples.length)*5);
  // Non-dbl input is converted to the negotiated dbl first: s16 into the chain equals the reference on s16/32768.
  const s16=new Int16Array(800).map((_,i)=>(i*997)%65536-32768),frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:400,planes:[new Uint8Array(s16.buffer)],pts:null};
  const [converted]=await collect(compileAudioFilterChain('alimiter=limit=0.2').process(input(frame),{maxFrameBytes:1<<16}));
  expect(converted!.sampleFormat).toBe('dbl');expect(doubles([converted!])).toEqual(reference(step('alimiter=limit=0.2'),8000,2,Float64Array.from(s16,value=>value/32768)));
});
it('refuses unstable formats, oversized state and frames, emits nothing for empty input and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('alimiter'),one=(rate:number,channels=1):AudioFrameData=>frames(new Float64Array(4*channels).fill(0.5),[4],rate,channels)[0]!;
  const empty={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16' as const,pts:null};
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:empty}))).toEqual([]);
  await expect(collect(()=>compileAudioFilterChain('alimiter=attack=0.1').process(input(),{maxFrameBytes:1<<16,inputFormat:empty}))).rejects.toThrow('alimiter attack is too small');
  await expect(collect(()=>chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('alimiter constraints require a configured empty input format');
  await expect(collect(()=>compileAudioFilterChain('alimiter=attack=0.1').process(input(one(8000)),{maxFrameBytes:1<<16}))).rejects.toThrow('alimiter attack is too small');
  await expect(collect(()=>chain.process(input(one(8000),one(16000)),{maxFrameBytes:1<<16}))).rejects.toThrow('alimiter requires a stable input format');
  await expect(collect(()=>chain.process(input(one(8000),one(8000,2)),{maxFrameBytes:1<<16}))).rejects.toThrow('alimiter requires a stable input format');
  // 48000 Hz stereo: obuffer_size 9602 entries, 192040 state bytes.
  await expect(collect(()=>chain.process(input(one(48000,2)),{maxFrameBytes:192039}))).rejects.toThrow('alimiter lookahead buffer exceeds allocation limit');
  expect((await collect(chain.process(input(one(48000,2)),{maxFrameBytes:192040}))).length).toBe(1);
  await expect(collect(()=>chain.process(input(...frames(new Float64Array(400),[400],8000,1)),{maxFrameBytes:16019}))).rejects.toThrow('alimiter lookahead buffer exceeds allocation limit');
  await expect(collect(()=>chain.process(input(...frames(new Float64Array(4000),[4000],8000,1)),{maxFrameBytes:31999}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  const controller=new AbortController();controller.abort();
  await expect(collect(()=>chain.process(input(one(8000)),{maxFrameBytes:1<<16,signal:controller.signal}))).rejects.toThrow();
  const late=new AbortController();let yielded=0;
  await expect((async()=>{for await(const frame of chain.process(input(one(8000),one(8000)),{maxFrameBytes:1<<16,signal:late.signal})){yielded+=frame.samples>0?1:0;late.abort();}})()).rejects.toThrow();
  expect(yielded).toBe(1);
});
