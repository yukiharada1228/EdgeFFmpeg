import {parseTimeDuration} from '@edge-ffmpeg/avutil';
import {padAudio,paddingDurationSamples} from '../pad.js';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioPadStep {readonly name:'apad';readonly padSamples:bigint|null;readonly wholeSamples:bigint|null;readonly padDuration:bigint|null;readonly wholeDuration:bigint|null;readonly packetSamples:number}
/** Finite tail samples after `count` input samples; nothing for an unconfigured empty input. */
function paddingCount(step:AudioPadStep,count:bigint,rate?:number,configured=false):bigint {
  if(count===0n&&!configured)return 0n;
  if(step.padDuration!==null)return paddingDurationSamples(step.padDuration,rate!);
  const minimum=step.wholeDuration!==null?paddingDurationSamples(step.wholeDuration,rate!):step.wholeSamples;
  return step.padSamples??(minimum!>count?minimum!-count:0n);
}
/** Finite silence tail in packet_size packets, including after a configured empty input. */
export const apad=defineAudioFilter<AudioPadStep>({
  name:'apad',
  examples:['apad=pad_len=1','apad=whole_dur=0.5:packet_size=7'],
  parse(text){
    let padSamples:bigint|null=null,wholeSamples:bigint|null=null,padDuration:bigint|null=null,wholeDuration:bigint|null=null,packetSamples=4096;
    if(text!=='apad')for(const [index,option]of text.slice(5).split(':').entries()){
      const parts=option.includes('=')?option.split('='):[index===0?'packet_size':'',option];
      if(parts.length!==2)throw new AudioFilterError('Only finite apad pad_len/whole_len and positive packet_size are implemented');
      const [name,value]=parts;
      if(name==='pad_dur'||name==='whole_dur'){let duration:bigint;try{duration=parseTimeDuration(value??'');}catch{throw new AudioFilterError('Invalid apad duration');}if(duration<0n)throw new AudioFilterError('Negative apad duration is not implemented');if(name==='pad_dur')padDuration=duration;else wholeDuration=duration;continue;}
      if(!/^\d+$/.test(value??''))throw new AudioFilterError('Invalid finite apad length');
      if(name==='pad_len'||name==='whole_len'){const count=BigInt(value!);if(count>(1n<<63n)-1n)throw new AudioFilterError('apad length exceeds signed64');if(name==='pad_len')padSamples=count;else wholeSamples=count;}
      else if(name==='packet_size'){packetSamples=Number(value);if(!Number.isInteger(packetSamples)||packetSamples<1||packetSamples>2147483647)throw new AudioFilterError('Invalid apad packet_size');}
      else throw new AudioFilterError('Unsupported apad option');
    }
    if([padSamples,wholeSamples,padDuration,wholeDuration].filter(value=>value!==null).length!==1)throw new AudioFilterError('apad requires exactly one finite length or duration');
    return Object.freeze({name:'apad',padSamples,wholeSamples,padDuration,wholeDuration,packetSamples});
  },
  capabilities:()=>({generatesOutput:true,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:true,timeSelection:true,flacInput:true}),
  count(step,samples,rate,{configuredInput}){
    const added=paddingCount(step,samples,rate,configuredInput),packet=BigInt(step.packetSamples);
    return added>0n?{samples:samples+added,buffers:[Number(added<packet?added:packet)],packets:{trailing:{samples:added,span:packet}}}:{samples,buffers:[]};
  },
  bufferedSamples(step){const limit=step.padSamples??step.wholeSamples??BigInt(step.packetSamples);return Number(limit<BigInt(step.packetSamples)?limit:BigInt(step.packetSamples));},
  stream:(step,frames,options,configured)=>padAudio(frames,{...options,...(configured?{emptyInput:configured}:{}),...(step.padSamples!==null?{padSamples:step.padSamples}:step.wholeSamples!==null?{wholeSamples:step.wholeSamples}:step.padDuration!==null?{padDurationMicros:step.padDuration}:{wholeDurationMicros:step.wholeDuration!}),packetSamples:step.packetSamples}),
  reserve(step,{sampleRate,samples:planned,configuredInput}){
    // padAudio allocates only the remaining finite tail, not packetSamples
    // unconditionally. Keep the reservation and allocation bound consistent:
    // a planned input reserves exactly the tail packet count() buffers.
    if(planned!==undefined){const added=paddingCount(step,planned,sampleRate,configuredInput),packet=BigInt(step.packetSamples);return added>0n?{frames:0,buffers:[{samples:Number(added<packet?added:packet),copies:1}],stateBytes:0n}:null;}
    let samples=step.packetSamples;
    const duration=step.padDuration??step.wholeDuration;
    const limit=step.padSamples??step.wholeSamples??(duration===null?null:(duration*BigInt(sampleRate)+500000n)/1000000n);
    if(limit!==null&&limit<BigInt(samples))samples=Number(limit);
    return {frames:0,buffers:[{samples,copies:1}],stateBytes:0n};
  }
});
