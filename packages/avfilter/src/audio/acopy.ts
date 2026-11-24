import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
export interface AudioCopyStep {readonly name:'acopy'}
/** af_acopy.c: ff_get_audio_buffer plus av_frame_copy; owned planes in the negotiated format, samples and pts unchanged. Native has no options. */
export const acopy=defineAudioFilter<AudioCopyStep>({
  name:'acopy',
  examples:['acopy'],
  parse(text){if(text!=='acopy')throw new AudioFilterError(`acopy takes no options: ${text}`);return Object.freeze({name:'acopy'});},
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>'all',
  apply(_step,frame,target,options){
    if(target!==frame.sampleFormat)return convertAudioFrame(frame,target,options);
    options.signal?.throwIfAborted();
    const size=frame.planes.reduce((sum,plane)=>sum+plane.length,0);
    if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<=0||size>options.maxFrameBytes)throw new AudioFilterError('acopy frame exceeds allocation limit');
    const data=new Uint8Array(size),planes:Uint8Array[]=[];let offset=0;
    for(const plane of frame.planes){options.signal?.throwIfAborted();data.set(plane,offset);planes.push(data.subarray(offset,offset+plane.length));offset+=plane.length;}
    return {...frame,planes};
  },
  reserve:()=>frameReservation
});
