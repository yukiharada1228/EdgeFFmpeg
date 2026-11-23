import {formatPrint} from "@edge-ffmpeg/avutil";
export interface FilterLogEntry {readonly level:number;readonly text:string;readonly bytes:Uint8Array}
export function commandLog(time:number,command:string,argument:string){return `Processing command time:${formatPrint(time).slice(0,-1)} command:${command} arg:${argument}\n`;}
export function filterLogEntry(level:number,text:string|Uint8Array,capacity?:number):FilterLogEntry{const encoded=typeof text==='string'?new TextEncoder().encode(text):new Uint8Array(text),bytes=capacity===undefined?encoded:encoded.slice(0,Math.max(0,capacity-1));return Object.freeze({level,text:new TextDecoder().decode(bytes),bytes});}
