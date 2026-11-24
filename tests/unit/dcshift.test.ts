import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
const INT32_MAX=2147483647;
/** Direct transcription of af_dcshift.c filter_frame for one int32 sample (double arithmetic, int64 truncation, av_clipl_int32). */
function model(shift:number,gain:number,x:number):number {
  const threshold=INT32_MAX*(1.0-(Math.abs(shift)-gain));let d=x;
  if(gain>0){
    if(d>threshold&&shift>0)d=(d-threshold)*gain/(INT32_MAX-threshold)+threshold+shift;
    else if(d< -threshold&&shift<0)d=(d+threshold)*gain/(INT32_MAX-threshold)-threshold+shift;
    else d=shift*INT32_MAX+d;
  }else d=shift*(INT32_MAX+1.0)+x;
  // x86-64 cvttsd2si yields INT64_MIN for non-finite or out-of-range values (the -Infinity of shift=-1:limitergain=1 at INT32_MIN), which clips to INT32_MIN.
  if(!(Math.abs(d)<2**63))return -2147483648;
  const t=BigInt(Math.trunc(d));return Number(t<-2147483648n?-2147483648n:t>2147483647n?2147483647n:t);
}
const s32p=(channels:number[][]):AudioFrameData=>({sampleRate:8000,channels:channels.length,channelLayout:channels.length===1?'mono':'stereo',sampleFormat:'s32p',samples:channels[0]!.length,planes:channels.map(values=>{const plane=new Uint8Array(values.length*4),view=new DataView(plane.buffer);values.forEach((value,i)=>view.setInt32(i*4,value,true));return plane;}),pts:null});
const read=(frame:AudioFrameData)=>frame.planes.map(plane=>{const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:plane.length/4},(_,i)=>view.getInt32(i*4,true));});
const extremes=[-2147483648,-2147483647,-2000000000,-1500000000,-1073741824,-1,0,1,1073741823,1288490188,1500000000,2000000000,2147483646,2147483647];
it('parses positional and named decimal options and refuses expressions, suffixes, unknown options and out-of-range values with exact messages',()=>{
  const step=(text:string)=>compileAudioFilterChain(text).steps[0];
  expect(step('dcshift')).toEqual({name:'dcshift',shift:0,limitergain:0});
  expect(step('dcshift=0.3')).toEqual({name:'dcshift',shift:0.3,limitergain:0});
  expect(step('dcshift=-0.7:0.4')).toEqual({name:'dcshift',shift:-0.7,limitergain:0.4});
  expect(step('dcshift=shift=1:limitergain=1')).toEqual({name:'dcshift',shift:1,limitergain:1});
  expect(step('dcshift=limitergain=.5:shift=-1')).toEqual({name:'dcshift',shift:-1,limitergain:0.5});
  expect(step('dcshift=0.25:limitergain=1e-1')).toEqual({name:'dcshift',shift:0.25,limitergain:0.1});
  expect(step('dcshift=shift=0.1:shift=0.2')).toEqual({name:'dcshift',shift:0.2,limitergain:0});
  expect(Object.isFrozen(step('dcshift=0.3'))).toBe(true);
  const refusals:[string,string][]=[
    ['dcshift=2','dcshift shift must be between -1 and 1'],['dcshift=-1.5','dcshift shift must be between -1 and 1'],['dcshift=limitergain=-1','dcshift limitergain must be between 0 and 1'],['dcshift=0:1.01','dcshift limitergain must be between 0 and 1'],
    ['dcshift=0.1+0.1','Only constant decimal dcshift shift values are implemented'],['dcshift=0.5dB','Only constant decimal dcshift shift values are implemented'],['dcshift=1k','Only constant decimal dcshift shift values are implemented'],
    ['dcshift=nan','Only constant decimal dcshift shift values are implemented'],['dcshift=','Only constant decimal dcshift shift values are implemented'],['dcshift=0:limitergain=PI/4','Only constant decimal dcshift limitergain values are implemented'],
    ['dcshift=0.1:0.2:0.3','Unsupported dcshift option: 0.3'],['dcshift=shift=0.1:0.2','Unsupported dcshift option: 0.2'],['dcshift=enable=gt(t\\:1)','Unsupported dcshift option: enable=gt(t\\'],['dcshift=0.1:enable=1','Unsupported dcshift option: enable=1'],['dcshift=s=0.1','Unsupported dcshift option: s=0.1'],
    ['dcshiftx','Unsupported audio filter: dcshiftx']
  ];
  for(const [text,message]of refusals){expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
});
it('declares stateless frame allocation, refuses rate conversion and FLAC timing, and leaves counts, packets and reservations unchanged',()=>{
  const chain=compileAudioFilterChain('dcshift=0.3:0.4');
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false});
  expect(chain.reframes).toBe(false);expect(chain.nativeFormatLists).toBe(true);
  expect(chain.planSamples(13n,8000,{channels:2})).toMatchObject({samples:13n,buffers:[]});expect(chain.packetSections(13n,4n,8000,false,2)).toEqual([{samples:13n,span:4n}]);
  expect(compileAudioFilterChain('dcshift=0.3,asetnsamples=7').packetSections(13n,4n,8000,false,2)).toEqual([{samples:14n,span:7n}]);
  expect(chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,channels:2}).map(entry=>[entry.reservation,entry.countBuffers])).toEqual([[{frames:1,buffers:[],stateBytes:0n},[]]]);
  expect([...chain.reservations({sampleRate:8000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('dcshift with sample rate conversion is not implemented');expect(chain.rateBoundary('s16',8000,8000)).toBeNull();
  expect(()=>chain.validateInputFormat({sampleRate:8000,channels:3,channelLayout:'2 channels (FL+FC)'})).not.toThrow();
});
it('negotiates every input format to s32p and keeps native merges with volume and asetnsamples',()=>{
  for(const output of ['u8','s16','s32','flt','dbl'] as const)for(const input of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const){
    const chain=compileAudioFilterChain('dcshift=0.3',{outputSampleFormat:output});
    expect(chain.negotiatedSampleFormats(input),`${input}->${output}`).toEqual(['s32p']);expect(chain.resolvedSampleFormat(input)).toBe('s32p');
    expect(chain.requiresScalarRounding(input)).toBe(!['u8','s16','s32'].includes(input.replace(/p$/,'')));
  }
  for(const input of ['u8','s16','s32','flt','dbl'] as const){
    expect(compileAudioFilterChain('dcshift=0.3,asetnsamples=7',{outputSampleFormat:'s16'}).negotiatedSampleFormats(input)).toEqual(['s32p','s32p']);
    expect(compileAudioFilterChain('volume=0.5,dcshift=-0.7:0.4',{outputSampleFormat:'s32'}).negotiatedSampleFormats(input)).toEqual(['flt','s32p']);
    expect(compileAudioFilterChain('dcshift=1:1,volume=0.5',{outputSampleFormat:'s32'}).negotiatedSampleFormats(input)).toEqual(['s32p','flt']);
  }
});
it('matches the C transcription on every branch, threshold edge and clip, for every parameter pair, with frame-split invariance',()=>{
  const shifts=[0,-0,0.3,-0.3,-0.7,0.7,0.5,-0.25,1,-1,0.123456789,-0.999999],gains=[0,0.4,1,0.3,0.7,0.123456789,1e-9];let state=0x1234567;
  const random=Array.from({length:4000},()=>{state=(Math.imul(state,1103515245)+12345)|0;return state;});
  for(const shift of shifts)for(const gain of gains){
    const threshold=INT32_MAX*(1-(Math.abs(shift)-gain)),edges=[threshold,-threshold].flatMap(t=>[Math.floor(t)-1,Math.floor(t),Math.ceil(t),Math.ceil(t)+1]).filter(v=>v>=-2147483648&&v<=INT32_MAX);
    const values=[...extremes,...edges,...random],chain=compileAudioFilterChain(`dcshift=shift=${shift}:limitergain=${gain}`);
    const whole=read(chain.apply(s32p([values,values.map(v=>v===-2147483648?INT32_MAX:-v)]),{maxFrameBytes:1<<16}));
    expect(whole[0],`${shift}/${gain}`).toEqual(values.map(v=>model(shift,gain,v)));expect(whole[1]).toEqual(values.map(v=>model(shift,gain,v===-2147483648?INT32_MAX:-v)));
    const split=[1,7,values.length-8].reduce<{at:number,out:number[]}>((acc,size)=>{const part=values.slice(acc.at,acc.at+size);acc.out.push(...read(chain.apply(s32p([part]),{maxFrameBytes:1<<16}))[0]!);acc.at+=size;return acc;},{at:0,out:[]});
    expect(split.out).toEqual(whole[0]);
  }
  // Exact bigint checks for dyadic shifts, where shift*2^31 is an integer and the double sum is exact.
  for(const shift of [0.5,-0.25,1,-1])for(const x of extremes){const exact=BigInt(shift*2147483648)+BigInt(x);expect(model(shift,0,x)).toBe(Number(exact<-2147483648n?-2147483648n:exact>2147483647n?2147483647n:exact));}
  // The limiter branches add the raw shift and the else branch scales by INT32_MAX, not INT32_MAX+1.
  expect(model(1,0.5,2147483647)).toBe(1073741825);expect(model(-1,1,-2147483648)).toBe(-2147483648);expect(model(0.5,1,0)).toBe(1073741823);expect(model(0.5,0,0)).toBe(1073741824);
  expect(model(0.5,0.25,2000000000)).toBe(Math.trunc((2000000000-INT32_MAX*0.75)*0.25/(INT32_MAX*0.25)+INT32_MAX*0.75+0.5));
  expect(model(-1,0,-1)).toBe(-2147483648);expect(model(1,0,0)).toBe(2147483647);expect(model(-0.3,0.4,-5)).toBe(Math.trunc(-0.3*INT32_MAX-5));
});
it('converts integer and floating input to s32p first, owns its output and never mutates the input',()=>{
  const sources:[AudioSampleFormat,Uint8Array][]=[['u8',Uint8Array.of(0,1,127,128,255,200)],['s16',new Uint8Array(Int16Array.of(-32768,-1,0,1,32767,1234).buffer)],['flt',new Uint8Array(Float32Array.of(-1.1,-1,-0.5,0.25,1,1.1).buffer)],['dbl',new Uint8Array(Float64Array.of(-1.1,-1,1/3,0,0.999,1.1).buffer)]];
  for(const [format,bytes]of sources){
    const frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:format,samples:3,planes:[bytes],pts:{value:5n,timeBase:{num:1n,den:8000n}}},copy=bytes.slice();
    const plain=compileAudioFilterChain('anull',{outputSampleFormat:'s32'}),converted=read(compileAudioFilterChain('aformat=f=s32p').apply(frame,{maxFrameBytes:64}));
    const output=compileAudioFilterChain('dcshift=-0.7:0.4').apply(frame,{maxFrameBytes:64});
    expect(output.sampleFormat).toBe('s32p');expect(output.pts).toEqual(frame.pts);expect(bytes).toEqual(copy);expect(plain.steps.length).toBe(1);
    expect(read(output)).toEqual(converted.map(channel=>channel.map(v=>model(-0.7,0.4,v))));
    expect(output.planes.every(plane=>plane.buffer!==bytes.buffer)).toBe(true);
  }
});
it('enforces frame allocation limits and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('dcshift=0.3'),frame=s32p([[1,2,3,4]]);
  expect(()=>chain.apply(frame,{maxFrameBytes:15})).toThrow('allocation limit');expect(read(chain.apply(frame,{maxFrameBytes:16}))[0]).toEqual([1,2,3,4].map(v=>model(0.3,0,v)));
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>chain.apply(frame,{maxFrameBytes:16,signal:controller.signal})).toThrow('stop');
  const late=new AbortController();let closed=false;async function* frames(){try{yield frame;late.abort(new Error('halt'));yield frame;}finally{closed=true;}}
  const out:AudioFrameData[]=[];await expect((async()=>{for await(const value of chain.process(frames(),{maxFrameBytes:16,signal:late.signal}))out.push(value);})()).rejects.toThrow('halt');
  expect(out.length).toBe(1);expect(closed).toBe(true);
});
