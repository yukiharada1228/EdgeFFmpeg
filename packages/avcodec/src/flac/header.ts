/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Experimental adaptation of pinned FFmpeg9.0.2 FLAC header parsing.
 * See ../../NOTICE-FLAC-PARSER and ../../COPYING.LGPLv2.1.
 */
import type {FlacHeaderResult} from './types.js';
const rates=[0,88200,176400,192000,8000,16000,22050,24000,32000,44100,48000,96000];
const blocks=[0,192,576,1152,2304,4608,0,0,256,512,1024,2048,4096,8192,16384,32768];
const bits=[0,8,12,0,16,20,24,32];
class Incomplete{constructor(readonly needed:number){}}
class Invalid{constructor(readonly reason:string){}}
export function crc8Atm(bytes:Uint8Array):number{let crc=0;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&128)?7:0))&255;}return crc;}
/** Reads at most17bytes and returns header candidates, never frame validity.
 * Native's integer encoding accepts overlong1..6byte numbers, rejects FE/FF.
 * Inherited rate/bps stay0; caller must resolve STREAMINFO separately.
 */
export function parseFlacHeaderCandidate(bytes:Uint8Array,offset=0):FlacHeaderResult{
 if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(offset)||offset<0||offset>bytes.length)throw new RangeError('Invalid FLAC header view');
 let position=offset;
 function byte(){if(position-offset>=17)throw new Invalid('header-limit');if(position>=bytes.length)throw new Incomplete(position-offset+1);return bytes[position++]!;}
 const u16=()=>byte()*256+byte();
 try{
  const a=byte(),b=byte();if(a!==255||(b&254)!==248)throw new Invalid('sync');const variable=!!(b&1),codes=byte(),fields=byte(),blockCode=codes>>4,rateCode=codes&15,assignment=fields>>4,bitsCode=(fields>>1)&7;
  if(assignment>10)throw new Invalid('channel-mode');const channels=assignment<8?assignment+1:2,channelMode=assignment<8?0:assignment-7;
  if(bitsCode===3)throw new Invalid('bits-per-sample');if(fields&1)throw new Invalid('padding');
  const first=byte();if((first&192)===128||first>=254)throw new Invalid('number-encoding');let number=BigInt(first);
  if(first&128){let length=0;for(let mask=128;first&mask;mask>>=1)length++;number=BigInt(first&((1<<(7-length))-1));for(let i=1;i<length;i++){const continuation=byte();if((continuation&192)!==128)throw new Invalid('number-encoding');number=(number<<6n)|BigInt(continuation&63);}}
  if(blockCode===0)throw new Invalid('blocksize');const blockSamples=blockCode===6?byte()+1:blockCode===7?u16()+1:blocks[blockCode]!;
  let sampleRate;if(rateCode<12)sampleRate=rates[rateCode]!;else if(rateCode===12)sampleRate=byte()*1000;else if(rateCode===13)sampleRate=u16();else if(rateCode===14)sampleRate=u16()*10;else throw new Invalid('sample-rate');
  byte();const headerBytes=position-offset;if(crc8Atm(bytes.subarray(offset,position))!==0)throw new Invalid('header-crc');
  const subframe=byte(),subframeType=(subframe>>1)&63;if(subframe&128||!(subframeType===0||subframeType===1||subframeType>=8&&subframeType<=12||subframeType>=32))throw new Invalid('subframe');
  return Object.freeze({kind:'candidate',variable,number,channels,channelMode,bitsPerSample:bits[bitsCode]!,sampleRate,blockSamples,headerBytes,inspectedBytes:position-offset,subframeType,needsStreamInfo:sampleRate===0||bits[bitsCode]! ===0});
 }catch(error){if(error instanceof Incomplete)return Object.freeze({kind:'incomplete',needed:error.needed});if(error instanceof Invalid)return Object.freeze({kind:'invalid',reason:error.reason});throw error;}
}
