import {resolveVideoOutputOptions} from './option-order.js';
import {parseEncoderTimeBase} from './encoder-ratio.js';
import type {Option} from '@edge-ffmpeg/cli';
import {parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile,Rational} from '@edge-ffmpeg/avutil';
import type {VideoSyncMode} from './sync.js';
export type EncoderTimeBase=Rational|'demux'|'filter';
type DeclaredSyncMode='auto'|'cfr'|'vfr'|'passthrough';
/** One video stream per output. Literal decimal, scientific and ratio clock values are supported. */
export function parseVideoOutputOptions(options:readonly Option[],format:'rawvideo'|'framecrc',context:{readonly copyTs?:boolean;readonly directVideoSource?:boolean;readonly numericProfile?:ExpressionNumericProfile}={}){
 let rate:Rational|undefined,maximum:Rational|undefined,mode:DeclaredSyncMode='auto',encoderTimeBase:EncoderTimeBase|undefined;const remaining:Option[]=[];
 for(const option of resolveVideoOutputOptions(options)){const base=option.name.split(':')[0]!;if(!['-r','-fpsmax','-fps_mode','-enc_time_base'].includes(base)){remaining.push(option);continue;}
  if(!['',':v',':0',':v:0'].includes(option.name.slice(base.length)))throw new Error('Unsupported output video stream specifier');if(option.value===null)throw new Error('Missing output option value');
  if(base==='-r'){rate=parseVideoFrameRate(option.value);continue;}
  if(base==='-fpsmax'){maximum=parseVideoFrameRate(option.value);continue;}
  if(base==='-fps_mode'){const value=option.value.toLowerCase();if(!['auto','cfr','vfr','passthrough'].includes(value))throw new Error('Invalid fps_mode');mode=value as DeclaredSyncMode;continue;}
  encoderTimeBase=parseEncoderTimeBase(option.value,context.numericProfile);
 }
 if(rate&&maximum)throw new Error('Cannot combine output rate and maximum rate');
 if((rate||maximum)&&mode!=='auto'&&mode!=='cfr')throw new Error('Output rate contradicts non-CFR synchronization');
 let selected:VideoSyncMode=mode==='auto'?((rate||maximum)?'cfr':format==='rawvideo'?'cfr':'vfr'):mode;
 if(mode==='auto'&&selected==='cfr'&&(context.copyTs||context.directVideoSource))selected='vscfr';
 return Object.freeze({mode:selected,...(maximum?{outputMaxFrameRate:Object.freeze({...maximum})}:{}),...(rate?{outputFrameRate:Object.freeze({...rate})}:{}),...(encoderTimeBase?{encoderTimeBase:typeof encoderTimeBase==='object'?Object.freeze({...encoderTimeBase}):encoderTimeBase}:{}),remaining:Object.freeze(remaining)});
}
