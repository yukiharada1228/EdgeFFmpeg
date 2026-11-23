import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioConversionOptions} from '@edge-ffmpeg/swresample';
import {createAudioReframeState} from './reframe-state.js';
export {AudioReframeError} from './reframe-state.js';
/** Bounded packed/planar FIFO with independently owned output allocations. */
export async function* reframeAudio(frames:AsyncIterable<AudioFrameData>,samples:number,pad:boolean,options:AudioConversionOptions):AsyncIterable<AudioFrameData>{
 const state=createAudioReframeState(samples,pad,options);
 try{for await(const frame of frames)yield* state.push(frame);const tail=state.finish();if(tail)yield tail;}
 finally{state.dispose();}
}
