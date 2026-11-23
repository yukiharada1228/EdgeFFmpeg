// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
import type {FlacFrameHeader} from './types.js';
/** Domains produced by header.ts and pinned libavcodec/flac.c, not stricter
 * STREAMINFO/spec limits. GET_UTF8 accepts overlong encodings up to six bytes
 * (31 value bits). Rate codes 0..11 and the byte*kHz code are contained in
 * the union of the uint16 Hz and uint16*10 Hz encodings. Zero is inherited.
 * Only fields consumed by the descriptor graph/parser are validated here.
 */
export function isEncodableFlacHeader(header:FlacFrameHeader):boolean{
 if(!header||header.kind!=='candidate'||typeof header.variable!=='boolean'||typeof header.number!=='bigint'||header.number<0n||header.number>0x7fffffffn)return false;
 const {blockSamples,channels,bitsPerSample,sampleRate}=header;
 return Number.isSafeInteger(blockSamples)&&blockSamples>=1&&blockSamples<=65536
  &&Number.isSafeInteger(channels)&&channels>=1&&channels<=8
  &&[0,8,12,16,20,24,32].includes(bitsPerSample)
  &&Number.isSafeInteger(sampleRate)&&sampleRate>=0
  &&(sampleRate<=65535||sampleRate<=655350&&sampleRate%10===0);
}
