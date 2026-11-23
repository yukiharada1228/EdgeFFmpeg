/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flac_picture.c and id3v2.c, Copyright (c) 2001/2003 Fabrice Bellard;
 * libavutil/base64.c, Copyright (c) 2006 Ryan Martell.
 * LGPL-2.1-or-later. Metadata characterization only; no image decoding or full demux claim.
 */
/* SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER. */
import {createFlacPictureHeaderMachine} from './picture-header-machine.js';
export {FlacPictureLimitError} from './picture-tables.js';
import type { FlacPictureOptions } from './picture-types.js';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Caller supplies and owns the destination. Return-1 means invalid text;
 * output written before failure is unspecified and must not be consumed. */
export function decodeReferenceBase64Into(output:Uint8Array,text:string){if(!(output instanceof Uint8Array)||typeof text!=='string')throw new TypeError('Invalid base64 buffer');let written=0,value=0,count=0;const emit=(byte:number)=>{if(written<output.length)output[written++]=byte;};
 for(let i=0;;i++){const char=text[i];if(char===undefined||char==='='||char==='\0'){if(count===2)emit(value>>4);else if(count===3){emit(value>>10);emit(value>>2);}return written;}const n=alphabet.indexOf(char);if(n<0)return -1;value=(value<<6)|n;count++;if(count===4){emit(value>>16);emit(value>>8);emit(value);value=0;count=0;}}
}
export function parseFlacPicturePayload(bytes:Uint8Array,options:FlacPictureOptions={}){
 if(!(bytes instanceof Uint8Array))throw new TypeError('Invalid picture payload');const parser=createFlacPictureHeaderMachine({payloadBytes:bytes.length,...options});let item=parser.next();while(!item.done){const {offset,length}=item.value;if(offset<0||length<0||offset+length>bytes.length)throw new Error('Invalid picture header read');item=parser.next(bytes.subarray(offset,offset+length));}return item.value;
}
