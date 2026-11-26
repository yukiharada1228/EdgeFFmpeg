// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/pcmdec.c (ff_sln_demuxer, pcm_read_header) and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-SLN.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {defineContainer} from './registry-descriptor.js';
export class SlnError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface SlnInfo extends RawPcmInfo {readonly container:'sln'}
export interface SlnInput extends Omit<RawPcmInput,'info'> {readonly info:SlnInfo}
/** sln_options defaults (sample_rate=8000, ch_layout=mono) and raw_codec_id pcm_s16le; the -sample_rate/-ch_layout options and input -ar/-ac are refused upstream of open. */
const sampleRate=8000,channels=1,blockAlign=2;
/** Finite headerless Asterisk SLN: the whole input is pcm_s16le 8000 Hz mono, read in bounded packets by openRawPcm. */
export async function openSln(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal;readonly seek?:bigint}):Promise<SlnInput>{
  const {maxReadBytes,signal,seek=0n}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<blockAlign)throw new SlnError('resource-limit','Invalid SLN read budget');
  if(input.size<0n)throw new SlnError('invalid-data','Invalid SLN input size');
  if(input.size%BigInt(blockAlign))throw new SlnError('unsupported','SLN partial trailing sample is not implemented');
  if(seek>0n)throw new SlnError('unsupported','SLN input seek is not implemented');
  const raw=await openRawPcm(input,{codec:'pcm_s16le',channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,container:'sln' as const}),packets:raw.packets});
}
/** Demux-only (native has no sln muxer) and without read_probe: undeclared inputs are detected only by the .sln extension (score 50). Packets use the default pcmPacketSpan(8000)=512. */
export const sln=defineContainer({
  name:'sln',
  demux:{extensions:['.sln'],headerBytes:0,open:(source,{maxReadBytes,signal,seek})=>openSln(source,{maxReadBytes,signal,seek})}
});
