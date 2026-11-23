// SPDX-License-Identifier: LGPL-2.1-or-later
// Rescale sentinel/overflow semantics adapt pinned libavutil/mathematics.c.
// Copyright (c) 2005-2012 Michael Niedermayer.
import {rescale} from '@edge-ffmpeg/avutil';import type {Rational} from '@edge-ffmpeg/avutil';
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
/** Native AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX, including overflow sentinel. */
export function rescaleTimestamp(value:bigint,source:Rational,target:Rational):bigint{
 if(value===MIN||value===MAX)return value;const result=rescale(value,source,target);return result<MIN||result>MAX?MIN:result;
}
