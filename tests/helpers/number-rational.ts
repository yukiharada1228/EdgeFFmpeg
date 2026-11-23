import {numberToBoundedRational} from '@edge-ffmpeg/avutil';
export interface NumberRationalCase {bits:string;max:number}
export function evaluateNumberRational(row:NumberRationalCase){const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,BigInt('0x'+row.bits));const value=numberToBoundedRational(view.getFloat64(0),row.max);return {num:String(value.num),den:String(value.den)};}
