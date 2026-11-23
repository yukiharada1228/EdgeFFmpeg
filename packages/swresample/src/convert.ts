import type { AudioFrameData } from '@edge-ffmpeg/avutil';
export type PackedSampleFormat = 'u8' | 's16' | 's32' | 'flt' | 'dbl';
export type PlanarSampleFormat = 'u8p'|'s16p'|'s32p'|'fltp'|'dblp';
export type AudioSampleFormat = PackedSampleFormat | PlanarSampleFormat;
export interface AudioConversionOptions { readonly maxFrameBytes: number; readonly signal?: AbortSignal }
export class AudioConversionError extends Error {}
const widths: Record<PackedSampleFormat, number> = { u8: 1, s16: 2, s32: 4, flt: 4, dbl: 8 };
function width(format: string): number {
  const base=format.endsWith('p')?format.slice(0,-1):format;
  if (!Object.hasOwn(widths, base)) throw new AudioConversionError('Unsupported audio sample format');
  return widths[base as PackedSampleFormat];
}
function roundEven(value: number): number {
  const low = Math.floor(value), fraction = value - low;
  return fraction < 0.5 ? low : fraction > 0.5 ? low + 1 : low % 2 === 0 ? low : low + 1;
}
/** Deterministic scalar format conversion. Rate, channels, sample count and PTS are preserved.
 * Float-to-integer currently accepts only finite samples with magnitude <= 32768.
 */
export function convertAudioFrame(frame: AudioFrameData, target: AudioSampleFormat, options: AudioConversionOptions): AudioFrameData {
  options.signal?.throwIfAborted();
  const sourceWidth = width(frame.sampleFormat), targetWidth = width(target);
  if (!Number.isSafeInteger(frame.channels) || frame.channels <= 0 || !Number.isSafeInteger(frame.samples) || frame.samples <= 0 || !Number.isSafeInteger(frame.sampleRate) || frame.sampleRate <= 0) throw new AudioConversionError('Invalid audio dimensions');
  const count = frame.channels * frame.samples, size = count * targetWidth;
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes <= 0 || !Number.isSafeInteger(size) || size > options.maxFrameBytes) throw new AudioConversionError('Converted audio frame exceeds allocation limit');
  const sourcePlanar=frame.sampleFormat.endsWith('p'),targetPlanar=target.endsWith('p');
  const sourceFormat=(sourcePlanar?frame.sampleFormat.slice(0,-1):frame.sampleFormat) as PackedSampleFormat,targetFormat=(targetPlanar?target.slice(0,-1):target) as PackedSampleFormat;
  if(frame.planes.length!==(sourcePlanar?frame.channels:1))throw new AudioConversionError('Invalid audio plane dimensions');
  for(let plane=0;plane<frame.planes.length;plane++){options.signal?.throwIfAborted();const bytes=frame.planes[plane];if(!(bytes instanceof Uint8Array)||bytes.length!==frame.samples*(sourcePlanar?1:frame.channels)*sourceWidth)throw new AudioConversionError('Invalid audio plane dimensions');}
  const data=new Uint8Array(size),planeBytes=frame.samples*targetWidth;
  const planes=targetPlanar?Array.from({length:frame.channels},(_,channel)=>data.subarray(channel*planeBytes,(channel+1)*planeBytes)):[data];
  const sources=frame.planes.map(plane=>new DataView(plane.buffer,plane.byteOffset,plane.byteLength)),output=new DataView(data.buffer);
  {
    const integerSource = ['u8', 's16', 's32'].includes(sourceFormat), integerTarget = ['u8','s16','s32'].includes(targetFormat);
    for (let i = 0; i < count; i++) {
      if ((i & 4095) === 0) options.signal?.throwIfAborted();
      const channel=i%frame.channels,sample=Math.floor(i/frame.channels),source=sources[sourcePlanar?channel:0]!;
      const sourceOffset=(sourcePlanar?sample:i)*sourceWidth,targetOffset=(targetPlanar?channel*frame.samples+sample:i)*targetWidth;
      if(sourceFormat===targetFormat){
        const input=frame.planes[sourcePlanar?channel:0]!;data.set(input.subarray(sourceOffset,sourceOffset+sourceWidth),targetOffset);continue;
      }
      if (integerSource && integerTarget) {
        const value = sourceFormat === 'u8' ? (source.getUint8(sourceOffset) - 128) << 24 : sourceFormat === 's16' ? source.getInt16(sourceOffset, true) << 16 : source.getInt32(sourceOffset, true);
        if (targetFormat === 'u8') output.setUint8(targetOffset, (value >> 24) + 128);
        else if (targetFormat === 's16') output.setInt16(targetOffset, value >> 16, true);
        else output.setInt32(targetOffset, value, true);
        continue;
      }
      const value = sourceFormat === 'u8' ? (source.getUint8(sourceOffset) - 128) / 128 : sourceFormat === 's16' ? source.getInt16(sourceOffset, true) / 32768 : sourceFormat === 's32' ? source.getInt32(sourceOffset, true) / 2147483648 : sourceFormat === 'flt' ? source.getFloat32(sourceOffset, true) : source.getFloat64(sourceOffset, true);
      if (integerTarget) {
        if (!Number.isFinite(value) || value < -32768 || value > 32768) throw new AudioConversionError('Non-finite or out-of-range floating PCM requires an unimplemented runtime conversion profile');
        if (targetFormat === 'u8') output.setUint8(targetOffset, Math.max(0, Math.min(255, roundEven(value * 128) + 128)));
        else if (targetFormat === 's16') output.setInt16(targetOffset, Math.max(-32768, Math.min(32767, roundEven(value * 32768))), true);
        else output.setInt32(targetOffset, Math.max(-2147483648, Math.min(2147483647, roundEven(value * 2147483648))), true);
      } else {
        if (Number.isNaN(value)) throw new AudioConversionError('Cross-precision NaN payload conversion is not yet supported');
        if (targetFormat === 'flt') output.setFloat32(targetOffset, value, true);
        else output.setFloat64(targetOffset, value, true);
      }
    }
  }
  return { ...frame, sampleFormat: target, planes, pts: frame.pts === null ? null : { value: frame.pts.value, timeBase: { ...frame.pts.timeBase } } };
}
