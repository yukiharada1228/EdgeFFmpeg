import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {apulsator,apulsatorAudio,apulsatorFrequency} from '../../packages/avfilter/src/audio/apulsator.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const parse=(text:string)=>apulsator.parse(text);
const stereo=(samples:Float64Array,sampleRate=8000,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate,channels:2,channelLayout:'stereo',sampleFormat:'dbl',samples:samples.length/2,planes:[new Uint8Array(samples.buffer.slice(samples.byteOffset,samples.byteOffset+samples.byteLength))],pts:null,...extra});
const doubles=(frames:readonly AudioFrameData[])=>frames.flatMap(frame=>Array.from(new Float64Array(frame.planes[0]!.slice().buffer)));
const defaults={name:'apulsator',levelIn:1,levelOut:1,amount:1,offsetL:0,offsetR:0.5,width:1,timing:'hz',bpm:120,ms:500,hz:2};
/** Direct transcription of af_apulsator.c config_input, lfo_get_value, lfo_advance and filter_frame (SINE omitted). */
function transcription(src:Float64Array,srate:number,o:{levelIn:number;levelOut:number;mode:string;amount:number;offsetL:number;offsetR:number;width:number;timing:string;bpm:number;ms:number;hz:number}):Float64Array {
  const FFMIN=(a:number,b:number)=>a>b?b:a,FFMAX=(a:number,b:number)=>a>b?a:b,fmod=(a:number,b:number)=>a%b;
  const freq=o.timing==='bpm'?o.bpm/60:o.timing==='ms'?1/(o.ms/1000.):o.hz;
  const lfoL={phase:0,offset:o.offsetL},lfoR={phase:0,offset:o.offsetR};
  const get=(lfo:{phase:number;offset:number})=>{
    let phs=FFMIN(100,lfo.phase/FFMIN(1.99,FFMAX(0.01,o.width))+lfo.offset),val:number;
    if(phs>1)phs=fmod(phs,1.);
    switch(o.mode){
      case 'triangle':if(phs>0.75)val=(phs-0.75)*4-1;else if(phs>0.25)val=-4*phs+2;else val=phs*4;break;
      case 'square':val=phs<0.5?-1:+1;break;
      case 'sawup':val=phs*2-1;break;
      default:val=1-phs*2;
    }
    return val*o.amount;
  };
  const advance=(lfo:{phase:number},count:number)=>{lfo.phase=Math.abs(lfo.phase+count*freq/srate);if(lfo.phase>=1)lfo.phase=fmod(lfo.phase,1);};
  const dst=new Float64Array(src.length);
  for(let n=0,s=0;n<src.length/2;n++,s+=2){
    const inL=src[s]!*o.levelIn,inR=src[s+1]!*o.levelIn;let procL=inL,procR=inR;
    procL*=get(lfoL)*0.5+o.amount/2;procR*=get(lfoR)*0.5+o.amount/2;
    let outL=procL+inL*(1-o.amount),outR=procR+inR*(1-o.amount);
    outL*=o.levelOut;outR*=o.levelOut;dst[s]=outL;dst[s+1]=outR;
    advance(lfoL,1);advance(lfoR,1);
  }
  return dst;
}
it('parses named, shorthand and constant options with native ranges and refuses everything else with exact messages',()=>{
  expect(parse('apulsator=mode=triangle')).toEqual({...defaults,mode:'triangle'});
  expect(parse('apulsator=0.5:2:square:0.6:0.25:0.75:1.5:bpm:300:10:100')).toEqual({name:'apulsator',levelIn:0.5,levelOut:2,mode:'square',amount:0.6,offsetL:0.25,offsetR:0.75,width:1.5,timing:'bpm',bpm:300,ms:10,hz:100});
  expect(parse('apulsator=mode=4:timing=1:ms=2000')).toMatchObject({mode:'sawdown',timing:'ms',ms:2000});
  expect(parse('apulsator=1:1:2:timing=0:bpm=30')).toMatchObject({mode:'square',timing:'bpm',bpm:30});
  expect(parse('apulsator=mode=sawup:level_in=0.015625:level_out=64:amount=0:offset_l=1:offset_r=0:width=0:hz=0.01')).toMatchObject({mode:'sawup',levelIn:0.015625,levelOut:64,amount:0,offsetL:1,offsetR:0,width:0,hz:0.01});
  expect(parse('apulsator=mode=sine:mode=triangle').mode).toBe('triangle');
  expect(parse('apulsator=mode=square:amount=1.e0:width=.5:bpm=+1.2e2')).toMatchObject({amount:1,width:0.5,bpm:120});
  const sine='apulsator mode sine requires unimplemented libm arithmetic';
  const refusals:readonly [string,string][]=[
    ['apulsator',sine],['apulsator=mode=sine',sine],['apulsator=mode=0',sine],['apulsator=amount=0.5',sine],['apulsator=1:1:sine',sine],
    ['apulsator=mode=square:bpm=29.9','Value 29.9 for apulsator option bpm out of range [30 - 300]'],['apulsator=mode=square:bpm=301','Value 301 for apulsator option bpm out of range [30 - 300]'],
    ['apulsator=mode=square:ms=9','Value 9 for apulsator option ms out of range [10 - 2000]'],['apulsator=mode=square:ms=2001','Value 2001 for apulsator option ms out of range [10 - 2000]'],
    ['apulsator=mode=square:hz=0.009','Value 0.009 for apulsator option hz out of range [0.01 - 100]'],['apulsator=mode=square:hz=101','Value 101 for apulsator option hz out of range [0.01 - 100]'],
    ['apulsator=mode=square:width=2.01','Value 2.01 for apulsator option width out of range [0 - 2]'],['apulsator=mode=square:width=-0.1','Value -0.1 for apulsator option width out of range [0 - 2]'],
    ['apulsator=mode=square:amount=1.1','Value 1.1 for apulsator option amount out of range [0 - 1]'],['apulsator=mode=square:offset_r=-1','Value -1 for apulsator option offset_r out of range [0 - 1]'],
    ['apulsator=mode=square:level_in=0.015','Value 0.015 for apulsator option level_in out of range [0.015625 - 64]'],['apulsator=mode=square:level_out=65','Value 65 for apulsator option level_out out of range [0.015625 - 64]'],
    ['apulsator=mode=5','Value 5 for apulsator option mode out of range [0 - 4]'],['apulsator=mode=square:timing=3','Value 3 for apulsator option timing out of range [0 - 2]'],
    ['apulsator=mode=foo','Only sine, triangle, square, sawup, sawdown or an integer are implemented for apulsator option mode: foo'],
    ['apulsator=mode=square:timing=s','Only bpm, ms, hz or an integer are implemented for apulsator option timing: s'],
    ['apulsator=mode=square:ms=10.5','Only integer values are implemented for apulsator option ms: 10.5'],
    ['apulsator=mode=square:amount=1/2','Only constant decimal values are implemented for apulsator option amount: 1/2'],
    ['apulsator=mode=square:hz=nan','Only constant decimal values are implemented for apulsator option hz: nan'],
    ['apulsator=','Only constant decimal values are implemented for apulsator option level_in: '],
    ['apulsator=mode=square:1','No apulsator option name near \'1\''],['apulsator=1:1:square:1:0:0.5:1:hz:120:500:2:1','Too many apulsator positional options: 1'],
    ['apulsator=mode=square:enable=1','apulsator timeline enable is not implemented'],['apulsator=mode=square:foo=1','Unsupported apulsator option: foo'],
    ['apulsator=mode=\'square\'','Quoted or escaped apulsator options are not implemented']
  ];
  for(const [text,message]of refusals){expect(()=>parse(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('apulsatorx')).toThrow('Unsupported audio filter: apulsatorx');
  expect(apulsatorFrequency(parse('apulsator=mode=square:timing=bpm:bpm=137.5'))).toBe(137.5/60);
  expect(apulsatorFrequency(parse('apulsator=mode=square:timing=ms:ms=777'))).toBe(1/(777/1000));
  expect(apulsatorFrequency(parse('apulsator=mode=square:hz=0.01'))).toBe(0.01);
});
it('negotiates packed double for every input format, keeps counts and declares the two LFO phases as state',()=>{
  const chain=compileAudioFilterChain('apulsator=mode=triangle');
  expect(chain.nativeFormatLists).toBe(true);
  for(const format of ['u8','s16','s32','flt','dbl','s16p','fltp','dblp'] as AudioSampleFormat[])expect(chain.negotiatedSampleFormats(format),format).toEqual(['dbl']);
  for(const format of ['u8','s16','s32'] as AudioSampleFormat[]){expect(compileAudioFilterChain('apulsator=mode=triangle',{outputSampleFormat:format}).requiresScalarRounding('s16'),format).toBe(true);}
  expect(compileAudioFilterChain('apulsator=mode=triangle',{outputSampleFormat:'dbl'}).requiresScalarRounding('s16')).toBe(false);
  expect(compileAudioFilterChain('apulsator=mode=triangle',{outputSampleFormat:'flt'}).requiresScalarRounding('flt')).toBe(false);
  expect(compileAudioFilterChain('volume=0.5,apulsator=mode=square').negotiatedSampleFormats('s16')).toEqual(['flt','dbl']);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.apply(stereo(new Float64Array(2)),{maxFrameBytes:64})).toThrow('apulsator requires stream processing');
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  const plan=chain.planSamples(1000n,44100,{channels:2});expect(plan.samples).toBe(1000n);expect(plan.buffers).toEqual([]);
  expect(chain.packetSections(1000n,512n,44100,false,2)).toEqual([{samples:1000n,span:512n}]);
  expect(compileAudioFilterChain('apulsator=mode=square,asetnsamples=n=7:p=0').packetSections(1000n,512n,44100,false,2)).toEqual([{samples:1000n,span:7n}]);
  for(const [rate,format]of [[8000,'s16'],[44100,'dbl'],[48000,'u8']] as const){
    const [entry]=chain.plannedReservations({sampleRate:rate,channels:2,sampleFormat:format},{samples:100n,channels:2});
    expect(entry!.reservation).toEqual({frames:1,buffers:[],stateBytes:16n});expect(entry!.countBuffers).toEqual([]);
  }
  expect([...chain.reservations({sampleRate:48000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:16n}]);
});
it('refuses mono, multichannel and masked layouts and requires a configured format for empty input',async()=>{
  const chain=compileAudioFilterChain('apulsator=mode=square');
  for(const [channels,channelLayout]of [[1,'mono'],[3,'unspecified'],[2,'2 channels (FL+FC)'],[2,'downmix'],[2,'2 channels']] as const)expect(()=>chain.validateInputFormat({sampleRate:44100,channels,channelLayout}),channelLayout).toThrow('apulsator requires stereo input');
  expect(chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).toBeUndefined();
  const mono:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  await expect(collect(chain.process(input(mono),{maxFrameBytes:1<<16}))).rejects.toThrow('apulsator requires stereo input');
  await expect(collect(apulsatorAudio(input(mono),parse('apulsator=mode=square'),{maxFrameBytes:1<<16}))).rejects.toThrow('apulsator requires stereo input');
  await expect(collect(chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('apulsator constraints require a configured empty input format');
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}}))).toEqual([]);
  expect(()=>chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:null}})).toThrow('apulsator requires stereo input');
});
it('matches a direct C transcription across modes, timings and options, with identical output for 1/7/29/50-sample splits and untouched inputs',async()=>{
  const total=3001,source=new Float64Array(total*2);for(let i=0;i<source.length;i++)source[i]=Math.sin(i*0.37+(i&1)*1.3)*(i%11===0?1.7:0.6)+((i*7919)%13-6)/97;
  source[0]=-0;
  const texts=['apulsator=mode=triangle','apulsator=mode=square:amount=0.6:timing=bpm:bpm=137.5','apulsator=mode=sawup:timing=ms:ms=10:width=0:offset_l=1:offset_r=0','apulsator=mode=sawdown:amount=0:level_in=64:level_out=0.015625','apulsator=0.7:1.3:triangle:0.35:0.9:0.1:2:hz:30:10:100','apulsator=mode=square:width=0.01:timing=hz:hz=0.01'];
  for(const text of texts)for(const rate of [8000,44100,48000]){
    const step=parse(text),expected=transcription(source,rate,step);
    for(const split of [total,1,7,29,50]){
      const frames:AudioFrameData[]=[];for(let offset=0;offset<total;offset+=split){const samples=Math.min(split,total-offset);frames.push(stereo(source.subarray(offset*2,(offset+samples)*2),rate,{pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}}));}
      const copies=frames.map(frame=>frame.planes[0]!.slice()),output=await collect(compileAudioFilterChain(text).process(input(...frames),{maxFrameBytes:1<<16}));
      expect(frames.map(frame=>frame.planes[0])).toEqual(copies);
      expect(output.map(frame=>[frame.samples,frame.pts?.value,frame.sampleFormat])).toEqual(frames.map(frame=>[frame.samples,frame.pts?.value,'dbl']));
      expect(output.every(frame=>!frames.some(f=>f.planes[0]!.buffer===frame.planes[0]!.buffer))).toBe(true);
      const actual=new Uint8Array(Float64Array.from(doubles(output)).buffer),reference=new Uint8Array(expected.buffer);
      expect(Buffer.from(actual).equals(Buffer.from(reference)),`${text} ${rate} ${split}`).toBe(true);
    }
  }
  // At 4 Hz and 16 Hz sample rate the triangle LFO steps through quarter phases: 0, 1, 0, -1 (offset 0) scaled to gains 0.5, 1, 0.5, 0.
  const [quarter]=await collect(apulsatorAudio(input(stereo(new Float64Array(10).fill(1),16)),parse('apulsator=mode=triangle:hz=4:offset_r=0'),{maxFrameBytes:256}));
  expect(Array.from(new Float64Array(quarter!.planes[0]!.slice().buffer))).toEqual([0.5,0.5,1,1,0.5,0.5,0,0,0.5,0.5]);
},120000);
it('converts integer and planar input to packed double and enforces allocation, format, finiteness and cancellation limits',async()=>{
  const s16=new Uint8Array(8);new DataView(s16.buffer).setInt16(0,16384,true);new DataView(s16.buffer).setInt16(2,-8192,true);
  const [converted]=await collect(compileAudioFilterChain('apulsator=mode=square:amount=0').process(input({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:2,planes:[s16],pts:null}),{maxFrameBytes:4096}));
  expect(converted!.sampleFormat).toBe('dbl');expect(Array.from(new Float64Array(converted!.planes[0]!.slice().buffer))).toEqual([0.5,-0.25,0,0]);
  const fltp:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'fltp',samples:1,planes:[new Uint8Array(Float32Array.of(0.5).buffer),new Uint8Array(Float32Array.of(-1).buffer)],pts:null};
  const [planar]=await collect(compileAudioFilterChain('apulsator=mode=square:amount=0').process(input(fltp),{maxFrameBytes:4096}));
  expect(planar!.sampleFormat).toBe('dbl');expect(Array.from(new Float64Array(planar!.planes[0]!.slice().buffer))).toEqual([0.5,-1]);
  const frame=stereo(new Float64Array(64)),step=parse('apulsator=mode=triangle');
  await expect(collect(apulsatorAudio(input(frame),step,{maxFrameBytes:511}))).rejects.toThrow('exceeds allocation limit');
  expect(await collect(apulsatorAudio(input(frame),step,{maxFrameBytes:512}))).toHaveLength(1);
  await expect(collect(apulsatorAudio(input(frame),step,{maxFrameBytes:0}))).rejects.toThrow('Invalid apulsator allocation limit');
  await expect(collect(apulsatorAudio(input(frame,stereo(new Float64Array(4),16000)),step,{maxFrameBytes:4096}))).rejects.toThrow('apulsator requires a stable input format');
  await expect(collect(apulsatorAudio(input(stereo(new Float64Array(4),0)),step,{maxFrameBytes:4096}))).rejects.toThrow('Invalid apulsator sample rate');
  await expect(collect(apulsatorAudio(input(stereo(Float64Array.of(Number.NaN,0))),step,{maxFrameBytes:4096}))).rejects.toThrow('Non-finite apulsator input is not yet supported');
  await expect(collect(apulsatorAudio(input(stereo(Float64Array.of(0,Infinity))),step,{maxFrameBytes:4096}))).rejects.toThrow('Non-finite apulsator input is not yet supported');
  await expect(collect(apulsatorAudio(input(frame),step,{maxFrameBytes:4096},()=>'fltp'))).rejects.toThrow('apulsator cannot work in fltp');
  // level_in 64 overflows the largest double to infinity; a zero gain then gives inf*0, a NaN whose payload JS does not pin.
  const [huge]=await collect(apulsatorAudio(input(stereo(Float64Array.of(1.7e308,-1.7e308))),parse('apulsator=mode=square:level_in=64:offset_l=0.5:amount=0.5'),{maxFrameBytes:4096}));
  expect(Array.from(new Float64Array(huge!.planes[0]!.slice().buffer))).toEqual([Infinity,-Infinity]);
  await expect(collect(apulsatorAudio(input(stereo(Float64Array.of(1.7e308,0))),parse('apulsator=mode=square:level_in=64'),{maxFrameBytes:4096}))).rejects.toThrow('NaN apulsator output is not yet supported');
  const controller=new AbortController();controller.abort();
  await expect(collect(apulsatorAudio(input(frame),step,{maxFrameBytes:4096,signal:controller.signal}))).rejects.toThrow();
  const late=new AbortController();
  const stream=compileAudioFilterChain('apulsator=mode=square').process((async function*(){yield frame;late.abort();yield frame;})(),{maxFrameBytes:4096,signal:late.signal});
  await expect(collect(stream)).rejects.toThrow();
});
