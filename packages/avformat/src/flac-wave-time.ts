import type {Option,ParsedCommand} from '@edge-ffmpeg/cli';
import {parseTimeDuration} from '@edge-ffmpeg/cli';
import {ExecutionError} from '@edge-ffmpeg/core';

/** Integer microseconds; -t wins over -to independently in each file scope. */
export interface FlacTimeScope {
 readonly seek:bigint;
 readonly duration:bigint|null;
 readonly stop:bigint|null;
}
export interface FlacTimePolicy {
 readonly input:Readonly<FlacTimeScope>;
 readonly output:Readonly<FlacTimeScope>;
}
export interface ResolvedFlacTimePolicy {
 readonly startSample:bigint;
 /** null means decode until EOF; STREAMINFO zero/unknown must be passed as null. */
 readonly endSampleExclusive:bigint|null;
 /** PTS of the first emitted sample, in the unchanged source sample-rate time base. */
 readonly outputPtsSamples:bigint;
}
const invalid=(message:string):never=>{throw new ExecutionError('invalid-time',message);};
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
const maxTime=(1n<<63n)-1n;

function scope(options:readonly Option[],label:string):Readonly<FlacTimeScope>{
 let seek=0n,duration:bigint|null=null,stop:bigint|null=null;
 for(const option of options){
  if(!['-ss','-t','-to'].includes(option.name)){
   if(/^-(?:ss|t|to):/.test(option.name)||['-sseof','-itsoffset','-itsscale','-noaccurate_seek','-seek_timestamp'].includes(option.name))unsupported('Unsupported FLAC time option: '+option.name);
   continue;
  }
  let value:bigint;
  try{value=parseTimeDuration(option.value??'');}
  catch(error){return invalid(error instanceof Error?error.message:String(error));}
  // Native reserves INT64_MAX for unlimited duration / absent stop, and INT64_MIN
  // for AV_NOPTS_VALUE. Do not accidentally treat either sentinel as an ordinary time.
  if(value===maxTime||value===-(1n<<63n))unsupported('FLAC time sentinel values are not implemented');
  if(option.name==='-ss')seek=value;
  else if(option.name==='-t')duration=value;
  else stop=value;
 }
 // Validate final values, not overwritten occurrences. Every token was still parsed.
 if(duration!==null&&duration<0n)invalid(label+' -t must be non-negative');
 if(duration===null&&stop!==null){
  if(stop<=seek)invalid(label+' -to must be greater than -ss');
  duration=stop-seek;
  if(duration>maxTime)unsupported('FLAC scoped duration exceeds signed 64-bit microseconds');
 }
 return Object.freeze({seek,duration,stop});
}

/**
 * Snapshot time scopes for a single decoded FLAC command before awaiting I/O.
 * Resolve each scope at its actual sample rate; the caller owns filter/resampler
 * placement. This is not a stream-copy or timestamp-preservation policy.
 * Only fixed-size scalar state is retained: no media buffers, handles or reservations.
 */
export function compileFlacTimePolicy(command:ParsedCommand):Readonly<FlacTimePolicy>{
 if(command.inputs.length!==1||command.outputs.length!==1)unsupported('FLAC time policy requires one input and one output');
 let copyts=false,startAtZero=false;
 for(const option of command.global){
  if(option.name==='-copyts')copyts=true;
  else if(option.name==='-nocopyts')copyts=false;
  else if(option.name==='-start_at_zero')startAtZero=true;
  else if(option.name==='-nostart_at_zero')startAtZero=false;
  else if(['-ss','-t','-to'].includes(option.name))invalid('FLAC time options require an input or output file scope');
 }
 if(copyts||startAtZero)unsupported('FLAC time policy does not implement timestamp preservation');
 const input=scope(command.inputs[0]!.options,'Input'),output=scope(command.outputs[0]!.options,'Output');
 // A sample interval alone cannot reproduce Native FLAC demuxer seeking. In the
 // pinned reference even -ss 63us on the 257-sample fixture seeks directly to EOF.
 // Never pretend that an input seek is equivalent to an output atrim.
 if(input.seek!==0n)unsupported('FLAC input -ss requires Native-compatible demux seeking; only zero is implemented');
 // Negative output seek succeeds in Native, but shifts PTS and interacts with
 // encoder recording-time checks. Do not silently clamp it to zero.
 if(output.seek<0n)unsupported('Negative FLAC output -ss timestamp shifting is not implemented');
 return Object.freeze({input,output});
}

/**
 * Resolve using av_rescale_q's nearest/ties-away-from-zero rounding (nonnegative
 * supported times). No Number conversion of sample positions or media allocation.
 * Caller must intersect every decoded frame with [startSample,endSampleExclusive),
 * preserve frame boundaries, and stamp outputPtsSamples + emittedSampleCount.
 */
export function resolveFlacTimePolicy(policy:Readonly<FlacTimePolicy>,sampleRate:number,totalSamples:bigint|null):Readonly<ResolvedFlacTimePolicy>{
 if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>655350)throw new ExecutionError('invalid-arguments','Invalid FLAC sample rate');
 if(totalSamples!==null&&(typeof totalSamples!=='bigint'||totalSamples<0n))throw new ExecutionError('invalid-arguments','Invalid FLAC total sample count');
 const rate=BigInt(sampleRate),near=(time:bigint)=>(time*rate+500000n)/1000000n;
 // Recheck the essential domain even for manually constructed policies.
 if(policy.input.seek!==0n||policy.output.seek<0n)unsupported('Unimplemented FLAC seek policy');
 if((policy.input.duration!==null&&policy.input.duration<0n)||(policy.output.duration!==null&&policy.output.duration<0n))invalid('FLAC duration must be non-negative');
 let start=near(policy.output.seek),end=totalSamples;
 const limit=(stop:bigint)=>{if(end===null||stop<end)end=stop;};
 if(policy.input.duration!==null){
  const count=near(policy.input.duration);
  // libavfilter/trim.c: duration_tb == 0 disables the INPUT duration trim.
  if(count>0n)limit(count);
 }
 if(policy.output.duration!==null){
  const count=near(policy.output.duration);
  // OUTPUT -t 0 is stopped by the encoder. A positive sub-half-sample limit
  // instead emits the first surviving decoder frame: its boundary is not a
  // function of sampleRate/totalSamples. Refuse rather than invent a block size.
  if(policy.output.duration>0n&&count===0n)unsupported('Positive FLAC output duration rounding to zero requires decoded frame boundaries');
  limit(start+count);
 }
 if(end!==null&&start>end)start=end;
 return Object.freeze({startSample:start,endSampleExclusive:end,outputPtsSamples:0n});
}
