// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped fftools/cmdutils.c stream_specifier_parse/match, pinned commit
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../../NOTICE.
/** LP64 strtol(base 0), then the signed32 index field used by the pinned frontend. */
function streamIndex(text:string):bigint {
 if(!/^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(text))throw new Error('Unsupported video stream index');
 const hex=/^0[xX]/.test(text),octal=!hex&&text.length>1&&text[0]==='0',base=hex?16n:octal?8n:10n,digits=hex?text.slice(2):octal?text.slice(1):text,maximum=(1n<<63n)-1n;let value=0n;
 for(const digit of digits){value=value*base+BigInt(parseInt(digit,16));if(value>maximum)value=maximum;}
 return BigInt.asIntN(32,value);
}
/** One declared rawvideo stream, index zero, without attached-picture disposition. */
export function matchSingleVideoStream(specifier:string):boolean {
 if(specifier==='')return true;const parts=specifier.split(':');
 if(parts.length<=2&&['v','V','a','s','d','t'].includes(parts[0]!)){
  const index=parts[1]?streamIndex(parts[1]):-1n;
  return (parts[0]==='v'||parts[0]==='V')&&index<=0n;
 }
 if(parts.length===1)return streamIndex(specifier)<=0n;
 throw new Error('Unsupported video stream specifier');
}
export function videoOptionMatches(name:string):boolean {const colon=name.indexOf(':');return matchSingleVideoStream(colon<0?'':name.slice(colon+1));}
