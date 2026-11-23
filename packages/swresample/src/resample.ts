import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createAudioResampleState} from './resample-state.js';
import type {AudioResampleOptions} from './resample-plan.js';
export {resampleInternalFormat,resampledStreamingSampleCount,resampledSampleCount,planAudioResample} from './resample-plan.js';
export type {ResampleSampleFormat,AudioResampleOptions,AudioResamplePlan} from './resample-plan.js';
/** Independent default Kaiser FIR, packed or planar finite s16/flt/dbl input/output and exact rational phases or bounded phase interpolation.
 * Sample bytes are numerical-compatible, not certified bit-exact. Output packetization
 * follows the caller's frame budget, independently of native AVFrame boundaries.
 * Runs through createAudioResampleState, so continuous and checkpoint-restored execution share one implementation.
 */
export async function* resampleAudio(frames:AsyncIterable<AudioFrameData>,outputRate:number,options:AudioResampleOptions):AsyncIterable<AudioFrameData>{
  const state=createAudioResampleState(outputRate,options);
  try{for await(const frame of frames)yield* state.push(frame);yield* state.finish();}
  finally{state.dispose();}
}
