import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioEarwaxStep {readonly name:'earwax'}
/** af_earwax.c filt[NUMTAPS*2]: interleaved 30 and 330 degree int8 taps. */
const taps=Int8Array.of(4,-6,4,-11,-1,-5,3,3,-2,5,-5,0,9,1,6,3,-4,-1,-5,-3,-2,-5,-7,1,6,-7,30,-29,12,-3,-11,4,-3,7,-20,23,2,0,1,-6,-14,-5,15,-18,6,7,15,-10,-14,22,-7,-2,-4,9,6,-12,6,-6,0,-11,0,-5,4,0);
const numtaps=32,filters=[Int16Array.from({length:numtaps},(_,i)=>taps[i*2]!),Int16Array.from({length:numtaps},(_,i)=>taps[i*2+1]!)] as const;
const clip16=(value:number)=>value<-32768?-32768:value>32767?32767:value;
/** One input channel's history: the native taps[2*NUMTAPS] sliding buffer (32 saved samples, then the first min(32, n) new ones). */
export const earwaxStateBytes=2n*2n*BigInt(numtaps*2);
/** Native scalarproduct for output sample i of one channel: int32 sum over the history then the frame, >>7, clip16. */
function product(history:Int16Array,input:Int16Array,i:number,filter:Int16Array):number {
  let sample=0;
  for(let j=0;j<numtaps;j++){const k=i+j;sample+=(k<numtaps?history[k]!:input[k-numtaps]!)*filter[j]!;}
  return clip16(sample>>7);
}
/** Stereo 32-tap integer FIR (af_earwax.c): four convolutions per frame then mix(), in s16p, keeping 32 samples of history per input channel. */
async function* earwaxStream(frames:AsyncIterable<AudioFrameData>,options:AudioConversionOptions,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const history=[new Int16Array(numtaps*2),new Int16Array(numtaps*2)];
  for await(const frame of frames){
    options.signal?.throwIfAborted();
    if(frame.samples===0)continue;
    if(frame.channels!==2)throw new AudioFilterError('earwax requires stereo 44100 Hz input');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat);
    if(target!=='s16p')throw new AudioFilterError(`earwax with ${frame.sampleFormat} input requires unimplemented format negotiation`);
    const output=convertAudioFrame(frame,target,options),samples=output.samples;
    const views=output.planes.map(plane=>new DataView(plane.buffer,plane.byteOffset,plane.byteLength));
    const input=views.map(view=>Int16Array.from({length:samples},(_,i)=>view.getInt16(i*2,true)));
    for(let i=samples-1;i>=0;i--){
      if((i&4095)===0)options.signal?.throwIfAborted();
      // convolve(in 0/1, out 0/1, filter 0/1, tap 0..3) then mix: out0 = frame0[1] + frame1[0], out1 = frame0[0] + frame1[1].
      const l0=product(history[0]!,input[0]!,i,filters[0]),l1=product(history[0]!,input[0]!,i,filters[1]),r0=product(history[1]!,input[1]!,i,filters[0]),r1=product(history[1]!,input[1]!,i,filters[1]);
      views[0]!.setInt16(i*2,clip16(l1+r0),true);views[1]!.setInt16(i*2,clip16(l0+r1),true);
    }
    // Next history: the last 32 samples of history ++ input (the memcpy or memmove path).
    for(let c=0;c<2;c++){const saved=history[c]!,next=new Int16Array(numtaps);for(let k=0;k<numtaps;k++){const at=samples+k;next[k]=at<numtaps?saved[at]!:input[c]![at-numtaps]!;}saved.set(next);saved.set(input[c]!.subarray(0,Math.min(numtaps,samples)),numtaps);}
    yield output;
  }
}
export const earwax=defineAudioFilter<AudioEarwaxStep>({
  name:'earwax',
  examples:['earwax'],
  parse(text){
    if(text!=='earwax')throw new AudioFilterError(text.startsWith('earwax=')?'Unsupported earwax option':`Unsupported audio filter: ${text}`);
    return Object.freeze({name:'earwax'});
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['s16p'],
  // Native query_formats pins stereo and 44100 Hz and would insert aresample and a remix for anything else.
  constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo'||format.sampleRate!==44100)throw new AudioFilterError('earwax requires stereo 44100 Hz input');},
  stream:(_step,frames,options,_configured,negotiated)=>earwaxStream(frames,options,negotiated),
  // The converted output frame plus one 64-sample s16 history per input channel.
  reserve:()=>({frames:1,buffers:[],stateBytes:earwaxStateBytes})
});
