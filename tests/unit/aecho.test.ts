import {expect,it} from 'vitest';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {aecho,audioEchoFormat,audioEchoSamples,parseAudioEcho} from '../../packages/avfilter/src/audio/aecho.js';
import type {AudioEchoStep} from '../../packages/avfilter/src/audio/aecho.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const refuse=(text:string,message:string)=>{expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`));};
it('parses defaults, positional and named options, empty list fields and float32 values',()=>{
  expect(parseAudioEcho('aecho')).toEqual({name:'aecho',inGain:Math.fround(0.6),outGain:Math.fround(0.3),delays:[1000],decays:[0.5]});
  expect(parseAudioEcho('aecho=0.8:0.9:20|7.3:0.5|0.3')).toEqual({name:'aecho',inGain:Math.fround(0.8),outGain:Math.fround(0.9),delays:[20,Math.fround(7.3)],decays:[0.5,Math.fround(0.3)]});
  // Named options in any order, a named option after positional ones, the last value wins, and av_strtok skips empty fields.
  expect(parseAudioEcho('aecho=0.5:decays=||0.25|:delays=|3|:in_gain=1:in_gain=.25')).toEqual({name:'aecho',inGain:0.25,outGain:Math.fround(0.3),delays:[3],decays:[0.25]});
  expect(parseAudioEcho('aecho=0:1:90000:1')).toEqual({name:'aecho',inGain:0,outGain:1,delays:[90000],decays:[1]});
  const step=parseAudioEcho('aecho=0.8:0.9:1|2|3:0.1|0.2|0.3');expect(Object.isFrozen(step)&&Object.isFrozen(step.delays)&&Object.isFrozen(step.decays)).toBe(true);
  expect(compileAudioFilterChain('aecho=0.8:0.9:20|7.3:0.5|0.3').steps[0]).toEqual(parseAudioEcho('aecho=0.8:0.9:20|7.3:0.5|0.3'));
});
it('refuses native errors and unimplemented option forms with exact messages',()=>{
  refuse('aecho=delays=1|2:decays=0.5','Number of aecho delays 2 differs from number of decays 1');
  refuse('aecho=delays=|:decays=|','aecho requires at least one delay and decay');
  refuse('aecho=delays=:decays=0.5','Number of aecho delays 0 differs from number of decays 1');
  refuse('aecho=delays=0:decays=0.5','aecho delay[0] is out of allowed range (0, 90000]');
  refuse('aecho=delays=10|90001:decays=0.5|0.5','aecho delay[1] is out of allowed range (0, 90000]');
  refuse('aecho=delays=10:decays=0','aecho decay[0] is out of allowed range (0, 1]');
  refuse('aecho=delays=10|20:decays=0.5|1.5','aecho decay[1] is out of allowed range (0, 1]');
  refuse('aecho=in_gain=2','aecho in_gain is out of range [0, 1]');refuse('aecho=0.5:1.01','aecho out_gain is out of range [0, 1]');
  refuse('aecho=0.5:0.5:10:0.5:3','Invalid aecho option');refuse('aecho=in_gain=0.5:0.5','Invalid aecho option');refuse('aecho=in_gain=0.5=1','Invalid aecho option');
  refuse('aecho=foo=1','Unsupported aecho option: foo');
  for(const value of ['1/2','.5e0','-0','','0x1','PI'])refuse(`aecho=in_gain=${value}`,'Only decimal aecho in_gain values are implemented');
  for(const value of ['1e1','+10','-1','0x10','10ms','abc','inf','nan','10\\'])refuse(`aecho=delays=${value}:decays=0.5`,`Unsupported aecho delays value: ${value}`);
  refuse('aecho=delays=10:decays=0.5x','Unsupported aecho decays value: 0.5x');
  // 0.50000002980232238769531250 lies exactly between two floats: double-then-float rounding could differ from sscanf's direct float rounding.
  refuse('aecho=delays=10:decays=0.50000002980232238769531250','Unsupported aecho decays value: 0.50000002980232238769531250');
});
it('computes tap indexes in float32 truncated toward zero, and refuses a rate where nothing echoes',()=>{
  const samples=(text:string,rate:number)=>audioEchoSamples(parseAudioEcho(text),rate);
  expect(samples('aecho=0.8:0.9:20|7.3:0.5|0.3',44100)).toEqual({samples:[882,321],maximum:882});
  expect(samples('aecho=0.8:0.9:20|7.3:0.5|0.3',8000)).toEqual({samples:[160,58],maximum:160});
  // 0.1 ms at 8000 Hz is a zero-sample tap: it reads the slot about to be overwritten, max_samples ago.
  expect(samples('aecho=0.6:0.3:300|0.1:0.5|0.5',8000)).toEqual({samples:[2400,0],maximum:2400});
  expect(samples('aecho',44100)).toEqual({samples:[44100],maximum:44100});expect(samples('aecho=delays=90000',8000).maximum).toBe(720000);
  expect(()=>samples('aecho=delays=0.05',8000)).toThrow(/^aecho has nothing to echo: missing delay samples$/);
  expect(()=>samples('aecho=delays=90000',2147483647)).toThrow(/^aecho delay exceeds int samples$/);
  for(const rate of [0,8000.5,2147483648,undefined])expect(()=>audioEchoSamples(parseAudioEcho('aecho'),rate)).toThrow(/^aecho requires a valid sample rate$/);
  const chain=compileAudioFilterChain('aecho=delays=0.05');
  expect(()=>chain.validateInputFormat({sampleRate:8000,channels:2,channelLayout:'stereo'})).toThrow(/^aecho has nothing to echo: missing delay samples$/);
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).not.toThrow();
});
it('negotiates the native picks, refuses rate conversion and declares its tail and ring',()=>{
  const chain=compileAudioFilterChain('aecho=0.8:0.9:20|7.3:0.5|0.3',{outputSampleFormat:'s16'});
  expect((['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const).map(format=>chain.negotiatedSampleFormats(format)[0])).toEqual(['s16p','s16p','s32p','fltp','dblp','s16p','s16p','s32p','fltp','dblp']);
  expect(['u8','s16','s32','flt','dbl'].map(audioEchoFormat)).toEqual(['s16p','s16p','s32p','fltp','dblp']);expect(()=>audioEchoFormat('s64')).toThrow('Unsupported aecho sample format');
  expect(compileAudioFilterChain('aecho,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats('s16')).toEqual(['fltp','flt']);
  expect([chain.nativeFormatLists,chain.reframes,chain.has('generatesOutput'),chain.capabilities[0]!.stateless,chain.capabilities[0]!.rateConversion,audioFilterCapabilities(chain.steps[0]!).flacInput,chain.capabilities[0]!.timeSelection]).toEqual([true,true,true,false,false,false,false]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(/^aecho with sample rate conversion is not implemented$/);
  expect(()=>chain.apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null},{maxFrameBytes:64})).toThrow('aecho requires stream processing');
  // max_samples of tail in 2048-sample packets after the input sections, for configured empty input too; asetnsamples pads 173 samples to 175.
  expect(chain.outputSamples(1000n,8000,{channels:2})).toBe(1160n);expect(chain.outputSamples(1000n,44100)).toBe(1882n);
  expect(chain.packetSections(1000n,512n,8000,true,2)).toEqual([{samples:1000n,span:512n},{samples:160n,span:2048n}]);
  const long=compileAudioFilterChain('aecho=0.8:0.9:300|1000:0.5|0.3');
  expect(long.packetSections(0n,512n,8000,true,2)).toEqual([{samples:8000n,span:2048n}]);expect(long.requiredBufferSamples(13n,8000)).toEqual([2048]);
  expect(long.planSamples(13n,8000).stages.at(-1)).toMatchObject({inputSamples:13n,outputSamples:8013n,packets:{trailing:{samples:8000n,span:2048n}}});
  expect(compileAudioFilterChain('aecho=0.8:0.9:20:0.5,asetnsamples=7').packetSections(13n,5n,8000,true,1).reduce((sum,section)=>sum+section.samples,0n)).toBe(175n);
  // Ring bytes: max_samples per channel at the working width (u8 widens to s16p).
  const reserved=(format:'u8'|'s16'|'s32'|'flt'|'dbl')=>long.plannedReservations({sampleRate:8000,channels:3,sampleFormat:format},{samples:13n,configuredInput:true,channels:3})[0]!;
  expect(reserved('u8')).toEqual({step:long.steps[0],reservation:{frames:1,buffers:[],stateBytes:48000n},countBuffers:[2048]});
  expect((['s16','s32','flt','dbl'] as const).map(format=>reserved(format).reservation.stateBytes)).toEqual([48000n,96000n,96000n,192000n]);
  expect([...long.reservations({sampleRate:44100,channels:1,sampleFormat:'dbl'})]).toEqual([{frames:1,buffers:[],stateBytes:352800n}]);
});
type Kind='s16'|'s32'|'flt'|'dbl';
/** Direct transcription of echo_samples_<fmt>p over whole planar channels plus the silent tail. */
function reference(step:AudioEchoStep,kind:Kind,channels:readonly number[][],rate:number):number[][] {
  const {samples,maximum}=audioEchoSamples(step,rate),[min,max]=kind==='s16'?[-32768,32767]:kind==='s32'?[-2147483648,2147483647]:[-1,1];
  return channels.map(values=>{
    const dbuf=new Array<number>(maximum).fill(0),result:number[]=[];let index=0;
    for(const value of [...values,...new Array<number>(maximum).fill(0)]){
      const x=value;let out=x*step.inGain;
      for(let j=0;j<samples.length;j++){let ix=index+maximum-samples[j]!;ix=ix>=maximum?ix-maximum:ix;const tap=dbuf[ix]!;
        out+=kind==='dbl'?tap*step.decays[j]!:Math.fround((kind==='s32'?Math.fround(tap):tap)*step.decays[j]!);}
      out*=step.outGain;const clipped=Math.min(Math.max(out,min),max);
      result.push(kind==='flt'?Math.fround(clipped):kind==='dbl'?clipped:Math.trunc(clipped));dbuf[index]=x;index=index+1>=maximum?index+1-maximum:index+1;
    }
    return result;
  });
}
const io={s16:[2,(v:DataView,o:number)=>v.getInt16(o,true),(v:DataView,o:number,x:number)=>v.setInt16(o,x,true)],s32:[4,(v:DataView,o:number)=>v.getInt32(o,true),(v:DataView,o:number,x:number)=>v.setInt32(o,x,true)],flt:[4,(v:DataView,o:number)=>v.getFloat32(o,true),(v:DataView,o:number,x:number)=>v.setFloat32(o,x,true)],dbl:[8,(v:DataView,o:number)=>v.getFloat64(o,true),(v:DataView,o:number,x:number)=>v.setFloat64(o,x,true)]} as const;
function frames(kind:Kind,planar:boolean,values:number[][],sizes:readonly number[],rate:number):AudioFrameData[] {
  const [width,,set]=io[kind],channels=values.length,result:AudioFrameData[]=[];let offset=0;
  for(const samples of sizes){
    const planes=planar?values.map(channel=>{const data=new Uint8Array(samples*width),view=new DataView(data.buffer);for(let s=0;s<samples;s++)set(view,s*width,channel[offset+s]!);return data;}):[(()=>{const data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let s=0;s<samples;s++)for(let c=0;c<channels;c++)set(view,(s*channels+c)*width,values[c]![offset+s]!);return data;})()];
    result.push({sampleRate:rate,channels,channelLayout:channels===2?'stereo':channels===1?'mono':'unspecified',sampleFormat:planar?`${kind}p`:kind,samples,planes,pts:{value:BigInt(offset)*2n+1000n,timeBase:{num:1n,den:BigInt(rate*2)}}});offset+=samples;
  }
  return result;
}
it('matches a transcription of the C loop for every working format, frame split and tap list, with owned outputs and the tail after the last frame',async()=>{
  const rate=8000,total=700;
  for(const kind of ['s16','s32','flt','dbl'] as const)for(const planar of [false,true])for(const text of ['aecho=0.8:0.9:20|7.3:0.5|0.3','aecho=1:1:1|2|3:1|1|1','aecho=0.6:0.3:300|0.1:0.5|0.5','aecho=0.5:0.7:0.125|0.25:0.9|0.4']){
    const step=parseAudioEcho(text),channels=3,values=Array.from({length:channels},(_,c)=>Array.from({length:total},(_,i)=>{
      const wave=Math.sin(i*0.37+c)*((i*7+c)%11)/10;return kind==='s16'?Math.round(wave*32767):kind==='s32'?Math.round(wave*2147483647):kind==='flt'?Math.fround(wave*1.2):wave*1.2;}));
    const expected=reference(step,kind,values,rate),[width,get]=io[kind];
    for(const sizes of [[total],[1,4,7,2,13,3,670],[350,350],[160,1,539]]){
      const source=frames(kind,planar,values,sizes,rate),copies=source.map(frame=>frame.planes.map(plane=>plane.slice()));
      const chain=compileAudioFilterChain(text),output=await collect(chain.process(input(...source),{maxFrameBytes:1<<16}));
      expect(source.map(frame=>frame.planes),`${kind} ${text} input untouched`).toEqual(copies);
      expect(output.every(frame=>frame.sampleFormat===`${kind}p`&&frame.planes.every(plane=>!source.some(f=>f.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
      // Input frames keep their sizes; then max_samples of tail in frames of at most 2048, continuing the timestamps.
      const {maximum}=audioEchoSamples(step,rate),tail=output.slice(sizes.length);
      expect(output.slice(0,sizes.length).map(frame=>frame.samples)).toEqual(sizes);expect(tail.map(frame=>frame.samples)).toEqual(Array.from({length:Math.ceil(maximum/2048)},(_,i)=>Math.min(2048,maximum-i*2048)));
      let position=500n;for(const frame of output){expect(frame.pts).toEqual({value:position,timeBase:{num:1n,den:8000n}});position+=BigInt(frame.samples);}
      const actual=Array.from({length:channels},(_,c)=>output.flatMap(frame=>{const plane=frame.planes[c]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:frame.samples},(_,s)=>get(view,s*width));}));
      expect(actual,`${kind} ${planar} ${text} ${sizes.join(',')}`).toEqual(expected);
    }
  }
});
it('widens u8 to s16p, emits the configured empty-input tail and enforces allocation, format and cancellation limits',async()=>{
  const u8:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'u8',samples:4,planes:[Uint8Array.of(0,128,255,200)],pts:null};
  const widened=await collect(compileAudioFilterChain('aecho=1:1:0.125:1').process(input(u8),{maxFrameBytes:64}));
  expect(widened.map(frame=>[frame.sampleFormat,frame.samples,frame.pts,Array.from(new Int16Array(frame.planes[0]!.slice().buffer))])).toEqual([['s16p',4,null,[-32768,-32768,32512,32767]],['s16p',1,null,[18432]]]);
  const chain=compileAudioFilterChain('aecho=0.8:0.9:300:0.5'),empty={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'flt' as const,pts:{value:7n,timeBase:{num:1n,den:8000n}}};
  const silent=await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:empty}));
  expect(silent.map(frame=>[frame.samples,frame.pts?.value,frame.sampleFormat])).toEqual([[2048,7n,'fltp'],[352,2055n,'fltp']]);expect(silent.every(frame=>frame.planes.every(plane=>plane.every(value=>value===0)))).toBe(true);
  await expect(collect(chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('aecho constraints require a configured empty input format');
  const frame=(samples:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples,planes:[new Uint8Array(samples*4)],pts:null,...extra});
  // 2400 samples x 2 channels x 2 bytes of ring.
  await expect(collect(chain.process(input(frame(1)),{maxFrameBytes:9599}))).rejects.toThrow('aecho delay buffer exceeds allocation limit');
  await expect(collect(chain.process(input(frame(2401)),{maxFrameBytes:9600}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  await expect(collect(chain.process(input(frame(1),frame(1,{channelLayout:'downmix'})),{maxFrameBytes:1<<16}))).rejects.toThrow('aecho requires a stable input format');
  await expect(collect(chain.process(input(frame(1,{pts:{value:1n,timeBase:{num:1n,den:3n}}})),{maxFrameBytes:1<<16}))).rejects.toThrow('sample-aligned');
  await expect(collect(compileAudioFilterChain('aecho=delays=0.05').process(input(frame(1)),{maxFrameBytes:1<<16}))).rejects.toThrow('aecho has nothing to echo');
  await expect(collect(aecho.stream!(parseAudioEcho('aecho'),input(frame(1)),{maxFrameBytes:0},undefined,()=>'s16p'))).rejects.toThrow('Invalid aecho allocation limit');
  await expect(collect(aecho.stream!(parseAudioEcho('aecho'),input(frame(1)),{maxFrameBytes:1<<20},undefined,()=>'s16'))).rejects.toThrow('aecho cannot run in s16');
  await expect(collect(aecho.stream!(parseAudioEcho('aecho'),input(),{maxFrameBytes:1<<20},undefined,()=>'s16p'))).rejects.toThrow('aecho requires a configured empty input format');
  const controller=new AbortController();let closed=false;async function* source(){try{yield frame(1);controller.abort(new Error('stop'));yield frame(1);}finally{closed=true;}}
  await expect(collect(chain.process(source(),{maxFrameBytes:1<<16,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  const late=new AbortController(),tail=chain.process(input(frame(1)),{maxFrameBytes:1<<16,signal:late.signal})[Symbol.asyncIterator]();
  await tail.next();await tail.next();late.abort(new Error('tail stop'));await expect(tail.next()).rejects.toThrow('tail stop');
});
