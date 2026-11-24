import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioSetRateStep {readonly name:'asetrate';readonly sampleRate:number}
/** Reinterprets a sample-aligned timestamp at the new rate. */
function retime(pts:AudioFrameData['pts'],from:number,to:number):AudioFrameData['pts'] {
  if(pts===null)return null;
  const {num,den}=pts.timeBase,position=pts.value*num*BigInt(from);
  if(num<=0n||den<=0n||position%den!==0n)throw new AudioFilterError('asetrate requires sample-aligned timestamps');
  return {value:position/den,timeBase:{num:1n,den:BigInt(to)}};
}
/** Metadata-only rate reinterpretation; shared planes keep the original ownership claim. */
export const asetrate=defineAudioFilter<AudioSetRateStep>({
  name:'asetrate',
  examples:['asetrate=16000'],
  parse(text){
    let sampleRate=44100;
    if(text!=='asetrate')for(const [index,option] of text.slice(9).split(':').entries()){
      const value=option.startsWith('sample_rate=')?option.slice(12):option.startsWith('r=')?option.slice(2):index===0&&!option.includes('=')?option:'';
      if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)throw new AudioFilterError('Only positive integer asetrate values are implemented');
      sampleRate=Number(value);
    }
    return Object.freeze({name:'asetrate',sampleRate});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:true,timeSelection:false,flacInput:true}),
  outputRate:step=>step.sampleRate,
  apply:(step,frame)=>({...frame,sampleRate:step.sampleRate,pts:retime(frame.pts,frame.sampleRate,step.sampleRate)}),
  configure:(step,format)=>({...format,sampleRate:step.sampleRate,pts:retime(format.pts,format.sampleRate,step.sampleRate)})
});
