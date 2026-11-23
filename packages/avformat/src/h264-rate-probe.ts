// SPDX-License-Identifier: LGPL-2.1-or-later
// Standard-rate error accumulation, reduction and rate selection adapted from
// libavformat/demux.c ff_rfps_add_frame/ff_rfps_calculate and avformat.c
// av_guess_frame_rate at946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (c)2000,2001,2002 Fabrice Bellard
// See NOTICE-MP4-COPY and packages/containers/COPYING.LGPLv2.1.
import {reduceBoundedRational} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import {roundEven} from './video-output/sync.js';
const count=399,max=(1n<<63n)-1n;
function standard(i:number):number{if(i<360)return(i+1)*1001;i-=360;if(i<30)return(i+31)*1001*12;i-=30;if(i<3)return[80,120,240][i]!*1001*12;return[24,30,60,12,15,48][i-3]!*1000*12;}
const value=(q:Rational)=>Number(q.num)/Number(q.den),gcd=(a:bigint,b:bigint):bigint=>{while(b){const n=a%b;a=b;b=n;}return a;};
/** Finite H264 MOV rate probe with fixed399-entry native standard-rate tables. */
export function createH264RateProbe(timeBase:Rational){
 const errors=new Float64Array(4*count),tb=value(timeBase),limit=tb>0.0005?40:20;let last:bigint|null=null,n=0,sum=0n,durationGcd=0n,codecDuration=0n;
 return {feed(dts:bigint|null,duration:bigint|null){if(n>=limit||Number(codecDuration)*tb>=5)return;if(duration!==null&&duration>0n&&duration<max-codecDuration)codecDuration+=duration;
  if(dts!==null&&last!==null&&dts>last&&dts-last<max){const seconds=Number(dts)*tb,delta=dts-last;
   for(let i=0;i<count;i++)if(errors[count+i]!<1e10){const scaled=seconds*standard(i)/(1001*12);for(let j=0;j<2;j++){const error=scaled-Number(roundEven(scaled+j*0.5))+j*0.5;errors[j*2*count+i]=errors[j*2*count+i]!+error;errors[(j*2+1)*count+i]=errors[(j*2+1)*count+i]!+error*error;}}
   if(sum<=max-delta){n++;sum+=delta;}if(n%10===0)for(let i=0;i<count;i++)if(errors[count+i]!<1e10){const a0=errors[i]!/n,e0=errors[count+i]!/n-a0*a0,a1=errors[2*count+i]!/n,e1=errors[3*count+i]!/n-a1*a1;if(e0>0.04&&e1>0.04){errors[count+i]=2e10;errors[3*count+i]=2e10;}}if(n>3)durationGcd=gcd(durationGcd,delta);
  }if(dts!==null)last=dts;
 },finish(average:Rational,codec:Rational,constant:bigint|null){let rate:Rational=constant!==null&&constant>0n?reduceBoundedRational(timeBase.den,timeBase.num*constant):{num:0n,den:1n};
  if(!rate.num&&n>15&&durationGcd>(timeBase.den/(500n*timeBase.num)>1n?timeBase.den/(500n*timeBase.num):1n)&&durationGcd<max/timeBase.num)rate=reduceBoundedRational(timeBase.den,timeBase.num*durationGcd);
  if(!rate.num&&n>1){let best=0.01,num=0;for(let i=0;i<count;i++){const frequency=standard(i);if(codecDuration&&Number(codecDuration)*tb<(1001*11.5)/frequency)continue;if(!codecDuration&&frequency<1001*12)continue;if(tb*Number(sum)/n<(1001*12*0.8)/frequency)continue;for(let k=0;k<2;k++){const a=errors[k*2*count+i]!/n,error=errors[(k*2+1)*count+i]!/n-a*a;if(error<best&&best>1e-9){best=error;num=frequency;}}}if(num&&num/(12*1001)<1.01/tb)rate=reduceBoundedRational(BigInt(num),12n*1001n);}
  if(!rate.num)rate=codec.num>0n?reduceBoundedRational(2n*codec.num,codec.den):{num:timeBase.den,den:timeBase.num};
  if(average.num>0n&&average.den>0n&&rate.num>0n&&rate.den>0n&&value(average)<70&&value(rate)>210)rate=average;
  if(codec.num>0n&&codec.den>0n&&(!rate.num||value(codec)<value(rate)*0.7&&Math.abs(1-value(average)/value(rate))>0.1))rate=codec;
  return Object.freeze({num:rate.num,den:rate.den});
 }};
}
