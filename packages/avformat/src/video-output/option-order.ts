import {parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped per-stream string selection and raw demux dictionary overrides adapt
// fftools/cmdutils.c, ffmpeg_demux.c and ffmpeg_mux_init.c at the pinned commit.
import type {Option,ParsedCommand,FileContext} from '@edge-ffmpeg/cli';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {videoOptionMatches} from './stream-option.js';
/** Numeric frame counts are parsed at option ingestion even if later overwritten. */
export function resolveVideoOutputOptions(options:readonly Option[]):Option[] {
 const result:(Option|null)[]=[],last=new Map<string,number>();
 for(const option of options){const base=option.name.split(':')[0]!;let canonical:string|undefined,match=true;
  if(['-r','-fpsmax','-fps_mode','-enc_time_base','-s','-pix_fmt','-filter'].includes(base)){canonical=base==='-filter'?'-vf':base;match=videoOptionMatches(option.name);}
  else if(base==='-c'||base==='-codec'){canonical='-c:v';match=videoOptionMatches(option.name);}
  else if(option.name==='-vf')canonical='-vf';
  else if(option.name==='-vcodec')canonical='-c:v';
  else if(base==='-frames'||option.name==='-vframes'||option.name==='-aframes'){
   if(option.value===null)throw new Error('Missing output frame limit');parseFrameLimit(option.value);canonical='-frames:v';match=option.name==='-aframes'?false:option.name==='-vframes'?true:videoOptionMatches(option.name);
  }
  if(canonical){if(!match)continue;const previous=last.get(canonical);if(previous!==undefined)result[previous]=null;last.set(canonical,result.length);result.push({name:canonical,value:option.value});}
  else result.push({...option});
 }
 return result.filter((option):option is Option=>option!==null);
}
/** Format-level rawvideo dictionaries receive the last typed -s/-r/-pix_fmt after
 * generic AVOptions, irrespective of their textual position or stream match. */
export function resolveRawVideoInputOptions(options:readonly Option[]):Option[] {
 const retained:Option[]=[],generic=new Map<string,Option>(),typed=new Map<string,Option>();
 for(const option of options){const base=option.name.split(':')[0]!;if(['-s','-r','-pix_fmt'].includes(base)){videoOptionMatches(option.name);typed.set(base,{...option});}
  else if(['-video_size','-framerate','-pixel_format'].includes(option.name))generic.set(option.name,{...option});
  else retained.push({...option});
 }
 for(const [alias,name]of [['-s','-video_size'],['-r','-framerate'],['-pix_fmt','-pixel_format']] as const){const value=typed.get(alias)??generic.get(name);if(value)retained.push({name,value:value.value});}
 return retained;
}
const decoderRateKey:unique symbol=Symbol('video input decoder rate');
type ResolvedInput=FileContext&{[decoderRateKey]?:Readonly<{value:string|undefined}>};
export function inputVideoRates(input:FileContext,demuxFrameRate:Rational){
 const value=(input as ResolvedInput)[decoderRateKey]?.value;
 return Object.freeze({demuxFrameRate:Object.freeze({...demuxFrameRate}),frameRate:value===undefined?Object.freeze({...demuxFrameRate}):parseVideoFrameRate(value),forced:value!==undefined});
}
export function hasForcedVideoRate(input:FileContext):boolean {
 const metadata=(input as ResolvedInput)[decoderRateKey];if(metadata)return metadata.value!==undefined;
 return input.options.some(option=>option.name.split(':')[0]==='-r'&&videoOptionMatches(option.name));
}
export function resolveVideoCommandOptions(command:ParsedCommand):ParsedCommand {
 return {global:command.global.map(option=>({...option})),inputs:command.inputs.map(input=>{
  const prior=(input as ResolvedInput)[decoderRateKey];if(prior)return {...input,options:input.options.map(option=>({...option}))};
  let value:string|undefined;for(const option of input.options)if(option.name.split(':')[0]==='-r'&&videoOptionMatches(option.name))value=option.value??'';
  return {...input,options:resolveRawVideoInputOptions(input.options),[decoderRateKey]:Object.freeze({value})};
 }),outputs:command.outputs.map(output=>({...output,options:resolveVideoOutputOptions(output.options)}))};
}

/** Before the first decoded frame, filter fallback parameters retain demux timing. */
export function videoFallbackCommand(command:ParsedCommand,decoded:readonly boolean[]):ParsedCommand{const resolved=resolveVideoCommandOptions(command);return {...resolved,inputs:resolved.inputs.map((input,index)=>decoded[index]?input:{...input,[decoderRateKey]:Object.freeze({value:undefined})})};}
