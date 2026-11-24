import {reframeAudio} from '../reframe.js';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioSetSamplesStep {readonly name:'asetnsamples';readonly samples:number;readonly pad:boolean}
/** Bounded FIFO: fixed-size output frames; the last is optionally zero padded. */
export const asetnsamples=defineAudioFilter<AudioSetSamplesStep>({
  name:'asetnsamples',
  examples:['asetnsamples=4','asetnsamples=n=4:p=0'],
  parse(text){
    let samples=1024,pad=true;
    if(text!=='asetnsamples')for(const [index,option]of text.slice(13).split(':').entries()){
      const parts=option.includes('=')?option.split('='):[index===0?'n':'',option];
      if(parts.length!==2)throw new AudioFilterError('Invalid asetnsamples option');
      const [name,value]=parts;
      if(['n','nb_out_samples'].includes(name??'')){
        if(!/^\d+$/.test(value??'')||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)throw new AudioFilterError('Invalid asetnsamples sample count');
        samples=Number(value);
      }else if(['p','pad'].includes(name??'')){
        if(!['0','1','false','true'].includes(value??''))throw new AudioFilterError('Unsupported asetnsamples padding value');
        pad=value==='1'||value==='true';
      }else throw new AudioFilterError('Unsupported asetnsamples option');
    }
    return Object.freeze({name:'asetnsamples',samples,pad});
  },
  // Final-frame padding stays inside the last reframed packet, so no packet is generated beyond the input's.
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:false,formatConstraint:false,rateConversion:true,timeSelection:true,flacInput:true}),
  count:(step,samples)=>({samples:step.pad?((samples+BigInt(step.samples)-1n)/BigInt(step.samples))*BigInt(step.samples):samples,buffers:[step.samples],packets:{reframe:BigInt(step.samples)}}),
  packetSpan:step=>BigInt(step.samples),
  bufferedSamples:step=>step.samples,
  stream:(step,frames,options)=>reframeAudio(frames,step.samples,step.pad,options),
  // Partial FIFO buffer plus its completed output.
  reserve:step=>({frames:0,buffers:[{samples:step.samples,copies:2}],stateBytes:0n})
});
