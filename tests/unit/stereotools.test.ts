import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {stereotools,stereoToolsRing} from '../../packages/avfilter/src/audio/stereotools.js';
import type {AudioStereoToolsStep} from '../../packages/avfilter/src/audio/stereotools.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>|(()=>AsyncIterable<AudioFrameData>)){if(typeof frames==='function')frames=frames();const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>stereotools.parse(text);
const FFMIN=(a:number,b:number)=>a>b?b:a,FFMAX=(a:number,b:number)=>a>b?a:b;
/** Direct transcription of af_stereotools.c config_input + filter_frame with softclip=0 and phase=0 (cos 1, sin 0). */
function reference(s:AudioStereoToolsStep,rate:number,src:Float64Array):Float64Array {
  const length=Math.ceil(Math.floor((rate+9)/10)/2)*2,buffer=new Float64Array(length),dst=new Float64Array(src.length);
  const sb=s.base<0?s.base*0.5:s.base,sbal=1+s.sbal,mpan=1+s.mpan,phase_cos_coef=Math.cos(0/180*Math.PI),phase_sin_coef=Math.sin(0/180*Math.PI);
  const mute_l=+s.muteL,mute_r=+s.muteR,phase_l=+s.phaseL,phase_r=+s.phaseR;
  let nbuf=Math.trunc(rate*(Math.abs(s.delay)/1000.)),pos=0;
  nbuf-=nbuf%2;
  for(let n=0;n<src.length/2;n++){
    let L=src[2*n]!,R=src[2*n+1]!,l=0,r=0,m=0,S=0,gl=0,gr=0,gd=0;
    L*=s.levelIn;R*=s.levelIn;
    gl=1.-FFMAX(0.,s.balanceIn);gr=1.+FFMIN(0.,s.balanceIn);
    switch(s.bmodeIn){case 1:gd=gl-gr;gl=1.+gd;gr=1.-gd;break;case 2:if(s.balanceIn<0.){gr=FFMAX(0.5,gr);gl=1./gr;}else if(s.balanceIn>0.){gl=FFMAX(0.5,gl);gr=1./gl;}break;}
    L*=gl;R*=gr;
    switch(s.mode){
      case 0:m=(L+R)*0.5;S=(L-R)*0.5;l=m*s.mlev*FFMIN(1.,2.-mpan)+S*s.slev*FFMIN(1.,2.-sbal);r=m*s.mlev*FFMIN(1.,mpan)-S*s.slev*FFMIN(1.,sbal);L=l;R=r;break;
      case 1:l=L*FFMIN(1.,2.-sbal);r=R*FFMIN(1.,sbal);L=0.5*(l+r)*s.mlev;R=0.5*(l-r)*s.slev;break;
      case 2:l=L*s.mlev*FFMIN(1.,2.-mpan)+R*s.slev*FFMIN(1.,2.-sbal);r=L*s.mlev*FFMIN(1.,mpan)-R*s.slev*FFMIN(1.,sbal);L=l;R=r;break;
      case 3:R=L;break;
      case 4:L=R;break;
      case 5:L=(L+R)*0.5;R=L;break;
      case 6:l=L;L=R;R=l;m=(L+R)*0.5;S=(L-R)*0.5;l=m*s.mlev*FFMIN(1.,2.-mpan)+S*s.slev*FFMIN(1.,2.-sbal);r=m*s.mlev*FFMIN(1.,mpan)-S*s.slev*FFMIN(1.,sbal);L=l;R=r;break;
      case 7:l=L*s.mlev*FFMIN(1.,2.-mpan)+R*s.slev*FFMIN(1.,2.-sbal);L=l;R=l;break;
      case 8:r=L*s.mlev*FFMIN(1.,mpan)-R*s.slev*FFMIN(1.,sbal);L=r;R=r;break;
      case 9:l=L*s.mlev*FFMIN(1.,2.-mpan)+R*s.slev*FFMIN(1.,2.-sbal);r=L*s.mlev*FFMIN(1.,mpan)-R*s.slev*FFMIN(1.,sbal);L=r;R=l;break;
      case 10:L=(L-R)*0.5;R=L;break;
    }
    L*=1.-mute_l;R*=1.-mute_r;
    L*=(2.*(1.-phase_l))-1.;R*=(2.*(1.-phase_r))-1.;
    buffer[pos]=L;buffer[pos+1]=R;
    if(s.delay>0.)R=buffer[(pos-nbuf+1+length)%length]!;else if(s.delay<0.)L=buffer[(pos-nbuf+length)%length]!;
    l=L+sb*L-sb*R;r=R+sb*R-sb*L;L=l;R=r;
    l=L*phase_cos_coef-R*phase_sin_coef;r=L*phase_sin_coef+R*phase_cos_coef;L=l;R=r;
    pos=(pos+2)%length;
    gl=1.-FFMAX(0.,s.balanceOut);gr=1.+FFMIN(0.,s.balanceOut);
    switch(s.bmodeOut){case 1:gd=gl-gr;gl=1.+gd;gr=1.-gd;break;case 2:if(s.balanceOut<0.){gr=FFMAX(0.5,gr);gl=1./gr;}else if(s.balanceOut>0.){gl=FFMAX(0.5,gl);gr=1./gl;}break;}
    L*=gl;R*=gr;L*=s.levelOut;R*=s.levelOut;
    dst[2*n]=L;dst[2*n+1]=R;
  }
  return dst;
}
const doubles=(frames:readonly AudioFrameData[])=>Float64Array.from(frames.flatMap(frame=>Array.from(new Float64Array(frame.planes[0]!.slice().buffer))));
function frames(samples:Float64Array,sizes:readonly number[],rate:number):AudioFrameData[] {
  const result:AudioFrameData[]=[];let offset=0;
  for(const size of sizes){result.push({sampleRate:rate,channels:2,channelLayout:'stereo',sampleFormat:'dbl',samples:size,planes:[new Uint8Array(samples.slice(offset*2,(offset+size)*2).buffer)],pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}});offset+=size;}
  return result;
}
const modes=['lr>lr','lr>ms','ms>lr','lr>ll','lr>rr','lr>l+r','lr>rl','ms>ll','ms>rr','ms>rl','lr>l-r'];
it('parses named and positional options with native defaults, constants and ranges, and refuses everything else with exact messages',()=>{
  expect(step('stereotools')).toEqual({name:'stereotools',levelIn:1,levelOut:1,balanceIn:0,balanceOut:0,softclip:false,muteL:false,muteR:false,phaseL:false,phaseR:false,mode:0,slev:1,sbal:0,mlev:1,mpan:0,base:0,delay:0,scLevel:1,phase:0,bmodeIn:0,bmodeOut:0});
  expect(Object.isFrozen(step('stereotools=mode=1'))).toBe(true);
  for(const [index,name]of modes.entries()){expect(step(`stereotools=mode=${name}`).mode,name).toBe(index);expect(step(`stereotools=mode=${index}`).mode).toBe(index);}
  expect(step('stereotools=bmode_in=balance:bmode_out=power')).toMatchObject({bmodeIn:0,bmodeOut:2});expect(step('stereotools=bmode_in=amplitude:bmode_out=+1')).toMatchObject({bmodeIn:1,bmodeOut:1});
  expect(step('stereotools=mutel=YES:muter=off:phasel=On:phaser=1:softclip=0')).toMatchObject({muteL:true,muteR:false,phaseL:true,phaseR:true,softclip:false});
  expect(step('stereotools=0.5:2:-0.25:1:0:1:0:0:1:lr>rl:3:0.1:0.2:-0.3:0.4:-5:50:0:power:amplitude')).toEqual({name:'stereotools',levelIn:0.5,levelOut:2,balanceIn:-0.25,balanceOut:1,softclip:false,muteL:true,muteR:false,phaseL:false,phaseR:true,mode:6,slev:3,sbal:0.1,mlev:0.2,mpan:-0.3,base:0.4,delay:-5,scLevel:50,phase:0,bmodeIn:2,bmodeOut:1});
  expect(step('stereotools=2:slev=.5:delay=-2e1:sclevel=100:phase=0.0:mode=-0')).toMatchObject({levelIn:2,slev:0.5,delay:-20,scLevel:100,phase:0,mode:0});
  expect(Object.is(step('stereotools=mode=-0:bmode_in=-0').mode,0)).toBe(true);
  expect(step('stereotools=level_in=0.015625:level_out=64:base=-1:delay=20:sbal=1:mpan=-1')).toMatchObject({levelIn:0.015625,levelOut:64,base:-1,delay:20,sbal:1,mpan:-1});
  const refused:[string,string][]=[
    ['stereotools=softclip=1','stereotools softclip requires unimplemented libm arithmetic'],['stereotools=softclip=true:sclevel=4','stereotools softclip requires unimplemented libm arithmetic'],
    ['stereotools=phase=90','stereotools phase requires unimplemented libm arithmetic'],['stereotools=phase=360','stereotools phase requires unimplemented libm arithmetic'],['stereotools=phase=1e-300','stereotools phase requires unimplemented libm arithmetic'],
    ['stereotools=phase=360.5','Value 360.5 for stereotools option phase out of range [0 - 360]'],['stereotools=phase=-1','Value -1 for stereotools option phase out of range [0 - 360]'],
    ['stereotools=level_in=0','Value 0 for stereotools option level_in out of range [0.015625 - 64]'],['stereotools=level_out=64.5','Value 64.5 for stereotools option level_out out of range [0.015625 - 64]'],
    ['stereotools=balance_in=-1.01','Value -1.01 for stereotools option balance_in out of range [-1 - 1]'],['stereotools=delay=20.001','Value 20.001 for stereotools option delay out of range [-20 - 20]'],
    ['stereotools=sclevel=0.5','Value 0.5 for stereotools option sclevel out of range [1 - 100]'],['stereotools=slev=1e400','Value 1e400 for stereotools option slev out of range [0.015625 - 64]'],
    ['stereotools=mode=11','Value 11 for stereotools option mode out of range [0 - 10]'],['stereotools=bmode_out=-1','Value -1 for stereotools option bmode_out out of range [0 - 2]'],
    ['stereotools=mode=LR>LR','Only lr>lr, lr>ms, ms>lr, lr>ll, lr>rr, lr>l+r, lr>rl, ms>ll, ms>rr, ms>rl, lr>l-r or an integer are implemented for stereotools option mode'],
    ['stereotools=bmode_in=1.5','Only balance, amplitude, power or an integer are implemented for stereotools option bmode_in'],
    ['stereotools=mutel=auto','Unable to parse stereotools option mutel value auto as boolean'],['stereotools=phaser=2','Unable to parse stereotools option phaser value 2 as boolean'],['stereotools=muter=0.5','Only 0, 1 and boolean names are implemented for stereotools option muter'],
    ['stereotools=mlev=1+1','Only constant decimal values are implemented for stereotools option mlev'],['stereotools=base=nan','Only constant decimal values are implemented for stereotools option base'],['stereotools=mpan=','Only constant decimal values are implemented for stereotools option mpan'],
    ['stereotools=enable=1','stereotools timeline enable is not implemented'],["stereotools=enable='between(t,0,1)'",'Quoted or escaped stereotools options are not implemented'],
    ['stereotools=foo=1','Unsupported stereotools option: foo'],['stereotools=level_in=1:2','No stereotools option name near 2'],[`stereotools=${Array(21).fill('1').join(':')}`,'Too many stereotools option values near 1'],
    ["stereotools=level_in='1'",'Quoted or escaped stereotools options are not implemented'],['stereotools=','Unsupported audio filter: stereotools='],['stereotoolsx','Unsupported audio filter: stereotoolsx']];
  for(const [text,message]of refused){expect(()=>step(text),text).toThrow(AudioFilterError);expect(()=>step(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('stereotools=phase=90')).toThrow('stereotools phase requires unimplemented libm arithmetic');
});
it('sizes the ring as config_input does and truncates nbuf to an even sample count',()=>{
  const ring=(text:string,rate:number)=>stereoToolsRing(step(text),rate);
  // FFALIGN((rate+9)/10, 2): 8000 -> 800, 44100 -> 4410, 1 -> 2, 11025 -> 1104 (1103 aligned up).
  expect(ring('stereotools',8000)).toEqual({length:800,nbuf:0});expect(ring('stereotools',44100)).toEqual({length:4410,nbuf:0});expect(ring('stereotools',1)).toEqual({length:2,nbuf:0});expect(ring('stereotools',11025).length).toBe(1104);
  // 3 ms: 24 at 8000 Hz, 132.3 -> 132 at 44100 Hz; 20 ms: 160 and 882; 0.3 ms at 44100 Hz is 13.23 -> 13 -> 12.
  expect(ring('stereotools=delay=3',8000).nbuf).toBe(24);expect(ring('stereotools=delay=-3',44100).nbuf).toBe(132);expect(ring('stereotools=delay=20',8000).nbuf).toBe(160);expect(ring('stereotools=delay=-20',44100).nbuf).toBe(882);
  expect(ring('stereotools=delay=0.3',44100).nbuf).toBe(12);expect(ring('stereotools=delay=0.01',8000).nbuf).toBe(0);
  for(const rate of [0,-1,8000.5,2147483648])expect(()=>ring('stereotools',rate)).toThrow('Invalid stereotools sample rate');
});
it('pins dbl for every input format, refuses non-stereo layouts and plans an unchanged count with the ring reservation',()=>{
  const chain=compileAudioFilterChain('stereotools=delay=3');
  expect(chain.nativeFormatLists).toBe(true);
  for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as AudioSampleFormat[])expect(chain.negotiatedSampleFormats(format),format).toEqual(['dbl']);
  for(const format of ['u8','s16','s32','flt'] as AudioSampleFormat[])expect(compileAudioFilterChain('stereotools',{outputSampleFormat:format}).requiresScalarRounding(format),format).toBe(format!=='flt');
  expect(compileAudioFilterChain('stereotools',{outputSampleFormat:'dbl'}).requiresScalarRounding('dbl')).toBe(false);
  expect(compileAudioFilterChain('stereotools,aformat=fltp').negotiatedSampleFormats('s16')).toEqual(['dbl','fltp']);
  expect(chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).toBeUndefined();
  for(const format of [{sampleRate:44100,channels:1,channelLayout:'mono'},{sampleRate:44100,channels:3,channelLayout:'unspecified'},{sampleRate:44100,channels:2,channelLayout:'2 channels (FL+FC)'},{sampleRate:44100,channels:2,channelLayout:'downmix'}])
    expect(()=>chain.validateInputFormat(format),format.channelLayout).toThrow(`stereotools requires stereo input; ${format.channelLayout} would be remixed implicitly`);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('sample rate conversion');
  expect(chain.planSamples(1234n,8000,{channels:2}).samples).toBe(1234n);expect(chain.outputSamples(0n,8000,{channels:2})).toBe(0n);
  expect(chain.packetSections(5000n,1024n,8000,false,2)).toEqual([{samples:5000n,span:1024n}]);
  const [entry]=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:5000n,channels:2});
  expect(entry!.reservation).toEqual({frames:1,buffers:[],stateBytes:800n*8n});expect(entry!.countBuffers).toEqual([]);
  expect([...compileAudioFilterChain('stereotools').reservations({sampleRate:44100,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:4410n*8n}]);
  expect(()=>chain.apply(frames(new Float64Array(2),[1],8000)[0]!,{maxFrameBytes:64})).toThrow('stereotools requires stream processing');
});
it('matches a transcription of the C loop for every mode and option family, identical for 1/7/29/50-sample splits, without touching its input',async()=>{
  const total=1200,source=Float64Array.from({length:total*2},(_,i)=>i===0?-0:i===3?-0:Math.sin(i*0.37)*((i%17)/16)*1.5);
  const tokens=[...modes.map(mode=>`stereotools=mode=${mode}`),...modes.map(mode=>`stereotools=mode=${mode}:slev=3:sbal=-0.4:mlev=0.25:mpan=0.7:base=0.3`),
    ...['balance','amplitude','power'].flatMap(b=>[-1,-0.4,0,0.4,1].map(v=>`stereotools=bmode_in=${b}:balance_in=${v}:bmode_out=${b}:balance_out=${-v}`)),
    'stereotools=mutel=1','stereotools=muter=1:phasel=1','stereotools=phaser=1:phasel=1','stereotools=base=-1','stereotools=base=1','stereotools=sbal=1:mpan=-1:slev=64:mlev=0.015625',
    ...[-20,-3,-0.01,0.01,3,20].map(d=>`stereotools=delay=${d}`),'stereotools=delay=-7:base=-0.5:mode=ms>rl','stereotools=level_in=3:level_out=0.25:sclevel=7',...stereotools.examples];
  let compared=0;
  for(const rate of [100,8000,44100])for(const token of tokens){
    const expected=reference(step(token),rate,source),chain=compileAudioFilterChain(token);
    for(const sizes of [[total],Array(total).fill(1),[...Array(171).fill(7),3],[...Array(41).fill(29),11],Array(24).fill(50)]){
      const inputs=frames(source,sizes,rate),copies=inputs.map(frame=>frame.planes[0]!.slice());
      const output=await collect(chain.process(input(...inputs),{maxFrameBytes:1<<16}));
      expect(output.map(frame=>frame.samples),`${token} ${rate}`).toEqual(sizes);
      expect(output.map(frame=>frame.pts),`${token} pts`).toEqual(inputs.map(frame=>frame.pts));
      const got=doubles(output);
      expect(got.length===expected.length&&got.every((value,index)=>Object.is(value,expected[index])),`${token} ${rate} ${sizes.length}`).toBe(true);
      expect(inputs.map(frame=>frame.planes[0]),`${token} input untouched`).toEqual(copies);
      for(const [index,frame]of output.entries())expect(frame.planes[0]!.buffer,`${token} owned`).not.toBe(inputs[index]!.planes[0]!.buffer);
      compared++;
    }
  }
  expect(compared).toBe(3*tokens.length*5);
  // Non-dbl input is converted to the negotiated dbl first: s16 into the chain equals the reference on s16/32768.
  const s16=new Int16Array(400).map((_,i)=>(i*997)%65536-32768),frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:200,planes:[new Uint8Array(s16.buffer)],pts:null};
  const [converted]=await collect(compileAudioFilterChain('stereotools=delay=1:mode=ms>lr').process(input(frame),{maxFrameBytes:1<<16}));
  expect(converted!.sampleFormat).toBe('dbl');expect(doubles([converted!])).toEqual(reference(step('stereotools=delay=1:mode=ms>lr'),8000,Float64Array.from(s16,value=>value/32768)));
  // An unaligned dbl plane is processed through a copy.
  const backing=new Uint8Array(8*16+1),unaligned=backing.subarray(1);unaligned.set(new Uint8Array(source.slice(0,16).buffer));
  const [shifted]=await collect(compileAudioFilterChain('stereotools=mode=ms>lr').process(input({...frames(source,[8],8000)[0]!,planes:[unaligned]}),{maxFrameBytes:1<<16}));
  expect(doubles([shifted!])).toEqual(reference(step('stereotools=mode=ms>lr'),8000,source.slice(0,16)));
},300000);
it('refuses non-stereo frames, rate changes, non-finite samples, oversized rings and frames, emits nothing for empty input and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('stereotools=delay=3'),one=(rate:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({...frames(new Float64Array(8),[4],rate)[0]!,...extra});
  const empty={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16' as const,pts:null};
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16,inputFormat:empty}))).toEqual([]);
  await expect(collect(()=>chain.process(input(),{maxFrameBytes:1<<16,inputFormat:{...empty,channels:1,channelLayout:'mono'}}))).rejects.toThrow('stereotools requires stereo input; mono would be remixed implicitly');
  await expect(collect(()=>chain.process(input(),{maxFrameBytes:1<<16}))).rejects.toThrow('stereotools constraints require a configured empty input format');
  await expect(collect(()=>chain.process(input(one(8000,{channels:1,channelLayout:'mono',planes:[new Uint8Array(32)]})),{maxFrameBytes:1<<16}))).rejects.toThrow('stereotools requires stereo input');
  await expect(collect(()=>chain.process(input(one(8000,{channelLayout:'2 channels (FL+FC)'})),{maxFrameBytes:1<<16}))).rejects.toThrow('stereotools requires stereo input');
  await expect(collect(()=>chain.process(input(one(8000),one(16000)),{maxFrameBytes:1<<16}))).rejects.toThrow('stereotools sample rate changed between frames');
  for(const bad of [Infinity,-Infinity,NaN])
    await expect(collect(()=>chain.process(input({...one(8000),planes:[new Uint8Array(Float64Array.of(0,0,bad,0,0,0,0,0).buffer)]}),{maxFrameBytes:1<<16}))).rejects.toThrow('Non-finite stereotools input is not yet supported');
  // Finite overflow: 1e308*64 is Infinity, and Inf-Inf in the M/S mix is NaN.
  await expect(collect(()=>compileAudioFilterChain('stereotools=level_in=64').process(input({...one(8000),planes:[new Uint8Array(Float64Array.of(1e308,-1e308,0,0,0,0,0,0).buffer)]}),{maxFrameBytes:1<<16}))).rejects.toThrow('NaN stereotools output is not yet supported');
  // 44100 Hz needs a 4410-double ring (35280 bytes), allocated whatever the delay.
  await expect(collect(()=>compileAudioFilterChain('stereotools').process(input(one(44100)),{maxFrameBytes:35279}))).rejects.toThrow('stereotools delay buffer exceeds allocation limit');
  expect((await collect(compileAudioFilterChain('stereotools').process(input(one(44100)),{maxFrameBytes:35280}))).length).toBe(1);
  await expect(collect(()=>compileAudioFilterChain('stereotools').process(input(...frames(new Float64Array(1200),[600],8000)),{maxFrameBytes:9599}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  const controller=new AbortController();controller.abort();
  await expect(collect(()=>chain.process(input(one(8000)),{maxFrameBytes:1<<16,signal:controller.signal}))).rejects.toThrow();
  const late=new AbortController();let yielded=0;
  await expect((async()=>{for await(const frame of chain.process(input(one(8000),one(8000)),{maxFrameBytes:1<<16,signal:late.signal})){yielded+=frame.samples>0?1:0;late.abort();}})()).rejects.toThrow();
  expect(yielded).toBe(1);
});
