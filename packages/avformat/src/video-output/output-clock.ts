// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts vf_stack.c config_output and fftools/ffmpeg_filter.c
// choose_out_timebase at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Scoped to rawvideo encoding without codec-supported-rate constraints.
import {rescale} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import type {VideoSyncMode} from './sync.js';
const positive=(q:Rational)=>q.num>0n&&q.den>0n;
const copy=(q:Rational)=>Object.freeze({...q});
/** Compare declared fields: reducing equivalent rates would change Native negotiation. */
export function stackFrameRate(rates:readonly Rational[]):Rational{
 if(!rates.length)throw new Error('Stack requires inputs');const first=rates[0]!;
 return copy(rates.every(rate=>rate.num===first.num&&rate.den===first.den)?first:{num:1n,den:0n});
}
export function rawVideoOutputClock(options:{readonly mode:VideoSyncMode;readonly sinkFrameRate:Rational;readonly filterTimeBase:Rational;readonly outputFrameRate?:Rational;readonly outputMaxFrameRate?:Rational;readonly encoderTimeBase?:Rational|'demux'|'filter';readonly demuxTimeBase?:Rational}){
 const {mode,sinkFrameRate,filterTimeBase}=options;if(!positive(filterTimeBase))throw new Error('Invalid filter timebase');
 if(options.outputFrameRate&&!positive(options.outputFrameRate))throw new Error('Invalid output frame rate');
 if(options.outputMaxFrameRate&&!positive(options.outputMaxFrameRate))throw new Error('Invalid maximum output frame rate');
 if(options.outputFrameRate&&options.outputMaxFrameRate)throw new Error('Cannot combine output rate and maximum rate');
 if((options.outputFrameRate||options.outputMaxFrameRate)&&mode!=='cfr'&&mode!=='vscfr')throw new Error('Output rate contradicts non-CFR synchronization');
 let frameRate=options.outputFrameRate??(positive(sinkFrameRate)?sinkFrameRate:{num:0n,den:0n});
 const fallback=(mode==='cfr'||mode==='vscfr')&&frameRate.num===0n&&!options.outputMaxFrameRate;if(fallback)frameRate={num:25n,den:1n};
 if((mode==='cfr'||mode==='vscfr')&&options.outputMaxFrameRate&&(!frameRate.den||Number(frameRate.num)/Number(frameRate.den)>Number(options.outputMaxFrameRate.num)/Number(options.outputMaxFrameRate.den)))frameRate=options.outputMaxFrameRate;
 const requested=options.encoderTimeBase,explicit=requested==='filter'?filterTimeBase:requested==='demux'?options.demuxTimeBase:requested;if(requested==='demux'&&(!explicit||!positive(explicit)))throw new Error('Demuxing timebase not available');if(explicit&&!positive(explicit))throw new Error('Invalid encoder timebase');
 const timeBase=explicit??(positive(frameRate)?{num:frameRate.den,den:frameRate.num}:filterTimeBase);
 return Object.freeze({mode,frameRate:copy(frameRate),timeBase:copy(timeBase),fallback});
}
/** Stack outputs omit duration; fill only when the sink advertises a valid rate. */
export function fillVideoDuration(duration:bigint,sinkFrameRate:Rational,timeBase:Rational):bigint{
 if(duration<0n)throw new Error('Invalid duration');if(duration||!positive(sinkFrameRate))return duration;
 return rescale(1n,{num:sinkFrameRate.den,den:sinkFrameRate.num},timeBase);
}
