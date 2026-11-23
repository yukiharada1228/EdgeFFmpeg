// SPDX-License-Identifier: LGPL-2.1-or-later
// Video branch of libavformat/mux.c guess_pkt_duration at pinned commit
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
import {rescale} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
/** Mux duration inference is separate from filter and encoder duration. */
export function videoPacketDuration(duration:bigint,averageFrameRate:Rational,timeBase:Rational):bigint{
 if(typeof duration!=='bigint'||timeBase.num<=0n||timeBase.den<=0n)throw new Error('Invalid packet duration or timebase');
 if(duration>0n)return duration;
 if(averageFrameRate.num>0n&&averageFrameRate.den>0n)return rescale(1n,{num:averageFrameRate.den,den:averageFrameRate.num},timeBase);
 return timeBase.num*1000n>timeBase.den?1n:0n;
}
