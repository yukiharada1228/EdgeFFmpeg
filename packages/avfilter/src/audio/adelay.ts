import {audioDelayPacketSamples,audioDelayPlan,audioDelaySamples,delayAudio,parseAudioDelay} from '../delay.js';
import type {AudioDelayStep} from '../delay.js';
import {defineAudioFilter,packed,widths} from './descriptor.js';
/** Per-channel delay in the planar form of the input precision: common leading silence, delay rings and a trailing flush. */
export const adelay=defineAudioFilter<AudioDelayStep>({
  name:'adelay',
  examples:['adelay','adelay=1S|4S'],
  parse:parseAudioDelay,
  capabilities:()=>({generatesOutput:true,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:true}),
  count(step,samples,rate,{channels}){
    const {padding,flush}=audioDelayPlan(step,rate,channels),chunk=BigInt(audioDelayPacketSamples);
    const leading=padding>0n?{samples:padding,span:chunk}:null,trailing=flush>0n?{samples:flush,span:chunk}:null;
    return {samples:samples+padding+flush,buffers:[...(leading?[Number(padding<chunk?padding:chunk)]:[]),...(trailing?[Number(flush)]:[])],...(leading||trailing?{packets:{...(leading?{leading}:{}),...(trailing?{trailing}:{})}}:{})};
  },
  formats:()=>'planar',
  nativeFormats:()=>['u8p','s16p','s32p','fltp','dblp'],
  transparent:true,
  stream:(step,frames,options,configured)=>delayAudio(frames,step,{...options,...(configured?{emptyInput:configured}:{})}),
  // One output frame (leading silence, delayed input or flush) plus rings of (delay - minimum delay) samples per channel at the planar input width.
  reserve(step,{sampleRate,channels,sampleFormat}){
    const delays=audioDelaySamples(step,sampleRate,channels),minimum=delays.reduce((low,delay)=>delay<low?delay:low);
    return {frames:1,buffers:[],stateBytes:delays.reduce((sum,delay)=>sum+delay-minimum,0n)*BigInt(widths[packed(sampleFormat)]??0)};
  }
});
