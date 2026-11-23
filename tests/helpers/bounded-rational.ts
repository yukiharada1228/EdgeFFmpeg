import {reduceBoundedRational} from '@edge-ffmpeg/avutil';
export type BoundedRationalCase=readonly [string,string,string];
export function evaluateBoundedRational(row:BoundedRationalCase){const result=reduceBoundedRational(BigInt(row[0]),BigInt(row[1]),BigInt(row[2]));return {num:String(result.num),den:String(result.den),exact:result.exact};}
