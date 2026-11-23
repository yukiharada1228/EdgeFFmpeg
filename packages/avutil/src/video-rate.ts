import {rational} from './rational.js';
import type {Rational} from './rational.js';
export class VideoRateError extends Error {}
export function videoFrameRate(rate:Rational):Rational{
  if(typeof rate?.num!=='bigint'||typeof rate?.den!=='bigint'||rate.num<1n||rate.den<1n)throw new VideoRateError('Invalid video frame rate');
  const value=rational(rate.num,rate.den);if(value.num>2147483647n||value.den>2147483647n)throw new VideoRateError('Video frame rate exceeds signed32');return Object.freeze(value);
}
/** Exact finite rate syntax within the native default ratio bound; expressions remain unsupported. */
export function parseVideoFrameRate(text:string):Rational{
  const aliases:Record<string,readonly [bigint,bigint]>={ntsc:[30000n,1001n],pal:[25n,1n],qntsc:[30000n,1001n],qpal:[25n,1n],sntsc:[30000n,1001n],spal:[25n,1n],film:[24n,1n],'ntsc-film':[24000n,1001n]};
  const alias=Object.hasOwn(aliases,text)?aliases[text]:undefined;if(alias)return videoFrameRate({num:alias[0],den:alias[1]});
  if(text.length>128)throw new VideoRateError('Invalid video frame rate syntax');
  let num:bigint,den:bigint;
  if(/^\d+\/\d+$/.test(text)){const parts=text.split('/');num=BigInt(parts[0]!);den=BigInt(parts[1]!);}
  else if(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)){const parts=text.split('.');den=10n**BigInt(parts[1]?.length??0);num=BigInt((parts[0]||'0')+(parts[1]??''));}
  else throw new VideoRateError('Unsupported video frame rate syntax');
  const rate=videoFrameRate({num,den});if(rate.num>1001000n||rate.den>1001000n)throw new VideoRateError('Video rate requires unimplemented native ratio approximation');return rate;
}
