import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {compensationDelayBufferSize,compensationDelayEffectiveSamples,compensationDelayFront,compensationDelaySamples,compensationdelay} from '../../packages/avfilter/src/audio/compensationdelay.js';
import {pcmFilterMemory} from '../../packages/avformat/src/pcm-filter-memory.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>compensationdelay.parse(text);
/** Direct transcription of af_compensationdelay.c: macros, config_input's power-of-two ring and filter_frame's masked pointers. */
function native(text:string,rate:number,channels:number,frames:readonly (readonly Float64Array[])[]):Float64Array[][] {
  const s=step(text),KM_H=(t:number)=>1.85325*(643.95*Math.sqrt(((t+273.15)/273.15))),CM_S=(t:number)=>(KM_H(t)*(1000.0*100.0)/(60.0*60.0)),FRONT=(t:number)=>(1.0/CM_S(t));
  const MAX_DELAY=(100.0*100.0+100.0*1.0+1.0)*FRONT(50),delay=Math.trunc((s.m*100.+s.cm*1.+s.mm*.1)*FRONT(s.temp)*rate)>>>0,min=Math.trunc(rate*MAX_DELAY)>>>0;
  let size=1;while(size<min)size*=2;
  const mask=size-1,buffers=Array.from({length:channels},()=>new Float64Array(size));let w_ptr=0;
  return frames.map(planes=>{
    let w=0;
    const out=planes.map((src,ch)=>{
      const dst=new Float64Array(src.length),buffer=buffers[ch]!;w=w_ptr;let r=(w+size-delay)&mask;
      for(let n=0;n<src.length;n++){const sample=src[n]!;buffer[w]=sample;dst[n]=s.dry*sample+s.wet*buffer[r]!;w=(w+1)&mask;r=(r+1)&mask;}
      return dst;
    });
    w_ptr=w;return out;
  });
}
const frame=(planes:readonly Float64Array[],pts:bigint|null,rate=8000):AudioFrameData=>({sampleRate:rate,channels:planes.length,channelLayout:planes.length===1?'mono':planes.length===2?'stereo':'unspecified',sampleFormat:'dblp',samples:planes[0]!.length,planes:planes.map(plane=>new Uint8Array(plane.slice().buffer)),pts:pts===null?null:{value:pts,timeBase:{num:1n,den:BigInt(rate)}}});
const doubles=(frame:AudioFrameData)=>frame.planes.map(plane=>new Float64Array(plane.slice().buffer));
it('parses named and positional options and refuses expressions, enable, unknown names and out-of-range values with exact messages',()=>{
  expect(step('compensationdelay')).toEqual({name:'compensationdelay',mm:0,cm:0,m:0,dry:0,wet:1,temp:20});
  expect(step('compensationdelay=5:3:1:0.3:0.6:-50')).toEqual({name:'compensationdelay',mm:5,cm:3,m:1,dry:0.3,wet:0.6,temp:-50});
  expect(step('compensationdelay=7:cm=33:dry=.3:wet=1.:temp=-0')).toEqual({name:'compensationdelay',mm:7,cm:33,m:0,dry:0.3,wet:1,temp:0});
  expect(Object.is(step('compensationdelay=temp=-0').temp,0)).toBe(true);expect(Object.isFrozen(step('compensationdelay=m=3'))).toBe(true);
  const refused:[string,string][]=[
    ['compensationdelay=mm=11','compensationdelay mm is out of range [0 - 10]'],['compensationdelay=cm=101','compensationdelay cm is out of range [0 - 100]'],['compensationdelay=m=-1','compensationdelay m is out of range [0 - 100]'],
    ['compensationdelay=temp=51','compensationdelay temp is out of range [-50 - 50]'],['compensationdelay=temp=-51','compensationdelay temp is out of range [-50 - 50]'],['compensationdelay=dry=2','compensationdelay dry is out of range [0 - 1]'],['compensationdelay=wet=1.5','compensationdelay wet is out of range [0 - 1]'],
    ['compensationdelay=mm=1.5','Unsupported compensationdelay mm value: 1.5'],['compensationdelay=cm=10+5','Unsupported compensationdelay cm value: 10+5'],['compensationdelay=dry=1e-1','Unsupported compensationdelay dry value: 1e-1'],['compensationdelay=wet=-0.5','Unsupported compensationdelay wet value: -0.5'],['compensationdelay=mm=','Unsupported compensationdelay mm value: '],
    ['compensationdelay=enable=1','compensationdelay timeline enable is not implemented'],['compensationdelay=foo=1','Unsupported compensationdelay option: foo'],['compensationdelay=cm=33:7','Invalid compensationdelay option'],['compensationdelay=1:2:3:0:1:20:9','Invalid compensationdelay option'],['compensationdelay=mm=1=2','Invalid compensationdelay option'],['compensationdelayx','Unsupported audio filter: compensationdelayx']];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(new RegExp(`^${message.replace(/[[\]+.]/g,'\\$&')}$`));expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
});
it('computes the delay from the macro transcription, truncating toward zero',()=>{
  const FRONT=(t:number)=>(1.0/((1.85325*(643.95*Math.sqrt(((t+273.15)/273.15))))*(1000.0*100.0)/(60.0*60.0)));
  for(let temp=-50;temp<=50;temp++)expect(compensationDelayFront(temp),String(temp)).toBe(FRONT(temp));
  for(const rate of [8000,11025,44100,48000,96000,192000])for(const [m,cm,mm]of [[0,0,0],[0,0,1],[0,0,10],[0,33,7],[1,0,0],[10,1,9],[100,100,10]] as const)for(const temp of [-50,0,20,50]){
    const s=step(`compensationdelay=m=${m}:cm=${cm}:mm=${mm}:temp=${temp}`);expect(compensationDelaySamples(s,rate)).toBe(Math.trunc((m*100.+cm*1.+mm*.1)*FRONT(temp)*rate));
  }
  const delay=(text:string,rate:number)=>compensationDelaySamples(step(text),rate);
  expect([delay('compensationdelay=cm=33:mm=7',44100),delay('compensationdelay=mm=7',8000),delay('compensationdelay=m=1:temp=-50',48000),delay('compensationdelay=m=100:cm=100:mm=10:temp=-50',48000),delay('compensationdelay=m=100:cm=100:mm=10:temp=50',8000),delay('compensationdelay=m=10:cm=1:mm=9',44100)]).toEqual([43,0,160,16181,2241,1286]);
  for(const rate of [0,8000.5,2147483648])expect(()=>delay('compensationdelay',rate)).toThrow('compensationdelay requires a valid sample rate');
});
it('negotiates pinned dblp for every input format and keeps counts, packet sections and planned reservations',()=>{
  const chain=compileAudioFilterChain('compensationdelay=cm=33:mm=7');
  expect((['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const).map(format=>chain.negotiatedSampleFormats(format)[0])).toEqual(Array(10).fill('dblp'));
  expect(chain.nativeFormatLists).toBe(true);expect(chain.reframes).toBe(true);expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:false});
  expect(compileAudioFilterChain('compensationdelay,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats('s16')).toEqual(['dblp','flt']);
  expect(chain.planSamples(9000n,44100,{channels:2}).samples).toBe(9000n);expect(chain.outputSamples(0n,8000,{channels:1})).toBe(0n);
  expect(chain.packetSections(9000n,1024n,44100,true,2)).toEqual([{samples:9000n,span:1024n}]);
  expect(compileAudioFilterChain('asetnsamples=37,compensationdelay=m=1').packetSections(100n,1024n,8000,true,1)).toEqual([{samples:111n,span:37n}]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  // No constraint: every rate, channel count and layout runs as native does.
  for(const format of [{sampleRate:8000,channels:1,channelLayout:'mono'},{sampleRate:192000,channels:6,channelLayout:'unspecified'},{sampleRate:44100,channels:2,channelLayout:'2 channels (FL+FC)'}])expect(()=>chain.validateInputFormat(format)).not.toThrow();
  const {reservation,countBuffers}=chain.plannedReservations({sampleRate:44100,channels:2,sampleFormat:'s16'},{samples:9000n,channels:2,configuredInput:true})[0]!;
  expect(reservation).toEqual({frames:1,buffers:[],stateBytes:44n*2n*8n});expect(countBuffers).toEqual([]);
  expect([...compileAudioFilterChain('compensationdelay=m=100:cm=100:mm=10:temp=-50').reservations({sampleRate:48000,channels:3,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:16182n*3n*8n}]);
  const big=compileAudioFilterChain('compensationdelay=m=100:cm=100:mm=10:temp=-50'),plan={samples:100n,channels:2,configuredInput:true};
  expect(pcmFilterMemory(big,{sampleRate:48000,channels:2,sampleFormat:'s16'},plan,{width:8,maxBufferBytes:1<<20,maxResidentBytes:1<<22})).toBeTruthy();
  expect(()=>pcmFilterMemory(big,{sampleRate:48000,channels:2,sampleFormat:'s16'},plan,{width:8,maxBufferBytes:65536,maxResidentBytes:1<<22})).toThrow('Audio filter state exceeds the configured buffer budget');
});
it('matches the C transcription across ring wraps, delay 0 and arbitrary frame splits, keeping timestamps and owning output',async()=>{
  for(const text of ['compensationdelay','compensationdelay=cm=33:mm=7:dry=0.3:wet=0.6','compensationdelay=m=1:temp=-50:dry=1:wet=1','compensationdelay=m=10:dry=0.5','compensationdelay=mm=10:dry=1:wet=0'])for(const channels of [1,2,3]){
    const total=5000,rate=8000,source=Array.from({length:channels},(_,c)=>Float64Array.from({length:total},(_,i)=>i===0?-0:Math.sin(i*0.37+c)*((i%11)/10)));
    const reference=native(text,rate,channels,[source]).flatMap(planes=>planes);
    for(const sizes of [[total],[1,4,7,2,13,3,600,4370],[1024,1024,1024,1024,904],Array(50).fill(100)]){
      const frames:AudioFrameData[]=[];let offset=0;
      for(const samples of sizes){frames.push(frame(source.map(plane=>plane.slice(offset,offset+samples)),BigInt(offset)+7n,rate));offset+=samples;}
      const copies=frames.map(f=>f.planes.map(plane=>plane.slice()));
      const output=await collect(compileAudioFilterChain(text).process(input(...frames),{maxFrameBytes:1<<20}));
      expect(frames.map(f=>f.planes),`${text} input untouched`).toEqual(copies);
      expect(output.map(f=>[f.samples,f.pts?.value,f.sampleFormat])).toEqual(sizes.map((samples,i)=>[samples,frames[i]!.pts!.value,'dblp']));
      expect(output.every(f=>f.planes.every(plane=>!frames.some(i=>i.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
      // Split invariance against one native frame, and against native fed the same split.
      for(let c=0;c<channels;c++){const joined=Float64Array.from(output.flatMap(f=>Array.from(doubles(f)[c]!)));expect(Object.is(joined[0],reference[c]![0])&&joined.every((v,i)=>Object.is(v,reference[c]![i])),`${text}/${channels}/${sizes.length} channel ${c}`).toBe(true);}
      const split=native(text,rate,channels,frames.map(doubles));expect(output.map(doubles)).toEqual(split);
    }
  }
});
it('reduces the delay modulo native\'s power-of-two ring where colder temperatures exceed it, as the masked read does',async()=>{
  const wrap='compensationdelay=m=100:cm=100:mm=10:temp=-50:dry=0:wet=1',cold='compensationdelay=m=100:cm=100:mm=10:temp=-40:dry=0.5:wet=0.5';
  const sizes=(text:string,rate:number)=>[compensationDelaySamples(step(text),rate),compensationDelayBufferSize(rate),compensationDelayEffectiveSamples(step(text),rate)];
  expect([sizes(wrap,50000),sizes(wrap,25000),sizes(cold,50000),sizes(cold,25000),sizes(wrap,48000),sizes(wrap,44100),sizes(wrap,8000)]).toEqual([[16855,16384,471],[8427,8192,235],[16490,16384,106],[8245,8192,53],[16181,16384,16181],[14866,16384,14866],[2696,4096,2696]]);
  expect([...compileAudioFilterChain(wrap).reservations({sampleRate:50000,channels:2,sampleFormat:'dbl'})]).toEqual([{frames:1,buffers:[],stateBytes:472n*2n*8n}]);
  for(const rate of [25000,50000,48000])for(const text of [wrap,cold,'compensationdelay=m=100:temp=-50'])for(const channels of [1,2]){
    const total=20000,source=Array.from({length:channels},(_,c)=>Float64Array.from({length:total},(_,i)=>Math.sin(i*0.21+c)*((i%13)/12)));
    const reference=native(text,rate,channels,[source]).flatMap(planes=>planes);
    for(const split of [[total],Array(20).fill(1000),[7,4093,1,15899]]){
      const frames:AudioFrameData[]=[];let offset=0;
      for(const samples of split){frames.push(frame(source.map(plane=>plane.slice(offset,offset+samples)),BigInt(offset),rate));offset+=samples;}
      const output=await collect(compileAudioFilterChain(text).process(input(...frames),{maxFrameBytes:1<<20}));
      for(let c=0;c<channels;c++){const joined=Float64Array.from(output.flatMap(f=>Array.from(doubles(f)[c]!)));expect(joined.length===total&&joined.every((v,i)=>Object.is(v,reference[c]![i])),`${text}/${rate}/${channels}/${split.length} channel ${c}`).toBe(true);}
    }
  }
});
it('converts packed and integer input to dblp, enforces allocation and format limits, and stops on abort',async()=>{
  const s16={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:3,planes:[Uint8Array.from([0,64,0,192,255,127,1,128,0,0,0,0])],pts:null} as AudioFrameData;
  const [out]=await collect(compileAudioFilterChain('compensationdelay=dry=1:wet=0').process(input(s16),{maxFrameBytes:4096})) as [AudioFrameData];
  expect(out.sampleFormat).toBe('dblp');expect(doubles(out)).toEqual([Float64Array.from([0.5,32767/32768,0]),Float64Array.from([-0.5,-32767/32768,0])]);
  const chain=(text:string)=>compileAudioFilterChain(text),one=frame([new Float64Array(4),new Float64Array(4)],0n,48000);
  // delay 16181 at 48000 Hz: (16181+1)*2*8 ring bytes.
  await expect(collect(chain('compensationdelay=m=100:cm=100:mm=10:temp=-50').process(input(one),{maxFrameBytes:258911}))).rejects.toThrow('compensationdelay delay buffer exceeds allocation limit');
  expect((await collect(chain('compensationdelay=m=100:cm=100:mm=10:temp=-50').process(input(one),{maxFrameBytes:258912}))).length).toBe(1);
  await expect(collect(chain('compensationdelay').process(input(frame([new Float64Array(100)],0n)),{maxFrameBytes:799}))).rejects.toThrow(/allocation limit/);
  await expect(collect(compensationdelay.stream!(step('compensationdelay'),input(one),{maxFrameBytes:0},undefined,()=>'dblp'))).rejects.toThrow('Invalid compensationdelay allocation limit');
  await expect(collect(compensationdelay.stream!(step('compensationdelay'),input(one),{maxFrameBytes:4096},undefined,()=>'fltp'))).rejects.toThrow('compensationdelay cannot work in fltp');
  await expect(collect(compensationdelay.stream!(step('compensationdelay'),input(one,frame([new Float64Array(4),new Float64Array(4)],4n,44100)),{maxFrameBytes:4096},undefined,()=>'dblp'))).rejects.toThrow('compensationdelay requires a stable input format');
  expect(await collect(chain('compensationdelay=m=3').process(input(),{maxFrameBytes:64}))).toEqual([]);
  const controller=new AbortController();let closed=false;async function* frames(){try{yield one;controller.abort(new Error('stop'));yield one;}finally{closed=true;}}
  await expect(collect(chain('compensationdelay=m=1').process(frames(),{maxFrameBytes:1<<20,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
});
