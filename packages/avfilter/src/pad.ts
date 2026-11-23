import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createAudioPadState} from './pad-checkpoint.js';
import type {AudioPadOptions} from './pad-checkpoint.js';
export {AudioPadError,paddingDurationSamples} from './pad-checkpoint.js';
export type {AudioPadFormat,AudioPadOptions} from './pad-checkpoint.js';
/** Finite silence tail. Input frames retain ownership; every padding frame owns new storage. */
export async function* padAudio(frames:AsyncIterable<AudioFrameData>,options:AudioPadOptions):AsyncIterable<AudioFrameData>{
  const state=createAudioPadState(options);
  try{for await(const frame of frames)yield state.push(frame);yield* state.finish();}
  finally{state.dispose();}
}
