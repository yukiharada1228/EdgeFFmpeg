import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFormatCheck} from './descriptor.js';
import {AudioFilterError,defineAudioFilter,frameReservation,packed,sampleFormats,widths} from './descriptor.js';
export interface AudioFormatStep {readonly name:'aformat';readonly sampleFormat:AudioSampleFormat|null;readonly sampleRate?:number;readonly channelLayout?:'mono'|'stereo'}
/** Singleton constraints. Rate and layout are checked, never converted implicitly. */
function check(step:AudioFormatStep):AudioFormatCheck|null {
  if(step.sampleRate===undefined&&step.channelLayout===undefined)return null;
  return format=>{
    if(step.sampleRate!==undefined&&step.sampleRate!==format.sampleRate)throw new AudioFilterError('aformat sample rate constraint requires an implicit conversion');
    if(step.channelLayout!==undefined&&(step.channelLayout!==format.channelLayout||format.channels!==(step.channelLayout==='mono'?1:2)))throw new AudioFilterError('aformat channel layout constraint requires an implicit conversion');
  };
}
export const aformat=defineAudioFilter<AudioFormatStep>({
  name:'aformat',
  examples:['aformat','aformat=f=flt','aformat=r=8000','aformat=cl=stereo'],
  parse(text){
    let sampleFormat:AudioSampleFormat|null=null,sampleRate:number|undefined,channelLayout:'mono'|'stereo'|undefined;
    if(text!=='aformat')for(const [index,option]of text.slice(8).split(':').entries()){
      const parts=option.includes('=')?option.split('='):[index===0?'sample_fmts':'',option];
      if(parts.length!==2)throw new AudioFilterError('Invalid singleton aformat constraint');
      const [name,value]=parts;
      if(name==='sample_rates'||name==='r'){
        if(!/^\d+$/.test(value??'')||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)throw new AudioFilterError('aformat requires one supported sample rate');
        sampleRate=Number(value);
      }else if(name==='channel_layouts'||name==='cl'){
        if(value!=='mono'&&value!=='stereo')throw new AudioFilterError('aformat requires one supported channel layout');
        channelLayout=value;
      }else{
        if(!['sample_fmts','f'].includes(name??'')||!sampleFormats.includes(value??''))throw new AudioFilterError('aformat currently requires one supported sample format');
        sampleFormat=value as AudioSampleFormat;
      }
    }
    return Object.freeze({name:'aformat',sampleFormat,...(sampleRate!==undefined?{sampleRate}:{}),...(channelLayout!==undefined?{channelLayout}:{})});
  },
  capabilities:step=>({generatesOutput:false,reframes:false,allocatesFrames:step.sampleFormat!==null,formatConstraint:true,rateConversion:true,timeSelection:step.sampleFormat!==null||step.sampleRate!==undefined||step.channelLayout!==undefined,flacInput:true}),
  precision:step=>step.sampleFormat?{bytesPerSample:widths[packed(step.sampleFormat)]!,kind:step.sampleFormat.startsWith('flt')?'flt':step.sampleFormat.startsWith('dbl')?'dbl':'integer'}:null,
  formats:step=>step.sampleFormat??'all',
  constraint:check,
  apply(step,frame,_target,options){check(step)?.(frame);return step.sampleFormat?convertAudioFrame(frame,step.sampleFormat,options):frame;},
  reserve:step=>step.sampleFormat?frameReservation:null
});
