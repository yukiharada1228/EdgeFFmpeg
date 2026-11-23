import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {CompiledFlacAudioFilters,FlacAudioFilterOptions} from './flac-wave-filters.js';
import {processFlacAudioFilters} from './flac-wave-filters.js';
import {trimFlacAudio} from './flac-wave-trim.js';
import type {FlacAudioTrimRange} from './flac-wave-trim.js';
import {resampleFlacAudio} from './flac-wave-resample.js';

/** Insert the automatic rate conversion at the negotiated format boundary.
 * The existing filter adapter reserves every allocating filter before execution;
 * the inserted resampler independently owns its FIR/history/output reservations.
 */
export function processFlacFilterRate(frames:AsyncIterable<AudioFrameData>,compiled:CompiledFlacAudioFilters,inputFormat:AudioSampleFormat,inputRate:number,outputRate:number,options:FlacAudioFilterOptions,inputTrim?:FlacAudioTrimRange):AsyncIterable<AudioFrameData>{
 const boundary=compiled.rateBoundary(inputFormat,inputRate,outputRate);
 if(!boundary)return processFlacAudioFilters(frames,compiled,options);
 const configured=options.inputFormat;
 const adapted:CompiledFlacAudioFilters={...compiled,process(source,limits){
  return compiled.process(source,limits,{
   beforeStep:boundary.beforeStep,
   transform:upstream=>{
    const sampled=resampleFlacAudio(upstream,outputRate,boundary.outputFormat,{...options,maxBytesPerSample:compiled.maxBytesPerSample});
    return inputTrim?trimFlacAudio(sampled,inputTrim,options):sampled;
   },
   ...(configured?{outputFormat:{...configured,sampleRate:outputRate,sampleFormat:boundary.outputFormat,pts:configured.pts===null?null:{value:0n,timeBase:{num:1n,den:BigInt(outputRate)}}}}:{})
  });
 }};
 return processFlacAudioFilters(frames,adapted,options);
}
