import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioPadFormat} from '@edge-ffmpeg/avfilter';
import type {FlacTimePolicy} from './flac-wave-time.js';
import {resolveFlacTimePolicy} from './flac-wave-time.js';
import {trimFlacAudio} from './flac-wave-trim.js';
import {processFlacAudioFilters} from './flac-wave-filters.js';
import type {CompiledFlacAudioFilters,FlacAudioFilterOptions} from './flac-wave-filters.js';

/** Native input recording time precedes user buffering; output time selects the
 * resulting samples, including finite padding beyond the decoded source EOF.
 * The actual filtered EOF bounds output: a source total is never an output cap.
 */
export function processTimedBufferedFlac(frames:AsyncIterable<AudioFrameData>,compiled:CompiledFlacAudioFilters,time:FlacTimePolicy,format:AudioPadFormat,totalSamples:bigint|null,options:FlacAudioFilterOptions):AsyncIterable<AudioFrameData>{
 const input=resolveFlacTimePolicy({input:time.input,output:{seek:0n,duration:null,stop:null}},format.sampleRate,totalSamples);
 const output=resolveFlacTimePolicy({input:{seek:0n,duration:null,stop:null},output:time.output},format.sampleRate,null);
 const trimmed=trimFlacAudio(frames,input,options);
 const filtered=processFlacAudioFilters(trimmed,compiled,{...options,inputFormat:format});
 return trimFlacAudio(filtered,output,options);
}
