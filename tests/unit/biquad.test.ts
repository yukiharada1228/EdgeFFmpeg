import {expect,it} from 'vitest';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {biquad,parseAudioBiquad} from '../../packages/avfilter/src/audio/biquad.js';
import type {AudioBiquadStep} from '../../packages/avfilter/src/audio/biquad.js';
import {biquadKernel,biquadLattice,biquadStateVariable,normalizeBiquad,prepareBiquad} from '../../packages/avfilter/src/audio/biquad-kernels.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const refuse=(text:string,message:string)=>{expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`));};
const lowpass='a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675';
it('parses named, aliased and positional options with native defaults and prepares coefficients in native order',()=>{
  const step=parseAudioBiquad(`biquad=${lowpass}:a=dii`);
  expect(step).toEqual({name:'biquad',a:[1,-1.143,0.4128],b:[0.0675,0.135,0.0675],mix:1,normalize:false,transform:'dii',precision:'auto',coefficients:{a:[1,-1.143,0.4128],b:[0.0675,0.135,0.0675]}});
  expect(Object.isFrozen(step)).toBe(true);expect(compileAudioFilterChain(`biquad=${lowpass}:a=dii`).steps[0]).toEqual(step);
  // Positional values follow biquad_options: a0 a1 a2 b0 b1 b2 mix channels normalize transform precision blocksize; a named option may follow them.
  expect(parseAudioBiquad('biquad=2:-1:0.4:1:0.5:0.25:0.5:all:1:tdii:s32:0')).toMatchObject({a:[2,-1,0.4],b:[1,0.5,0.25],mix:0.5,normalize:true,transform:'tdii',precision:'s32'});
  expect(parseAudioBiquad('biquad=1:-0.5:b0=1:m=0.25:n=true:a=3:r=-1')).toMatchObject({a:[1,-0.5,0],b:[1,0,0],mix:0.25,normalize:true,transform:'tdii',precision:'auto'});
  expect(['1','2','3','4','5','6'].map(value=>parseAudioBiquad(`biquad=a0=0.5:a2=0.25:b0=1:a=${value}`).transform)).toEqual(['dii','tdi','tdii','latt','svf','zdf']);
  expect(['0','1','2','3','-1','s16','s32','f32','f64','auto'].map(value=>parseAudioBiquad(`biquad=b0=1:a=dii:precision=${value}`).precision)).toEqual(['s16','s32','f32','f64','auto','s16','s32','f32','f64','auto']);
  expect(parseAudioBiquad('biquad=b0=1:a=dii:c=all:channels=all:b=0:blocksize=0:normalize=false:n=0:mix=1e-1:b1=-2147483648:b2=2147483647').mix).toBe(0.1);
  // a0 division, then normalize (sum a / sum b), then latt/svf conversion; zdf keeps the raw option values.
  const a=[2,-1.5,0.5] as const,b=[1,0.5,0.25] as const;
  expect(normalizeBiquad(a,b,false)).toEqual({a:[1,-0.75,0.25],b:[0.5,0.25,0.125]});
  const factor=(1-0.75+0.25)/(0.5+0.25+0.125);expect(normalizeBiquad(a,b,true)).toEqual({a:[1,-0.75,0.25],b:[0.5*factor,0.25*factor,0.125*factor]});
  expect(normalizeBiquad([1,0.2,0.1],[0.5,-0.5,0.0000005],true).b).toEqual([0.5,-0.5,0.0000005]);
  const d={a:[1,-0.75,0.25],b:[0.5,0.25,0.125]} as const,k0=-0.75/1.25,v1=0.25-0.125*-0.75;
  expect(biquadLattice(d)).toEqual({a:[1,k0,0.25],b:[0.5-v1*k0-0.125*0.25,v1,0.125]});
  expect(biquadStateVariable(d)).toEqual({a:[1,0.75,-0.25],b:[0.25+0.75*0.5,0.125-0.25*0.5,0.5]});
  expect(prepareBiquad(a,b,true,'zdf')).toEqual({a:[2,-1.5,0.5],b:[1,0.5,0.25]});expect(prepareBiquad(a,b,false,'latt')).toEqual(biquadLattice(d));
});
it('refuses native errors and unimplemented forms with exact messages',()=>{
  const di='biquad transform di depends on native frame boundaries, which are not implemented';
  refuse('biquad',di);refuse(`biquad=${lowpass}`,di);refuse(`biquad=${lowpass}:a=di`,di);refuse(`biquad=${lowpass}:transform=0`,di);
  refuse(`biquad=${lowpass}:a=dii:blocksize=64`,'biquad blocksize is not implemented');refuse(`biquad=${lowpass}:a=dii:b=1`,'biquad blocksize is not implemented');
  refuse(`biquad=${lowpass}:a=dii:b=40000`,'biquad blocksize is out of range [0, 32768]');refuse(`biquad=${lowpass}:a=dii:b=-1`,'Only constant integer biquad blocksize values are implemented');
  refuse(`biquad=${lowpass}:a=dii:c=FL`,'biquad channels other than all are not implemented');refuse(`biquad=${lowpass}:a=dii:channels=stereo`,'biquad channels other than all are not implemented');
  refuse(`biquad=a0=0:${lowpass}:a=dii`,'biquad a0 must not be zero');refuse('biquad=a0=-0:b0=1:a=tdii','biquad a0 must not be zero');
  const unstable='biquad coefficients outside the stability triangle are not implemented';
  for(const set of ['a1=-2:a2=1','a1=0.5:a2=-1.2','a1=-1.6:a2=0.5','a1=1.5:a2=0.5','a1=0:a2=1','a0=2:a1=-3.4:a2=1.2','a1=-1.9999999999:a2=0.99999999999'])refuse(`biquad=${set}:b0=1:a=tdii`,unstable);
  // zdf runs its state matrix on the raw a values: a stable direct form can still diverge there.
  refuse(`biquad=${lowpass}:a=zdf`,unstable);expect(()=>parseAudioBiquad(`biquad=${lowpass}:a=svf`)).not.toThrow();
  refuse('biquad=a0=1e-30:b0=2000000000:a=dii','biquad coefficients exceed the float range');
  refuse(`biquad=${lowpass}:a=dii:enable=1`,'biquad timeline enable is not implemented');refuse('biquad=enable=between(t\\,0\\,1)','biquad timeline enable is not implemented');
  refuse(`biquad=${lowpass}:a=dii:foo=1`,'Unsupported biquad option: foo');refuse('biquadx','Unsupported audio filter: biquadx');
  refuse('biquad=1:0:0:1:0:0:1:all:0:1:-1:0:9','Invalid biquad option');refuse('biquad=a1=0.5:0.3','Invalid biquad option');
  refuse('biquad=b0=3000000000:a=dii','biquad b0 is out of range [-2147483648, 2147483647]');refuse('biquad=a1=-2147483649:a=dii','biquad a1 is out of range [-2147483648, 2147483647]');
  refuse('biquad=b0=1:mix=1.5:a=dii','biquad mix is out of range [0, 1]');refuse('biquad=b0=1:m=-0.1:a=dii','biquad mix is out of range [0, 1]');
  for(const value of ['-1/2','PI','0x10','1k','','inf','nan'])refuse(`biquad=a1=${value}:b0=1:a=dii`,'Only constant decimal biquad a1 values are implemented');
  refuse('biquad=b0=1:a=dii:n=yes','Unsupported biquad normalize value: yes');refuse('biquad=b0=1:a=foo','Unsupported biquad transform: foo');refuse('biquad=b0=1:a=7','Unsupported biquad transform: 7');
  refuse('biquad=b0=1:a=dii:r=s8','Unsupported biquad precision: s8');refuse('biquad=b0=1:a=dii:r=4','Unsupported biquad precision: 4');refuse('biquad=b0=1:a=dii:r=2+1','Unsupported biquad precision: 2+1');
});
it('negotiates the automatic list and pinned precisions, refuses rate conversion and plans one frame plus the per-channel cache',()=>{
  const inputs=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const;
  const picks=(precision:string)=>{const chain=compileAudioFilterChain(`biquad=${lowpass}:a=dii:r=${precision}`,{outputSampleFormat:'s16'});return inputs.map(format=>chain.negotiatedSampleFormats(format)[0]);};
  expect(picks('auto')).toEqual(['s16p','s16p','s32p','fltp','dblp','s16p','s16p','s32p','fltp','dblp']);
  for(const [precision,format]of [['s16','s16p'],['s32','s32p'],['f32','fltp'],['f64','dblp']] as const)expect(picks(precision)).toEqual(inputs.map(()=>format));
  expect(compileAudioFilterChain(`biquad=${lowpass}:a=dii,volume=0.5`,{outputSampleFormat:'s16'}).negotiatedSampleFormats('s16')).toEqual(['fltp','flt']);
  const auto=compileAudioFilterChain(`biquad=${lowpass}:a=dii`,{outputSampleFormat:'s16'});
  expect(inputs.map(format=>auto.requiresScalarRounding(format))).toEqual([false,false,false,true,true,false,false,false,true,true]);
  expect(compileAudioFilterChain(`biquad=${lowpass}:a=dii:r=s16`,{outputSampleFormat:'s16'}).requiresScalarRounding('flt')).toBe(true);
  expect(compileAudioFilterChain(`biquad=${lowpass}:a=dii:r=f64`,{outputSampleFormat:'dbl'}).requiresScalarRounding('s16')).toBe(false);
  expect([auto.nativeFormatLists,auto.reframes,auto.has('generatesOutput'),auto.capabilities[0]!.stateless,auto.capabilities[0]!.rateConversion,audioFilterCapabilities(auto.steps[0]!).flacInput,auto.capabilities[0]!.timeSelection,auto.capabilities[0]!.allocatesFrames]).toEqual([true,true,false,false,false,false,false,true]);
  expect(()=>auto.rateBoundary('s16',8000,16000)).toThrow(/^biquad with sample rate conversion is not implemented$/);
  expect(()=>auto.apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null},{maxFrameBytes:64})).toThrow('biquad requires stream processing');
  // No constraint: every rate, channel count and layout runs as native does.
  for(const format of [{sampleRate:8000,channels:1,channelLayout:'mono'},{sampleRate:44100,channels:3,channelLayout:'unspecified'},{sampleRate:96000,channels:2,channelLayout:'2 channels (FL+FC)'}])expect(()=>auto.validateInputFormat(format)).not.toThrow();
  // Counts and packets pass through unchanged.
  expect(auto.outputSamples(1000n,8000,{channels:2})).toBe(1000n);expect(auto.packetSections(1000n,512n,8000,true,2)).toEqual([{samples:1000n,span:512n}]);
  expect(auto.planSamples(13n,8000).stages.at(-1)).toMatchObject({inputSamples:13n,outputSamples:13n});
  expect(compileAudioFilterChain(`asetnsamples=n=7:p=0,biquad=${lowpass}:a=dii`).packetSections(20n,5n,8000,true,1)).toEqual([{samples:20n,span:7n}]);
  const planned=(channels:number,format:'u8'|'s16'|'dbl')=>auto.plannedReservations({sampleRate:8000,channels,sampleFormat:format},{samples:13n,configuredInput:true,channels})[0]!;
  expect(planned(3,'u8')).toEqual({step:auto.steps[0],reservation:{frames:1,buffers:[],stateBytes:96n},countBuffers:[]});
  expect([planned(1,'s16').reservation.stateBytes,planned(2,'dbl').reservation.stateBytes]).toEqual([32n,64n]);
  expect([...auto.reservations({sampleRate:44100,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:64n}]);
});
type Kind='s16'|'s32'|'flt'|'dbl';
/** Direct transcription of the BIQUAD_<transform>_FILTER loops over whole channels, with float rounding after every C operation for float kernels. */
function reference(step:AudioBiquadStep,kind:Kind,values:readonly number[]):number[] {
  const f=kind==='s16'||kind==='flt'?Math.fround:(x:number)=>x,c=step.coefficients,A=c.a.map(f),B=c.b.map(f),wet=f(step.mix),dry=f(1-wet);
  const [min,max,clip]=kind==='s16'?[-32768,32767,true]:kind==='s32'?[-2147483648,2147483647,true]:[-1,1,false];
  const put=(out:number)=>clip?(out<min?min:out>max?max:Math.trunc(out)+0):kind==='flt'?Math.fround(out):out;
  const result:number[]=[];let s0=0,s1=0,s2=0,s3=0;
  for(const x of values){
    let out:number;
    if(step.transform==='dii'){const a1=-A[1]!,a2=-A[2]!,w0=f(f(x+f(a1*s0))+f(a2*s1));out=f(f(f(B[0]!*w0)+f(B[1]!*s0))+f(B[2]!*s1));s1=s0;s0=w0;out=f(f(out*wet)+f(x*dry));}
    else if(step.transform==='tdi'){const a1=-A[1]!,a2=-A[2]!,i=f(x+s0),t1=f(f(i*a1)+s1),t2=f(i*a2),t3=f(f(i*B[1]!)+s3),t4=f(i*B[2]!);out=f(f(B[0]!*i)+s2);out=f(f(out*wet)+f(i*dry));s0=t1;s1=t2;s2=t3;s3=t4;}
    else if(step.transform==='tdii'){const a1=-A[1]!,a2=-A[2]!;out=f(f(B[0]!*x)+s0);s0=f(f(f(B[1]!*x)+s1)+f(a1*out));s1=f(f(B[2]!*x)+f(a2*out));out=f(f(out*wet)+f(x*dry));}
    else if(step.transform==='latt'){const k0=A[1]!,k1=A[2]!;out=0;let t0=f(x-f(k1*s0)),t1=f(f(t0*k1)+s0);out=f(out+f(t1*B[2]!));t0=f(t0-f(k0*s1));t1=f(f(t0*k0)+s1);out=f(out+f(t1*B[1]!));out=f(out+f(t0*B[0]!));s0=t1;s1=t0;out=f(f(out*wet)+f(x*dry));}
    else if(step.transform==='svf'){out=f(f(B[2]!*x)+s0);const t0=f(f(f(B[0]!*x)+f(A[1]!*s0))+s1),t1=f(f(B[1]!*x)+f(A[2]!*s0));s0=t0;s1=t1;out=f(f(out*wet)+f(x*dry));}
    else{const v3=f(x-s1),v1=f(f(A[0]!*s0)+f(A[1]!*v3)),v2=f(f(s1+f(A[1]!*s0))+f(A[2]!*v3));s0=f(f(2*v1)-s0);s1=f(f(2*v2)-s1);out=f(f(f(B[0]!*x)+f(B[1]!*v1))+f(B[2]!*v2));out=f(f(out*wet)+f(x*dry));}
    result.push(put(out));
  }
  return result;
}
const io={s16:[2,(v:DataView,o:number)=>v.getInt16(o,true),(v:DataView,o:number,x:number)=>v.setInt16(o,x,true)],s32:[4,(v:DataView,o:number)=>v.getInt32(o,true),(v:DataView,o:number,x:number)=>v.setInt32(o,x,true)],flt:[4,(v:DataView,o:number)=>v.getFloat32(o,true),(v:DataView,o:number,x:number)=>v.setFloat32(o,x,true)],dbl:[8,(v:DataView,o:number)=>v.getFloat64(o,true),(v:DataView,o:number,x:number)=>v.setFloat64(o,x,true)]} as const;
function frames(kind:Kind,planar:boolean,values:number[][],sizes:readonly number[],rate:number):AudioFrameData[] {
  const [width,,set]=io[kind],channels=values.length,result:AudioFrameData[]=[];let offset=0;
  for(const samples of sizes){
    const planes=planar?values.map(channel=>{const data=new Uint8Array(samples*width),view=new DataView(data.buffer);for(let s=0;s<samples;s++)set(view,s*width,channel[offset+s]!);return data;}):[(()=>{const data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let s=0;s<samples;s++)for(let c=0;c<channels;c++)set(view,(s*channels+c)*width,values[c]![offset+s]!);return data;})()];
    result.push({sampleRate:rate,channels,channelLayout:channels===2?'stereo':channels===1?'mono':'unspecified',sampleFormat:planar?`${kind}p`:kind,samples,planes,pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}});offset+=samples;
  }
  return result;
}
const splits=(total:number,size:number)=>Array.from({length:Math.ceil(total/size)},(_,i)=>Math.min(size,total-i*size));
it('matches a transcription of the C loops for every transform and working type, identically for 1/7/29/50-sample splits, without touching its input',async()=>{
  const total=150,sets=['a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675','a1=-0.3:a2=0.1:b0=3:b1=-2:b2=1.5:m=0.5','a0=2:a1=-1.5:a2=0.5:b0=1:b1=0.5:b2=0.25:n=1:m=0'];
  for(const kind of ['s16','s32','flt','dbl'] as const)for(const transform of ['dii','tdi','tdii','latt','svf','zdf'])for(const set of transform==='zdf'?['a0=0.5:a1=0.1:a2=0.2:b0=0.3:b1=0.2:b2=0.1','a0=0.6:a1=0.3:a2=0.15:b0=4:b1=3:b2=-2:m=0.5']:sets){
    const precision={s16:'s16',s32:'s32',flt:'f32',dbl:'f64'}[kind],text=`biquad=${set}:a=${transform}:r=${precision}`,step=parseAudioBiquad(text),channels=2;
    const values=Array.from({length:channels},(_,c)=>Array.from({length:total},(_,i)=>{const wave=Math.sin(i*0.37+c)*((i*7+c)%11)/10;return kind==='s16'?Math.round(wave*32767):kind==='s32'?Math.round(wave*2147483647):kind==='flt'?Math.fround(wave):wave;}));
    const expected=values.map(channel=>reference(step,kind,channel)),[width,get]=io[kind];
    for(const planar of [false,true])for(const size of [total,1,7,29,50]){
      const sizes=splits(total,size),source=frames(kind,planar,values,sizes,8000),copies=source.map(frame=>frame.planes.map(plane=>plane.slice()));
      const output=await collect(compileAudioFilterChain(text).process(input(...source),{maxFrameBytes:1<<16}));
      expect(source.map(frame=>frame.planes),`${text} input untouched`).toEqual(copies);
      expect(output.map(frame=>[frame.samples,frame.sampleFormat,frame.pts?.value])).toEqual(sizes.map((samples,i)=>[samples,`${kind}p`,BigInt(i*size)]));
      expect(output.every(frame=>frame.planes.every(plane=>!source.some(f=>f.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
      const actual=Array.from({length:channels},(_,c)=>output.flatMap(frame=>{const plane=frame.planes[c]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:frame.samples},(_,s)=>get(view,s*width));}));
      expect(actual,`${text} ${planar} ${size}`).toEqual(expected);
    }
  }
});
it('runs the shared kernels in place and counts clipped samples',()=>{
  const coefficients=prepareBiquad([1,0,0],[3,0,0],false,'tdii'),kernel=biquadKernel('tdii','s16',coefficients,1),cache=new Float64Array(4);
  const data=Int16Array.of(10000,-12000,5000,32767);expect(kernel(data,data,4,cache)).toBe(2);expect(Array.from(data)).toEqual([30000,-32768,15000,32767]);
  const s32=Int32Array.of(1000000000,-1000000000,1);expect(biquadKernel('dii','s32',prepareBiquad([1,0,0],[3,0,0],false,'dii'),1)(s32,s32,3,new Float64Array(4))).toBe(2);expect(Array.from(s32)).toEqual([2147483647,-2147483648,3]);
  // Float kernels do not clip: values beyond [-1, 1] pass through.
  const flt=Float32Array.of(0.5,-0.75);expect(biquadKernel('svf','flt',prepareBiquad([1,0,0],[3,0,0],false,'svf'),1)(flt,flt,2,new Float64Array(4))).toBe(0);expect(Array.from(flt)).toEqual([1.5,-2.25]);
});
it('enforces allocation, state, format and cancellation limits',async()=>{
  const frame=(samples:number,extra:Partial<AudioFrameData>={}):AudioFrameData=>({sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples,planes:[new Uint8Array(samples*4)],pts:null,...extra});
  const chain=compileAudioFilterChain(`biquad=${lowpass}:a=tdii`);
  expect((await collect(chain.process(input(frame(8)),{maxFrameBytes:64}))).map(output=>output.samples)).toEqual([8]);
  await expect(collect(chain.process(input(frame(17)),{maxFrameBytes:64}))).rejects.toThrow('Converted audio frame exceeds allocation limit');
  await expect(collect(chain.process(input(frame(1)),{maxFrameBytes:63}))).rejects.toThrow('biquad state exceeds allocation limit');
  await expect(collect(chain.process(input(frame(1),frame(1,{channelLayout:'downmix'})),{maxFrameBytes:1<<16}))).rejects.toThrow('biquad requires a stable input format');
  await expect(collect(chain.process(input(frame(1),frame(1,{sampleRate:16000})),{maxFrameBytes:1<<16}))).rejects.toThrow('biquad requires a stable input format');
  expect(await collect(chain.process(input(),{maxFrameBytes:1<<16}))).toEqual([]);
  const step=parseAudioBiquad(`biquad=${lowpass}:a=dii:r=s16`);
  await expect(collect(biquad.stream!(step,input(frame(1)),{maxFrameBytes:0},undefined,()=>'s16p'))).rejects.toThrow('Invalid biquad allocation limit');
  await expect(collect(biquad.stream!(step,input(frame(1)),{maxFrameBytes:1<<16},undefined,()=>'s16'))).rejects.toThrow('biquad cannot run in s16');
  await expect(collect(biquad.stream!(step,input(frame(1)),{maxFrameBytes:1<<16},undefined,()=>'fltp'))).rejects.toThrow('biquad cannot run in fltp');
  const nan:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'flt',samples:2,planes:[new Uint8Array(Float32Array.of(0.5,Number.NaN).buffer)],pts:null};
  await expect(collect(compileAudioFilterChain(`biquad=${lowpass}:a=dii:r=f32`).process(input(nan),{maxFrameBytes:1<<16}))).rejects.toThrow('Non-finite biquad input is not implemented');
  const infinite:AudioFrameData={...nan,sampleFormat:'fltp',planes:[new Uint8Array(Float32Array.of(0.5,Number.POSITIVE_INFINITY).buffer)]};
  await expect(collect(compileAudioFilterChain(`biquad=${lowpass}:a=dii:r=f32`).process(input(infinite),{maxFrameBytes:1<<16}))).rejects.toThrow('Non-finite biquad input is not implemented');
  const controller=new AbortController();let closed=false;async function* source(){try{yield frame(1);controller.abort(new Error('stop'));yield frame(1);}finally{closed=true;}}
  await expect(collect(chain.process(source(),{maxFrameBytes:1<<16,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  const aborted=new AbortController();aborted.abort(new Error('early'));await expect(collect(chain.process(input(frame(1)),{maxFrameBytes:1<<16,signal:aborted.signal}))).rejects.toThrow('early');
});
