import {expect,it} from 'vitest';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {flanger,flangerLfo,flangerPlan,flangerStateBytes,parseFlanger} from '../../packages/avfilter/src/audio/flanger.js';
import type {AudioFlangerStep} from '../../packages/avfilter/src/audio/flanger.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const refuse=(text:string,message:string)=>{expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`));};
const defaults={name:'flanger',delay:0,depth:2,regen:0,width:71,speed:0.5,phase:25,interp:'linear'};
it('parses triangular shapes, positional and named options, the last value and native ranges',()=>{
  expect(parseFlanger('flanger=shape=t')).toEqual(defaults);expect(parseFlanger('flanger=shape=triangular')).toEqual(defaults);
  expect(parseFlanger('flanger=30:0:-95:0:0.1:t:0:linear')).toEqual({name:'flanger',delay:30,depth:0,regen:-95,width:0,speed:0.1,phase:0,interp:'linear'});
  expect(parseFlanger('flanger=delay=5:depth=10:regen=40:width=100:speed=10:shape=triangular:phase=100:interp=quadratic')).toEqual({name:'flanger',delay:5,depth:10,regen:40,width:100,speed:10,phase:100,interp:'quadratic'});
  // A named option after positional ones; the last value wins, including a sinusoidal shape overridden by a triangular one.
  expect(parseFlanger('flanger=1.5:3:shape=s:regen=+9.5e0:shape=t:interp=linear:interp=quadratic:delay=2')).toEqual({...defaults,delay:2,depth:3,regen:9.5,interp:'quadratic'});
  expect(Object.isFrozen(parseFlanger('flanger=shape=t'))).toBe(true);expect(compileAudioFilterChain('flanger=shape=t').steps[0]).toEqual(defaults);
  expect(Object.is(parseFlanger('flanger=delay=-0:shape=t').delay,-0)).toBe(true);
});
it('refuses the sinusoidal default, native range errors, enable and unimplemented forms with exact messages',()=>{
  for(const text of ['flanger','flanger=shape=s','flanger=shape=sinusoidal','flanger=delay=5','flanger=shape=t:shape=s'])refuse(text,'flanger shape sinusoidal requires unimplemented libm arithmetic');
  refuse('flanger=delay=31:shape=t','flanger delay 31 is out of range [0 - 30]');refuse('flanger=delay=-1:shape=t','flanger delay -1 is out of range [0 - 30]');
  refuse('flanger=depth=10.5:shape=t','flanger depth 10.5 is out of range [0 - 10]');refuse('flanger=regen=-96:shape=t','flanger regen -96 is out of range [-95 - 95]');
  refuse('flanger=width=101:shape=t','flanger width 101 is out of range [0 - 100]');refuse('flanger=speed=0.09:shape=t','flanger speed 0.09 is out of range [0.1 - 10]');
  refuse('flanger=speed=11:shape=t','flanger speed 11 is out of range [0.1 - 10]');refuse('flanger=phase=100.5:shape=t','flanger phase 100.5 is out of range [0 - 100]');
  refuse('flanger=shape=t:enable=gte(t\\,1)','flanger timeline enable is not implemented');refuse('flanger=enable=1:shape=t','flanger timeline enable is not implemented');
  refuse('flanger=shape=t:foo=1','Unsupported flanger option: foo');refuse('flanger=shape=1','Unsupported flanger shape value: 1');refuse('flanger=shape=t:interp=1','Unsupported flanger interp value: 1');
  refuse('flanger=shape=t:interp=cubic','Unsupported flanger interp value: cubic');refuse('flanger=shape=t:5','No flanger option name near \'5\'');
  refuse('flanger=0:2:0:71:0.5:t:25:linear:9','Too many flanger positional options: 9');refuse('flangerx','Unsupported audio filter: flangerx');
  for(const value of ['1/2','0x1','inf','nan','PI','1k','max',''])refuse(`flanger=shape=t:delay=${value}`,`Only constant numeric flanger delay values are implemented: ${value}`);
});
it('transcribes init and config_input scaling, the triangular LFO table and the LFO-length constraint',()=>{
  const plan=flangerPlan(parseFlanger('flanger=delay=5:depth=10:regen=40:width=100:speed=10:shape=t:phase=100'),44100);
  let gain=100/100;const inGain=1/(1+gain);gain/=1+gain;gain*=1-Math.abs(40/100);
  expect(plan).toEqual({feedbackGain:0.4,delayGain:gain,inGain,channelPhase:1,delayMin:0.005,delayDepth:0.01,maxSamples:Math.trunc((0.005+0.01)*44100+2.5),lfoLength:4410});
  expect(flangerPlan(parseFlanger('flanger=shape=t'),8000)).toMatchObject({maxSamples:18,lfoLength:16000});expect(flangerPlan(parseFlanger('flanger=delay=0:depth=0:shape=t'),8000)).toMatchObject({maxSamples:2,lfoLength:16000});
  expect(flangerPlan(parseFlanger('flanger=speed=0.1:shape=t'),44100).lfoLength).toBe(441000);expect(flangerPlan(parseFlanger('flanger=speed=3:shape=t'),8000).lfoLength).toBe(2666);
  // rint(delay_min*sample_rate) rounds half to even: 0.0625 ms at 8000 Hz is 0.5 samples (min 0, max 1); 0.1875 ms is 1.5 samples (min 2, max 2).
  const half=flangerLfo(flangerPlan(parseFlanger('flanger=delay=0.0625:depth=0:shape=t'),8000),8000);expect([Math.min(...half),Math.max(...half)]).toEqual([0,1]);
  expect(flangerLfo(flangerPlan(parseFlanger('flanger=delay=0.1875:depth=0:shape=t'),8000),8000).every(value=>value===2)).toBe(true);
  // The table starts at phase 3*pi/2: the minimum delay, rising to max_samples-2 at a half period.
  const table=flangerLfo(flangerPlan(parseFlanger('flanger=delay=1:depth=2:speed=10:shape=t'),8000),8000);
  expect([table.length,table[0],table[200],table[400],Math.min(...table),Math.max(...table)]).toEqual([800,8,16,24,8,24]);
  for(const [text,rate]of [['flanger=speed=10:shape=t',9],['flanger=speed=10:shape=t',1]] as const)expect(()=>flangerPlan(parseFlanger(text),rate)).toThrow(/^flanger speed 10 leaves no LFO samples at \d Hz$/);
  expect(()=>flangerPlan(parseFlanger('flanger=speed=0.1:shape=t'),2147483647)).toThrow(/^flanger LFO length exceeds the implemented range$/);
  for(const rate of [0,8000.5,2147483648])expect(()=>flangerPlan(parseFlanger('flanger=shape=t'),rate)).toThrow(/^flanger requires a valid sample rate$/);
  const chain=compileAudioFilterChain('flanger=speed=10:shape=t');
  expect(()=>chain.validateInputFormat({sampleRate:9,channels:1,channelLayout:'mono'})).toThrow(/^flanger speed 10 leaves no LFO samples at 9 Hz$/);
  expect(()=>chain.validateInputFormat({sampleRate:10,channels:2,channelLayout:'stereo'})).not.toThrow();
  expect(()=>compileAudioFilterChain('flanger=speed=0.1:shape=t').validateInputFormat({sampleRate:100000000,channels:3,channelLayout:'unspecified'})).toThrow(/^flanger channel phase exceeds int range$/);
});
it('negotiates pinned dblp from every input format and keeps counts, packets and reservations',()=>{
  for(const hint of ['s16','dbl'] as const){
    const chain=compileAudioFilterChain('flanger=shape=t',{outputSampleFormat:hint});
    for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const)expect(chain.negotiatedSampleFormats(format),`${format} ${hint}`).toEqual(['dblp']);
    expect((['u8','s16','s32','flt','dbl'] as const).map(format=>chain.requiresScalarRounding(format))).toEqual(hint==='s16'?[true,true,true,true,true]:[false,false,false,false,false]);
  }
  const chain=compileAudioFilterChain('flanger=shape=t');
  expect([chain.nativeFormatLists,chain.reframes,chain.has('generatesOutput'),chain.capabilities[0]!.stateless,chain.capabilities[0]!.rateConversion,audioFilterCapabilities(chain.steps[0]!).flacInput,chain.capabilities[0]!.timeSelection,chain.capabilities[0]!.allocatesFrames]).toEqual([true,true,false,false,false,false,false,true]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(/^flanger with sample rate conversion is not implemented$/);
  expect(()=>chain.apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null},{maxFrameBytes:64})).toThrow('flanger requires stream processing');
  expect(chain.outputSamples(1000n,8000,{channels:2})).toBe(1000n);expect(chain.packetSections(1000n,512n,8000,true,2)).toEqual([{samples:1000n,span:512n}]);
  expect(chain.planSamples(13n,8000).stages.at(-1)).toMatchObject({inputSamples:13n,outputSamples:13n});
  expect(compileAudioFilterChain('asetnsamples=n=7:p=0,flanger=shape=t').packetSections(13n,5n,8000,true,1)).toEqual([{samples:13n,span:7n}]);
  // max_samples doubles per channel of ring, one delay_last double per channel and lfo_length floats.
  const reserved=(format:'u8'|'s16'|'dbl',channels:number)=>chain.plannedReservations({sampleRate:8000,channels,sampleFormat:format},{samples:13n,configuredInput:true,channels})[0]!.reservation;
  expect(reserved('u8',1)).toEqual({frames:1,buffers:[],stateBytes:18n*8n+8n+16000n*4n});expect(reserved('dbl',3).stateBytes).toBe(18n*3n*8n+24n+64000n);
  expect([...compileAudioFilterChain('flanger=speed=0.1:delay=30:depth=10:shape=t').reservations({sampleRate:44100,channels:2,sampleFormat:'s16'})]).toEqual([{frames:1,buffers:[],stateBytes:BigInt(Math.trunc(0.04*44100+2.5))*16n+16n+441000n*4n}]);
  expect(flangerStateBytes(flangerPlan(parseFlanger('flanger=shape=t'),8000),2)).toBe(18n*16n+16n+64000n);
  expect([...compileAudioFilterChain('flanger=speed=10:shape=t').reservations({sampleRate:9,channels:1,sampleFormat:'s16'})]).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
});
/** Direct transcription of af_flanger.c filter_frame over whole channels, with its own ff_generate_wave_table(WAVE_TRI). */
function reference(step:AudioFlangerStep,channels:readonly number[][],rate:number):number[][] {
  let feedback=step.regen,gain=step.width,phase=step.phase,dmin=step.delay,depth=step.depth;
  feedback/=100;gain/=100;phase/=100;dmin/=1000;depth/=1000;const inGain=1/(1+gain);gain/=1+gain;gain*=1-Math.abs(feedback);
  const max=Math.trunc((dmin+depth)*rate+2.5),length=Math.trunc(rate/step.speed),lfo=new Float32Array(length);
  const low=(()=>{const x=dmin*rate,f=Math.floor(x);return x-f!==0.5?Math.round(x):f%2===0?f:f+1;})(),high=max-2,offset=Math.trunc(3*Math.PI/2/Math.PI/2*length+0.5);
  for(let i=0;i<length;i++){const point=(i+offset)%length;let d=point*2/length;const q=Math.floor(4*point/length);d=q===0?d+0.5:q===3?d-1.5:1.5-d;lfo[i]=d*(high-low)+low;}
  const buffers=channels.map(()=>new Array<number>(max).fill(0)),last=channels.map(()=>0),result=channels.map(()=>[] as number[]);let pos=0,lfoPos=0;
  for(let i=0;i<channels[0]!.length;i++){
    pos=(pos+max-1)%max;
    for(let chan=0;chan<channels.length;chan++){
      const cp=Math.trunc(chan*length*phase+.5),delay=lfo[(lfoPos+cp)%length]!;let id=Math.trunc(delay);const frac=delay%1,buf=buffers[chan]!,x=channels[chan]![i]!;
      buf[pos]=x+last[chan]!*feedback;const d0=buf[(pos+id++)%max]!;let d1=buf[(pos+id++)%max]!,out:number;
      if(step.interp==='linear')out=d0+(d1-d0)*frac;else{let d2=buf[(pos+id++)%max]!;d2-=d0;d1-=d0;const a=d2*.5-d1,b=d1*2-d2*.5;out=d0+(a*frac+b)*frac;}
      last[chan]=out;result[chan]!.push(x*inGain+out*gain);
    }
    lfoPos=(lfoPos+1)%length;
  }
  return result;
}
function frames(values:number[][],sizes:readonly number[],rate:number,format:'dbl'|'dblp'|'s16'):AudioFrameData[] {
  const channels=values.length,result:AudioFrameData[]=[],width=format==='s16'?2:8;let offset=0;
  for(const samples of sizes){
    const set=(view:DataView,at:number,value:number)=>format==='s16'?view.setInt16(at,Math.round(value*32767),true):view.setFloat64(at,value,true);
    const planes=format==='dblp'?values.map(channel=>{const data=new Uint8Array(samples*8),view=new DataView(data.buffer);for(let s=0;s<samples;s++)set(view,s*8,channel[offset+s]!);return data;}):[(()=>{const data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let s=0;s<samples;s++)for(let c=0;c<channels;c++)set(view,(s*channels+c)*width,values[c]![offset+s]!);return data;})()];
    result.push({sampleRate:rate,channels,channelLayout:channels===2?'stereo':channels===1?'mono':'unspecified',sampleFormat:format,samples,planes,pts:{value:BigInt(offset)+90n,timeBase:{num:1n,den:BigInt(rate)}}});offset+=samples;
  }
  return result;
}
const splits=(size:number,total:number)=>Array.from({length:Math.ceil(total/size)},(_,i)=>Math.min(size,total-i*size));
it('matches a transcription of the C loop for every option family, with identical output for 1/7/29/50-sample splits and owned outputs',async()=>{
  const rate=8000,total=900;
  const texts=['flanger=shape=t','flanger=delay=5:depth=10:regen=40:width=100:speed=10:shape=t:phase=100:interp=quadratic','flanger=30:0:-95:0:0.1:t:0:linear','flanger=delay=0:depth=0:shape=t',
    'flanger=regen=95:speed=10:shape=t:interp=quadratic','flanger=delay=0.1875:depth=2:regen=-40:width=71:speed=0.5:shape=t:phase=25','flanger=delay=3:depth=5:regen=-95:speed=7.3:shape=t:phase=33:interp=quadratic'];
  for(const text of texts)for(const channels of [1,3]){
    const step=parseFlanger(text),values=Array.from({length:channels},(_,c)=>Array.from({length:total},(_,i)=>i===0?-0:Math.sin(i*0.37+c)*((i*7+c)%11)/10));
    const expected=reference(step,values,rate);
    for(const [format,sizes]of [['dblp',[total]],['dbl',splits(1,total)],['dblp',splits(7,total)],['dbl',splits(29,total)],['dblp',splits(50,total)],['dbl',[1,4,7,2,13,3,870]]] as const){
      const source=frames(values,sizes,rate,format),copies=source.map(frame=>frame.planes.map(plane=>plane.slice()));
      const output=await collect(compileAudioFilterChain(text).process(input(...source),{maxFrameBytes:1<<20}));
      expect(source.map(frame=>frame.planes),`${text} input untouched`).toEqual(copies);
      expect(output.every(frame=>frame.sampleFormat==='dblp'&&frame.planes.every(plane=>!source.some(f=>f.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
      expect(output.map(frame=>[frame.samples,frame.pts])).toEqual(source.map(frame=>[frame.samples,frame.pts]));
      const actual=Array.from({length:channels},(_,c)=>output.flatMap(frame=>Array.from(new Float64Array(frame.planes[c]!.slice().buffer))));
      expect(actual,`${text} ${channels} ${format} ${sizes.length}`).toEqual(expected);
    }
  }
  // Integer input converts exactly to dblp (x/32768) before the loop.
  const ints=Array.from({length:2},(_,c)=>Array.from({length:300},(_,i)=>Math.round(Math.sin(i*0.21+c)*32767)/32767));
  const converted=ints.map(channel=>channel.map(value=>Math.round(value*32767)/32768)),step=parseFlanger('flanger=delay=2:regen=50:shape=t');
  const output=await collect(compileAudioFilterChain('flanger=delay=2:regen=50:shape=t').process(input(...frames(ints,[100,200],rate,'s16')),{maxFrameBytes:1<<20}));
  expect(Array.from({length:2},(_,c)=>output.flatMap(frame=>Array.from(new Float64Array(frame.planes[c]!.slice().buffer))))).toEqual(reference(step,converted,rate));
});
it('enforces allocation, state, format and cancellation limits',async()=>{
  const frame=(samples:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples,planes:[new Uint8Array(samples*4)],pts:null,...extra});
  const chain=compileAudioFilterChain('flanger=shape=t'),state=Number(flangerStateBytes(flangerPlan(parseFlanger('flanger=shape=t'),8000),2));
  await expect(collect(chain.process(input(frame(1)),{maxFrameBytes:state-1}))).rejects.toThrow('flanger state exceeds allocation limit');
  expect((await collect(chain.process(input(frame(1)),{maxFrameBytes:state}))).length).toBe(1);
  await expect(collect(chain.process(input(frame(state/16+1)),{maxFrameBytes:state}))).rejects.toThrow(/allocation limit/);
  await expect(collect(chain.process(input(frame(1),frame(1,{channelLayout:'downmix'})),{maxFrameBytes:1<<20}))).rejects.toThrow('flanger requires a stable input format');
  await expect(collect(chain.process(input(frame(1),frame(1,{sampleRate:16000})),{maxFrameBytes:1<<20}))).rejects.toThrow(/flanger/);
  await expect(collect(compileAudioFilterChain('flanger=speed=10:shape=t').process(input(frame(1,{sampleRate:9})),{maxFrameBytes:1<<20}))).rejects.toThrow('flanger speed 10 leaves no LFO samples at 9 Hz');
  await expect(collect(flanger.stream!(parseFlanger('flanger=shape=t'),input(frame(1)),{maxFrameBytes:0},undefined,()=>'dblp'))).rejects.toThrow('Invalid flanger allocation limit');
  await expect(collect(flanger.stream!(parseFlanger('flanger=shape=t'),input(frame(1)),{maxFrameBytes:1<<20},undefined,()=>'dbl'))).rejects.toThrow('flanger cannot work in dbl');
  await expect(collect(flanger.stream!(parseFlanger('flanger=shape=t'),input(frame(1,{samples:-1})),{maxFrameBytes:1<<20},undefined,()=>'dblp'))).rejects.toThrow('Invalid flanger input frame');
  expect(await collect(flanger.stream!(parseFlanger('flanger=shape=t'),input(),{maxFrameBytes:1<<20},undefined,()=>'dblp'))).toEqual([]);
  const controller=new AbortController();let closed=false;async function* source(){try{yield frame(1);controller.abort(new Error('stop'));yield frame(1);}finally{closed=true;}}
  await expect(collect(chain.process(source(),{maxFrameBytes:1<<20,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  const early=new AbortController();early.abort(new Error('early'));await expect(collect(chain.process(input(frame(1)),{maxFrameBytes:1<<20,signal:early.signal}))).rejects.toThrow('early');
});
