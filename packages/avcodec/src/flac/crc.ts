// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
export function crc16Byte(value:number,byte:number):number{value^=byte<<8;for(let bit=0;bit<8;bit++)value=((value<<1)^((value&32768)?32773:0))&65535;return value;}
function validCrc(value:number):void{if(!Number.isSafeInteger(value)||value<0||value>65535)throw new RangeError('Invalid CRC16 state');}
/** Apply the zero-byte linear operator without converting64bit lengths to number. */
export function advanceCrc16(value:number,length:bigint):number{
 validCrc(value);if(typeof length!=='bigint'||length<0n||length>0xffffffffffffffffn)throw new RangeError('Invalid CRC16 span');
 function apply(matrix:Uint16Array,input:number):number{let result=0,bit=0;while(input){if(input&1)result^=matrix[bit]!;input>>>=1;bit++;}return result;}
 let matrix=Uint16Array.from({length:16},(_,bit)=>crc16Byte(1<<bit,0));
 while(length){if(length&1n)value=apply(matrix,value);length>>=1n;if(length)matrix=Uint16Array.from(matrix,column=>apply(matrix,column));}return value;
}
export function crc16Between(before:number,after:number,length:bigint):number{validCrc(after);return after^advanceCrc16(before,length);}
/** Update the unreflected FLAC CRC16 state by one byte, initially zero. */
export function updateFlacCrc16(value:number,byte:number):number{validCrc(value);if(!Number.isSafeInteger(byte)||byte<0||byte>255)throw new RangeError('Invalid FLAC CRC16 byte');return crc16Byte(value,byte);}
