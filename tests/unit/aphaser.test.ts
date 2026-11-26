import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {aphaser,audioPhaserLengths,audioPhaserTriangle} from '../../packages/avfilter/src/audio/aphaser.js';
import {pcmFilterMemory} from '../../packages/avformat/src/pcm-filter-memory.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>aphaser.parse(text);
type Kind='s16'|'s32'|'flt'|'dbl';
/** Direct transcription of ff_generate_wave_table(WAVE_TRI, AV_SAMPLE_FMT_S32, ..., 1., max, M_PI / 2.0), uint32 arithmetic included. */
function waveTable(size:number,min:number,max:number,phase:number):Int32Array {
  const table=new Int32Array(size),phase_offset=(phase/Math.PI/2*size+0.5)>>>0;
  for(let i=0;i<size;i++){
    const point=((i+phase_offset)>>>0)%size;let d=point*2/size;
    switch(Math.floor(((4*point)>>>0)/size)){case 0:d=d+0.5;break;case 1:case 2:d=1.5-d;break;case 3:d=d-1.5;break;}
    d=d*(max-min)+min;d+=d<0?-0.5:0.5;table[i]=d|0;
  }
  return table;
}
/** Direct transcription of af_aphaser.c: config_output, then PHASER_PLANAR or PHASER (packed) per frame. Samples are JS numbers in the kernel's type. */
function native(text:string,rate:number,channels:number,kind:Kind,planar:boolean,frames:readonly (readonly number[][])[]):number[][][] {
  const s=step(text),delay_buffer_length=Math.trunc(s.delay*0.001*rate+0.5),modulation_buffer_length=Math.trunc(rate/s.speed+0.5);
  const delay_buffer=new Float64Array(delay_buffer_length*channels),modulation_buffer=waveTable(modulation_buffer_length,1.,delay_buffer_length,Math.PI/2.0);
  const MOD=(a:number,b:number)=>a>=b?a-b:a,store=(v:number)=>kind==='flt'?Math.fround(v):kind==='dbl'?v:Math.trunc(v)||0;
  let s_delay_pos=0,s_modulation_pos=0;
  return frames.map(planes=>{
    const nb_samples=planes[0]!.length,out=planes.map(plane=>plane.slice());let delay_pos=0,modulation_pos=0;
    if(planar){
      for(let c=0;c<channels;c++){
        const src=planes[c]!,dst=out[c]!,base=c*delay_buffer_length;delay_pos=s_delay_pos;modulation_pos=s_modulation_pos;
        for(let i=0;i<nb_samples;i++){
          const v=src[i]!*s.inGain+delay_buffer[base+MOD(delay_pos+modulation_buffer[modulation_pos]!,delay_buffer_length)]!*s.decay;
          modulation_pos=MOD(modulation_pos+1,modulation_buffer_length);delay_pos=MOD(delay_pos+1,delay_buffer_length);delay_buffer[base+delay_pos]=v;dst[i]=store(v*s.outGain);
        }
      }
    }else{
      delay_pos=s_delay_pos;modulation_pos=s_modulation_pos;
      for(let i=0;i<nb_samples;i++){
        const pos=MOD(delay_pos+modulation_buffer[modulation_pos]!,delay_buffer_length)*channels;delay_pos=MOD(delay_pos+1,delay_buffer_length);const npos=delay_pos*channels;
        for(let c=0;c<channels;c++){const v=planes[c]![i]!*s.inGain+delay_buffer[pos+c]!*s.decay;delay_buffer[npos+c]=v;out[c]![i]=store(v*s.outGain);}
        modulation_pos=MOD(modulation_pos+1,modulation_buffer_length);
      }
    }
    s_delay_pos=delay_pos;s_modulation_pos=modulation_pos;return out;
  });
}
const widths={s16:2,s32:4,flt:4,dbl:8} as const;
const layout=(channels:number)=>channels===1?'mono':channels===2?'stereo':'unspecified';
function encode(planes:readonly number[][],kind:Kind,planar:boolean,rate:number,pts:bigint|null):AudioFrameData {
  const channels=planes.length,samples=planes[0]!.length,width=widths[kind],data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);
  const set=(at:number,v:number)=>kind==='s16'?view.setInt16(at,v,true):kind==='s32'?view.setInt32(at,v,true):kind==='flt'?view.setFloat32(at,v,true):view.setFloat64(at,v,true);
  for(let c=0;c<channels;c++)for(let i=0;i<samples;i++)set((planar?c*samples+i:i*channels+c)*width,planes[c]![i]!);
  const out=planar?planes.map((_,c)=>data.subarray(c*samples*width,(c+1)*samples*width)):[data];
  return {sampleRate:rate,channels,channelLayout:layout(channels),sampleFormat:(planar?`${kind}p`:kind) as AudioFrameData['sampleFormat'],samples,planes:out,pts:pts===null?null:{value:pts,timeBase:{num:1n,den:BigInt(rate)}}};
}
function decode(frame:AudioFrameData,kind:Kind):number[][] {
  const planar=frame.sampleFormat.endsWith('p'),width=widths[kind];
  return Array.from({length:frame.channels},(_,c)=>Array.from({length:frame.samples},(_,i)=>{
    const plane=frame.planes[planar?c:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),at=(planar?i:i*frame.channels+c)*width;
    return kind==='s16'?view.getInt16(at,true):kind==='s32'?view.getInt32(at,true):kind==='flt'?view.getFloat32(at,true):view.getFloat64(at,true);
  }));
}
function source(kind:Kind,channels:number,total:number):number[][] {
  return Array.from({length:channels},(_,c)=>Array.from({length:total},(_,i)=>{
    const wave=Math.sin(i*0.37+c*1.3)*((i%11)/10);
    return kind==='s16'?Math.round(wave*32767):kind==='s32'?(i%97===0?(i%2?2147483647:-2147483648):Math.round(wave*2147483647)):kind==='flt'?Math.fround(i===0?-0:wave):i===0?-0:wave;
  }));
}
it('parses named and positional options, type=t, and refuses sinusoidal, enable, expressions, clipping gains and out-of-range values with exact messages',()=>{
  expect(step('aphaser')).toEqual({name:'aphaser',inGain:.4,outGain:.74,delay:3,decay:.4,speed:.5});
  expect(step('aphaser=0.3:1:5:0.5:0.1:triangular')).toEqual({name:'aphaser',inGain:.3,outGain:1,delay:5,decay:.5,speed:.1});
  expect(step('aphaser=in_gain=.5:out_gain=0.5:delay=1.5:decay=0.6:speed=2:type=t')).toEqual({name:'aphaser',inGain:.5,outGain:.5,delay:1.5,decay:.6,speed:2});
  expect(step('aphaser=0.5:type=1:decay=0')).toMatchObject({inGain:.5,decay:0});expect(step('aphaser=out_gain=0:in_gain=1:decay=.99').outGain).toBe(0);
  expect(Object.isFrozen(step('aphaser=delay=1'))).toBe(true);
  const refused:[string,string][]=[
    ['aphaser=type=s','aphaser type sinusoidal requires unimplemented libm arithmetic'],['aphaser=type=sinusoidal','aphaser type sinusoidal requires unimplemented libm arithmetic'],['aphaser=0.4:0.74:3:0.4:0.5:0','aphaser type sinusoidal requires unimplemented libm arithmetic'],
    ['aphaser=type=square','Unsupported aphaser type value: square'],['aphaser=enable=1','aphaser timeline enable is not implemented'],['aphaser=foo=1','Unsupported aphaser option: foo'],
    ['aphaser=delay=5.5','aphaser delay is out of range [0 - 5]'],['aphaser=decay=1','aphaser decay is out of range [0 - 0.99]'],['aphaser=speed=0.05','aphaser speed is out of range [0.1 - 2]'],['aphaser=in_gain=1.1','aphaser in_gain is out of range [0 - 1]'],['aphaser=out_gain=2000000000','aphaser out_gain is out of range [0 - 1e+09]'],
    ['aphaser=delay=1e0','Only decimal aphaser delay values are implemented'],['aphaser=in_gain=-0.1','Only decimal aphaser in_gain values are implemented'],['aphaser=speed=1+1','Only decimal aphaser speed values are implemented'],['aphaser=out_gain=','Only decimal aphaser out_gain values are implemented'],
    ['aphaser=in_gain=1:out_gain=1:decay=0.5','aphaser in_gain/(1-decay) above 1/out_gain (out_gain may cause clipping) is not implemented'],['aphaser=out_gain=2','aphaser in_gain/(1-decay) above 1/out_gain (out_gain may cause clipping) is not implemented'],
    ['aphaser=delay=1:0.5','Invalid aphaser option'],['aphaser=1:1:1:0:1:t:7','Invalid aphaser option'],['aphaser=delay=1=2','Invalid aphaser option'],['aphaser=','Unsupported audio filter: aphaser='],['aphaserx','Unsupported audio filter: aphaserx']];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(new RegExp(`^${message.replace(/[[\]+.()/]/g,'\\$&')}$`));expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
  // init()'s condition at and around the bound, evaluated in double exactly as native: 0.5/(1-0.5) = 1 = 1/1 is accepted.
  for(const [text,accepted]of [['in_gain=0.5:out_gain=1:decay=0.5',true],['in_gain=0.5:out_gain=1.0000001:decay=0.5',false],['in_gain=0.01:out_gain=1:decay=0.99',true],['in_gain=0.010001:out_gain=1:decay=0.99',false],['in_gain=1:out_gain=1:decay=0',true],['in_gain=0.25:out_gain=4:decay=0',true],['in_gain=0.3:out_gain=2.5:decay=0.88',false]] as const){
    const s=`aphaser=${text}`,expected=(()=>{const v=Object.fromEntries(text.split(':').map(p=>p.split('=') as [string,string]));return Number(v.in_gain)/(1-Number(v.decay))<=1/Number(v.out_gain);})();
    expect(expected,s).toBe(accepted);if(accepted)expect(()=>step(s),s).not.toThrow();else expect(()=>step(s),s).toThrow('out_gain may cause clipping');
  }
});
it('computes buffer lengths and the triangle table from config_output and ff_generate_wave_table, refusing delays that round to zero',()=>{
  expect(audioPhaserLengths(step('aphaser'),44100)).toEqual({delay:132,modulation:88200});expect(audioPhaserLengths(step('aphaser=delay=0.1:speed=2'),8000)).toEqual({delay:1,modulation:4000});
  expect(audioPhaserLengths(step('aphaser=delay=5:speed=0.1'),8000)).toEqual({delay:40,modulation:80000});expect(audioPhaserLengths(step('aphaser=delay=5:speed=2'),100)).toEqual({delay:1,modulation:50});
  for(const [text,rate]of [['aphaser=delay=0.05',8000],['aphaser=delay=0',44100],['aphaser=delay=0.011',44100]] as const)expect(()=>audioPhaserLengths(step(text),rate),text).toThrow('aphaser delay is too small');
  expect(audioPhaserLengths(step('aphaser=delay=0.0114'),44100).delay).toBe(1);
  for(const rate of [0,8000.5,2147483648])expect(()=>audioPhaserLengths(step('aphaser'),rate)).toThrow('aphaser requires a valid sample rate');
  expect(()=>audioPhaserLengths(step('aphaser=speed=0.1'),2147483647)).toThrow('aphaser modulation buffer length is out of the implemented range');
  for(const [size,max]of [[1,1],[2,1],[3,7],[4,2],[5,3],[7,40],[4000,1],[4001,132],[80000,40],[88200,132],[882001,220],[1234567,221]] as const){
    const table=waveTable(size,1.,max,Math.PI/2.0);let low=Infinity,high=-Infinity;
    for(let i=0;i<size;i++){const v=audioPhaserTriangle(i,size,max);if(v!==table[i])throw new Error(`${size}/${max}/${i}: ${v} vs ${table[i]}`);low=Math.min(low,v);high=Math.max(high,v);}
    // Every entry lies in [1, delay_buffer_length], so MOD(delay_pos + entry, length) needs one subtraction at most.
    expect(low>=1&&high<=max,`${size}/${max}`).toBe(true);
  }
  expect(Array.from({length:8},(_,i)=>audioPhaserTriangle(i,8,5))).toEqual(Array.from(waveTable(8,1,5,Math.PI/2)));
});
it('negotiates the native list, plans unchanged counts and packet sections, and reserves one frame plus the delay rings',()=>{
  const formats=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const;
  const picks=(text:string,hint:'s16'|'s32'|'flt'|'dbl'|'u8')=>formats.map(format=>compileAudioFilterChain(text,{outputSampleFormat:hint}).negotiatedSampleFormats(format).join('/'));
  expect(picks('aphaser','s16')).toEqual(['s16','s16','s32','flt','dbl','s16','s16p','s32p','fltp','dblp']);
  expect(picks('aphaser','s32')).toEqual(['s32','s16','s32','flt','dbl','s32','s16p','s32p','fltp','dblp']);
  expect(picks('aphaser','flt')).toEqual(['flt','s16','s32','flt','dbl','flt','s16p','s32p','fltp','dblp']);
  expect(picks('aphaser','dbl')).toEqual(['dbl','s16','s32','flt','dbl','dbl','s16p','s32p','fltp','dblp']);
  expect(picks('aphaser','u8')).toEqual(['s16','s16','s32','flt','dbl','s16p','s16p','s32p','fltp','dblp']);
  expect(picks('aformat=sample_fmts=s16p,aphaser','flt')).toEqual(Array(10).fill('s16p/s16p'));
  expect(picks('asetnsamples=7,aphaser','s16').map(p=>p.split('/')[1])).toEqual(['s16','s16','s32','flt','dbl','s16','s16p','s32p','fltp','dblp']);
  expect(compileAudioFilterChain('aphaser,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toEqual(['flt','flt']);
  expect(compileAudioFilterChain('aphaser,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats('u8')).toEqual(['flt','flt']);
  for(const format of ['s16','s32','dbl'] as const)expect(()=>compileAudioFilterChain('aphaser,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats(format)).toThrow(`aphaser with ${format} input requires unimplemented format negotiation`);
  const chain=compileAudioFilterChain('aphaser',{outputSampleFormat:'s16'});
  expect(formats.map(format=>chain.requiresScalarRounding(format))).toEqual([false,false,false,true,true,false,false,false,true,true]);
  expect(compileAudioFilterChain('aphaser',{outputSampleFormat:'flt'}).requiresScalarRounding('flt')).toBe(false);
  expect(chain.nativeFormatLists).toBe(true);expect(chain.reframes).toBe(true);expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,formatConstraint:false});
  expect(chain.planSamples(9000n,44100,{channels:2}).samples).toBe(9000n);expect(chain.outputSamples(0n,8000,{channels:1})).toBe(0n);
  expect(chain.packetSections(9000n,1024n,44100,true,2)).toEqual([{samples:9000n,span:1024n}]);
  expect(compileAudioFilterChain('asetnsamples=7,aphaser').packetSections(100n,1024n,8000,true,1)).toEqual([{samples:105n,span:7n}]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  const {reservation,countBuffers}=chain.plannedReservations({sampleRate:44100,channels:2,sampleFormat:'s16'},{samples:9000n,channels:2,configuredInput:true})[0]!;
  expect(reservation).toEqual({frames:1,buffers:[],stateBytes:132n*2n*8n});expect(countBuffers).toEqual([]);
  expect([...compileAudioFilterChain('aphaser=delay=5').reservations({sampleRate:192000,channels:3,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:960n*3n*8n}]);
  const big=compileAudioFilterChain('aphaser=delay=5'),plan={samples:100n,channels:8,configuredInput:true},format={sampleRate:192000,channels:8,sampleFormat:'s16'} as const;
  expect(pcmFilterMemory(big,format,plan,{width:8,maxBufferBytes:1<<20,maxResidentBytes:1<<22})).toBeTruthy();
  expect(()=>pcmFilterMemory(big,format,plan,{width:8,maxBufferBytes:60000,maxResidentBytes:1<<22})).toThrow('Audio filter state exceeds the configured buffer budget');
});
it('refuses rates whose delay rounds to zero in constraint(), before any frame, and accepts every channel count and layout',()=>{
  const chain=compileAudioFilterChain('aphaser=delay=0.05');
  expect(()=>chain.validateInputFormat({sampleRate:8000,channels:1,channelLayout:'mono'})).toThrow('aphaser delay is too small');
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).not.toThrow();
  for(const format of [{sampleRate:8000,channels:1,channelLayout:'mono'},{sampleRate:192000,channels:6,channelLayout:'unspecified'},{sampleRate:44100,channels:2,channelLayout:'2 channels (FL+FC)'}])expect(()=>compileAudioFilterChain('aphaser').validateInputFormat(format)).not.toThrow();
  expect(()=>compileAudioFilterChain('asetrate=4000,aphaser=delay=0.1').validateInputFormat({sampleRate:44100,channels:1,channelLayout:'mono'})).toThrow('aphaser delay is too small');
  expect(()=>compileAudioFilterChain('aphaser=delay=0.05').apply(encode([[1,2]],'s16',false,8000,null),{maxFrameBytes:4096})).toThrow('aphaser delay is too small');
  expect(()=>compileAudioFilterChain('aphaser').apply(encode([[1,2]],'s16',false,8000,null),{maxFrameBytes:4096})).toThrow('aphaser requires stream processing');
});
it('matches the C transcription in every kernel format, packed and planar, across 1/7/29/50-sample splits, keeping timestamps and owning output',async()=>{
  const chains=['aphaser','aphaser=in_gain=0.5:out_gain=1:delay=0.1:decay=0.5:speed=2','aphaser=0.01:1:5:0.99:0.1','aphaser=in_gain=1:out_gain=1:decay=0:delay=1:speed=1.7','aphaser=0.3:0.7:2.2:0.7:0.9:t','aphaser=out_gain=0:in_gain=1'];
  for(const text of chains)for(const kind of ['s16','s32','flt','dbl'] as const)for(const planar of [false,true])for(const channels of [1,2,3]){
    const total=700,rate=8000,src=source(kind,channels,total),reference=native(text,rate,channels,kind,planar,[src])[0]!;
    for(const size of [total,1,7,29,50]){
      const frames:AudioFrameData[]=[],splits:number[][][]=[];
      for(let offset=0;offset<total;offset+=size){const part=src.map(plane=>plane.slice(offset,offset+size));splits.push(part);frames.push(encode(part,kind,planar,rate,BigInt(offset)+3n));}
      const copies=frames.map(f=>f.planes.map(plane=>plane.slice()));
      const output=await collect(compileAudioFilterChain(text,{outputSampleFormat:kind}).process(input(...frames),{maxFrameBytes:1<<20}));
      const label=`${text}/${kind}/${planar}/${channels}/${size}`;
      expect(frames.map(f=>f.planes),label).toEqual(copies);
      expect(output.map(f=>[f.samples,f.pts?.value,f.sampleFormat]),label).toEqual(frames.map(f=>[f.samples,f.pts!.value,f.sampleFormat]));
      expect(output.every(f=>f.planes.every(plane=>!frames.some(i=>i.planes.some(p=>p.buffer===plane.buffer)))),label).toBe(true);
      const joined=Array.from({length:channels},(_,c)=>output.flatMap(f=>decode(f,kind)[c]!));
      for(let c=0;c<channels;c++)expect(joined[c]!.length===total&&joined[c]!.every((v,i)=>Object.is(v,reference[c]![i])),`${label} channel ${c}`).toBe(true);
      expect(output.map(f=>decode(f,kind)),label).toEqual(native(text,rate,channels,kind,planar,splits));
    }
  }
},120000);
it('keeps every integer output at the s32 and s16 extremes in range when the gains sit exactly on the clipping bound',async()=>{
  // Gains on native's bound in double arithmetic (accepted), constant and alternating full-scale input: the steady state approaches the input peak,
  // and every pre-truncation value stays within (-2^31 - 1, 2^31), so C's conversion is defined (docs/contributing/aphaser.md proves the margin).
  const bound=['aphaser=in_gain=0.5:out_gain=1:decay=0.5:delay=0.1:speed=2','aphaser=in_gain=0.01:out_gain=1:decay=0.99:delay=5:speed=0.1','aphaser=in_gain=1:out_gain=1:decay=0','aphaser=in_gain=0.25:out_gain=4:decay=0','aphaser=in_gain=0.1:out_gain=5:decay=0.5:delay=0.2','aphaser=in_gain=0.3:out_gain=1.9047619047619047:decay=0.37'];
  for(const text of bound){
    const s=step(text);expect(s.inGain/(1-s.decay)<=1/s.outGain,text).toBe(true);
    for(const [kind,high,low]of [['s32',2147483647,-2147483648],['s16',32767,-32768]] as const)for(const pattern of ['high','low','alternate','burst'] as const){
      const total=60000,plane=Array.from({length:total},(_,i)=>pattern==='high'?high:pattern==='low'?low:pattern==='alternate'?(i%2?high:low):((i>>9)%2?high:low));
      const reference=native(text,8000,1,kind,true,[[plane]])[0]![0]!;
      // Pre-truncation values from the transcription: rerun with an identity store.
      const sRaw=s,length=Math.trunc(sRaw.delay*0.001*8000+0.5),size=Math.trunc(8000/sRaw.speed+0.5),table=waveTable(size,1,length,Math.PI/2),buffer=new Float64Array(length);let dp=0,mp=0,peak=-Infinity,trough=Infinity;
      for(const x of plane){let r=dp+table[mp]!;if(r>=length)r-=length;const v=x*sRaw.inGain+buffer[r]!*sRaw.decay;mp=mp+1>=size?0:mp+1;dp=dp+1>=length?0:dp+1;buffer[dp]=v;const out=v*sRaw.outGain;peak=Math.max(peak,out);trough=Math.min(trough,out);}
      expect(peak<high+1&&trough>low-1,`${text}/${kind}/${pattern}: ${peak} ${trough}`).toBe(true);
      const [out]=await collect(compileAudioFilterChain(text,{outputSampleFormat:kind}).process(input(encode([plane],kind,true,8000,0n)),{maxFrameBytes:1<<20})) as [AudioFrameData];
      expect(decode(out,kind)[0]!.every((v,i)=>v===reference[i]),`${text}/${kind}/${pattern}`).toBe(true);
    }
  }
},120000);
it('converts u8 input to s16, enforces allocation and format limits, refuses non-finite samples and stops on abort',async()=>{
  const u8={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'u8',samples:3,planes:[Uint8Array.from([0,128,255])],pts:null} as AudioFrameData;
  const [out]=await collect(compileAudioFilterChain('aphaser=in_gain=1:out_gain=1:decay=0',{outputSampleFormat:'s16'}).process(input(u8),{maxFrameBytes:4096})) as [AudioFrameData];
  expect(out.sampleFormat).toBe('s16');expect(decode(out,'s16')).toEqual([[-32768,0,32512]]);
  const one=encode([[1,2,3,4],[5,6,7,8]],'dbl',true,192000,0n),chain=(text:string)=>compileAudioFilterChain(text,{outputSampleFormat:'dbl'});
  // delay=5 at 192000 Hz: 960 doubles per channel.
  await expect(collect(chain('aphaser=delay=5').process(input(one),{maxFrameBytes:15359}))).rejects.toThrow('aphaser delay buffer exceeds allocation limit');
  expect((await collect(chain('aphaser=delay=5').process(input(one),{maxFrameBytes:15360}))).length).toBe(1);
  await expect(collect(chain('aphaser').process(input(encode([Array(100).fill(0)],'dbl',true,8000,0n)),{maxFrameBytes:799}))).rejects.toThrow(/allocation limit/);
  await expect(collect(aphaser.stream!(step('aphaser'),input(one),{maxFrameBytes:0},undefined,()=>'dblp'))).rejects.toThrow('Invalid aphaser allocation limit');
  await expect(collect(aphaser.stream!(step('aphaser'),input(one),{maxFrameBytes:4096},undefined,()=>'u8p'))).rejects.toThrow('aphaser cannot work in u8p');
  await expect(collect(aphaser.stream!(step('aphaser'),input(one,encode([[1],[2]],'dbl',true,96000,4n)),{maxFrameBytes:65536},undefined,()=>'dblp'))).rejects.toThrow('aphaser requires a stable input format');
  await expect(collect(aphaser.stream!(step('aphaser'),input(one,encode([[1],[2]],'dbl',false,192000,4n)),{maxFrameBytes:65536},undefined,f=>f))).rejects.toThrow('aphaser requires a stable input format');
  for(const bad of [NaN,Infinity,-Infinity])await expect(collect(chain('aphaser').process(input(encode([[0,bad]],'dbl',false,8000,0n)),{maxFrameBytes:4096}))).rejects.toThrow('Non-finite aphaser samples are not yet supported');
  await expect(collect(chain('aphaser=in_gain=1:out_gain=1:decay=0').process(input(encode([[1.7976931348623157e308,-1.7976931348623157e308]],'dbl',false,8000,0n)),{maxFrameBytes:4096}))).resolves.toHaveLength(1);
  await expect((async()=>collect(chain('aphaser').process(input(),{maxFrameBytes:64})))()).rejects.toThrow('aphaser constraints require a configured empty input format');
  expect(await collect(chain('aphaser').process(input(),{maxFrameBytes:64,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}}))).toEqual([]);
  await expect((async()=>collect(chain('aphaser=delay=0.05').process(input(),{maxFrameBytes:64,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}})))()).rejects.toThrow('aphaser delay is too small');
  const controller=new AbortController();let closed=false;async function* frames(){try{yield one;controller.abort(new Error('stop'));yield one;}finally{closed=true;}}
  await expect(collect(chain('aphaser').process(frames(),{maxFrameBytes:1<<20,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  const early=new AbortController();early.abort(new Error('early'));
  await expect(collect(chain('aphaser').process(input(one),{maxFrameBytes:1<<20,signal:early.signal}))).rejects.toThrow('early');
});
