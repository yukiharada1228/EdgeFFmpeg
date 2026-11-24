import {expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {earwax,earwaxStateBytes} from '../../packages/avfilter/src/audio/earwax.js';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const filt=[4,-6,4,-11,-1,-5,3,3,-2,5,-5,0,9,1,6,3,-4,-1,-5,-3,-2,-5,-7,1,6,-7,30,-29,12,-3,-11,4,-3,7,-20,23,2,0,1,-6,-14,-5,15,-18,6,7,15,-10,-14,22,-7,-2,-4,9,6,-12,6,-6,0,-11,0,-5,4,0];
const clip=(value:number)=>Math.max(-32768,Math.min(32767,value));
/** Naive whole-signal transcription of af_earwax.c: y[i] = clip16(sum_j x[i-32+j]*filt[2j+f] >> 7) with zero history, then mix(). */
function reference(left:Int16Array,right:Int16Array):[Int16Array,Int16Array] {
  const fir=(x:Int16Array,f:number,i:number)=>{let sum=0;for(let j=0;j<32;j++){const k=i-32+j;sum+=(k<0?0:x[k]!)*filt[j*2+f]!;}return clip(sum>>7);};
  const out:[Int16Array,Int16Array]=[new Int16Array(left.length),new Int16Array(left.length)];
  for(let i=0;i<left.length;i++){out[0][i]=clip(fir(left,1,i)+fir(right,0,i));out[1][i]=clip(fir(left,0,i)+fir(right,1,i));}
  return out;
}
/** Stereo frames of the given sizes cut from one s16 signal, packed or planar. */
function frames(left:Int16Array,right:Int16Array,sizes:readonly number[],planar:boolean):AudioFrameData[] {
  const result:AudioFrameData[]=[];let offset=0;
  for(const samples of sizes){
    const plane=(values:number[])=>{const bytes=new Uint8Array(values.length*2),view=new DataView(bytes.buffer);values.forEach((value,i)=>view.setInt16(i*2,value,true));return bytes;};
    const l=[...left.subarray(offset,offset+samples)],r=[...right.subarray(offset,offset+samples)];
    result.push({sampleRate:44100,channels:2,channelLayout:'stereo',sampleFormat:planar?'s16p':'s16',samples,planes:planar?[plane(l),plane(r)]:[plane(l.flatMap((value,i)=>[value,r[i]!]))],pts:{value:BigInt(offset),timeBase:{num:1n,den:44100n}}});
    offset+=samples;
  }
  return result;
}
const read=(output:AudioFrameData[],channel:number)=>Int16Array.from(output.flatMap(frame=>{const view=new DataView(frame.planes[channel]!.buffer,frame.planes[channel]!.byteOffset,frame.planes[channel]!.byteLength);return Array.from({length:frame.samples},(_,i)=>view.getInt16(i*2,true));}));
it('accepts only the bare token and refuses options, enable and unknown names with exact messages',()=>{
  expect(earwax.parse('earwax')).toEqual({name:'earwax'});expect(Object.isFrozen(earwax.parse('earwax'))).toBe(true);
  expect(compileAudioFilterChain(' earwax ').steps).toEqual([{name:'earwax'}]);
  for(const text of ['earwax=1','earwax=enable=1','earwax=','earwax=a=b'])expect(()=>compileAudioFilterChain(text),text).toThrow(new AudioFilterError('Unsupported earwax option'));
  expect(()=>earwax.parse('earwaxx')).toThrow(/^Unsupported audio filter: earwaxx$/);
  expect(()=>compileAudioFilterChain('earwaxx')).toThrow(/^Unsupported audio filter: earwaxx$/);
});
it('negotiates native s16p for every input format and declares its capabilities, counts and reservation',()=>{
  const chain=compileAudioFilterChain('earwax');
  expect(chain.nativeFormatLists).toBe(true);
  expect((['u8','s16','s32','flt','dbl'] as const).map(format=>chain.negotiatedSampleFormats(format)[0])).toEqual(['s16p','s16p','s16p','s16p','s16p']);
  // Float input reaches s16p through scalar rounding, which native matches only with -cpuflags 0.
  expect((['u8','s16','s32','flt','dbl'] as const).map(format=>chain.requiresScalarRounding(format))).toEqual([false,false,false,true,true]);
  expect(compileAudioFilterChain('volume=0.5,earwax').negotiatedSampleFormats('flt')).toEqual(['flt','s16p']);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:false,changesRate:false});
  expect(chain.planSamples(5003n,44100,{channels:2}).samples).toBe(5003n);expect(chain.outputSamples(0n,44100,{channels:2})).toBe(0n);
  expect(chain.packetSections(5003n,1024n,44100,false,2)).toEqual([{samples:5003n,span:1024n}]);
  expect(compileAudioFilterChain('asetnsamples=5,earwax').packetSections(13n,1024n,44100,false,2)).toEqual([{samples:15n,span:5n}]);
  expect(earwaxStateBytes).toBe(256n);
  expect(chain.plannedReservations({sampleRate:44100,channels:2,sampleFormat:'s16'},{samples:5003n,channels:2})).toEqual([{step:{name:'earwax'},reservation:{frames:1,buffers:[],stateBytes:256n},countBuffers:[]}]);
  expect([...chain.reservations({sampleRate:44100,channels:2,sampleFormat:'flt'})]).toEqual([{frames:1,buffers:[],stateBytes:256n}]);
  expect(()=>chain.rateBoundary('s16',48000,44100)).toThrow('sample rate conversion');
  expect(()=>chain.apply(frames(new Int16Array(4),new Int16Array(4),[4],false)[0]!,{maxFrameBytes:64})).toThrow(/^earwax requires stream processing$/);
});
it('refuses every input native would resample or remix, including a masked two-channel WAV layout',()=>{
  const chain=compileAudioFilterChain('earwax'),message=/^earwax requires stereo 44100 Hz input$/;
  for(const format of [{sampleRate:44100,channels:1,channelLayout:'mono'},{sampleRate:44100,channels:3,channelLayout:'unspecified'},{sampleRate:48000,channels:2,channelLayout:'stereo'},{sampleRate:22050,channels:2,channelLayout:'stereo'},{sampleRate:44100,channels:2,channelLayout:'2 channels (FL+FC)'},{sampleRate:44100,channels:2,channelLayout:'downmix'},{sampleRate:44100,channels:2,channelLayout:'2 channels'}])expect(()=>chain.validateInputFormat(format),JSON.stringify(format)).toThrow(message);
  expect(()=>chain.validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).not.toThrow();
  // asetrate changes the rate the constraint sees.
  expect(()=>compileAudioFilterChain('asetrate=48000,earwax').validateInputFormat({sampleRate:44100,channels:2,channelLayout:'stereo'})).toThrow(message);
  expect(()=>compileAudioFilterChain('asetrate=44100,earwax').validateInputFormat({sampleRate:48000,channels:2,channelLayout:'stereo'})).not.toThrow();
});
it('matches a naive whole-signal FIR across random frame splits, packed and planar input, and saturates like native',async()=>{
  let seed=12345;const random=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
  for(const loud of [false,true]){
    const length=997,left=Int16Array.from({length},(_,i)=>loud?(i%5<2?32767:-32768):Math.round(Math.sin(i*0.11)*12000+random()*4000-2000)),right=Int16Array.from({length},(_,i)=>loud?(i%7<3?-32768:32767):Math.round(random()*30000-15000));
    const [expectedLeft,expectedRight]=reference(left,right);
    if(loud)expect([...expectedLeft,...expectedRight].some(value=>value===32767||value===-32768)).toBe(true);
    for(let trial=0;trial<12;trial++){
      const sizes:number[]=[];let left_=length;while(left_>0){const size=Math.min(left_,trial===0?length:trial===1?1:1+Math.floor(random()*(trial%2?40:200)));sizes.push(size);left_-=size;}
      const source=frames(left,right,sizes,trial%3===2),copies=source.map(frame=>frame.planes.map(plane=>plane.slice()));
      const output=await collect(compileAudioFilterChain('earwax').process(input(...source),{maxFrameBytes:1<<16}));
      expect(source.map(frame=>frame.planes),'input untouched').toEqual(copies);
      expect(output.map(frame=>frame.samples)).toEqual(sizes);expect(output.map(frame=>frame.pts)).toEqual(source.map(frame=>frame.pts));
      expect(output.every(frame=>frame.sampleFormat==='s16p'&&frame.channels===2&&frame.planes.length===2&&frame.planes.every(plane=>!source.some(s=>s.planes.some(p=>p.buffer===plane.buffer))))).toBe(true);
      expect(read(output,0),`${loud} ${sizes.join(',')}`).toEqual(expectedLeft);expect(read(output,1)).toEqual(expectedRight);
    }
  }
});
it('converts float and wide integer input through the negotiated s16p, and enforces allocation limits and cancellation',async()=>{
  const flt:AudioFrameData={sampleRate:44100,channels:2,channelLayout:'stereo',sampleFormat:'flt',samples:40,planes:[new Uint8Array(new Float32Array(80).map((_,i)=>Math.sin(i)*0.9).buffer)],pts:null};
  const [converted]=await collect(compileAudioFilterChain('earwax').process(input(flt),{maxFrameBytes:1024}));
  expect(converted!.sampleFormat).toBe('s16p');expect(converted!.samples).toBe(40);
  const one=frames(new Int16Array(64).fill(1000),new Int16Array(64).fill(-1000),[64],false)[0]!;
  await expect(collect(compileAudioFilterChain('earwax').process(input(one),{maxFrameBytes:255}))).rejects.toThrow('allocation limit');
  await expect(collect(compileAudioFilterChain('earwax').process(input({...one,channels:1,channelLayout:'mono'}),{maxFrameBytes:1024}))).rejects.toThrow(/^earwax requires stereo 44100 Hz input$/);
  await expect(collect(compileAudioFilterChain('earwax').process(input({...one,sampleRate:48000}),{maxFrameBytes:1024}))).rejects.toThrow(/^earwax requires stereo 44100 Hz input$/);
  const controller=new AbortController();let closed=false;
  async function* aborted(){try{yield one;controller.abort(new Error('stop'));yield one;}finally{closed=true;}}
  await expect(collect(compileAudioFilterChain('earwax').process(aborted(),{maxFrameBytes:1024,signal:controller.signal}))).rejects.toThrow('stop');expect(closed).toBe(true);
  expect(await collect(compileAudioFilterChain('earwax').process(input(),{maxFrameBytes:1024,inputFormat:{sampleRate:44100,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null}}))).toEqual([]);
});
