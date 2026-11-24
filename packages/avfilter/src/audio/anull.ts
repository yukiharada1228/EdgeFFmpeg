import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioNullStep {readonly name:'anull'}
/** Pass-through: returns the validated input frame itself, without a second ownership claim. */
export const anull=defineAudioFilter<AudioNullStep>({
  name:'anull',
  examples:['anull'],
  parse(text){if(text!=='anull')throw new AudioFilterError(`Unsupported audio filter: ${text}`);return Object.freeze({name:'anull'});},
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:true,timeSelection:true,flacInput:true}),
  apply:(_step,frame)=>frame
});
