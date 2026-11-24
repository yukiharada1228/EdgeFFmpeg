import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export type AudioPermsMode = 'none'|'ro'|'rw'|'toggle'|'random';
export interface AudioPermsStep {readonly name:'aperms';readonly mode:AudioPermsMode;readonly seed:bigint|null}
const modes:readonly AudioPermsMode[]=['none','ro','rw','toggle','random'];
/** f_perms.c: frame permissions only (writable flag, reference clone); sample data, counts and timestamps never change, so the step is the identity.
 * Options follow the AVOption order mode, seed (positional or named). random needs an explicit seed: the default -1 calls av_get_random_seed.
 */
export const aperms=defineAudioFilter<AudioPermsStep>({
  name:'aperms',
  examples:['aperms','aperms=mode=toggle','aperms=mode=random:seed=7'],
  parse(text){
    if(text!=='aperms'&&!text.startsWith('aperms='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    let mode:AudioPermsMode='none',seed:bigint|null=null,named=false;
    if(text!=='aperms')for(const [index,option]of text.slice(7).split(':').entries()){
      const parts=option.includes('=')?option.split('='):named||index>1?[]:[index===0?'mode':'seed',option];
      if(parts.length!==2)throw new AudioFilterError('Invalid aperms option');
      const [name,value]=parts as [string,string];if(option.includes('='))named=true;
      if(name==='mode'){
        if(!modes.includes(value as AudioPermsMode))throw new AudioFilterError(`Unsupported aperms mode: ${value}`);
        mode=value as AudioPermsMode;
      }else if(name==='seed'){
        if(!/^(-1|0|[1-9]\d{0,9})$/.test(value)||BigInt(value)>4294967295n)throw new AudioFilterError(`Invalid aperms seed: ${value}`);
        seed=value==='-1'?null:BigInt(value);
      }else throw new AudioFilterError(`Unsupported aperms option: ${name}`);
    }
    if(mode==='random'&&seed===null)throw new AudioFilterError('aperms random mode requires an explicit seed');
    return Object.freeze({name:'aperms',mode,seed});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:false,timeSelection:false}),
  // Output samples are the input samples: the merged format passes through and the input frame is returned without a second ownership claim.
  apply:(_step,frame)=>frame
});
