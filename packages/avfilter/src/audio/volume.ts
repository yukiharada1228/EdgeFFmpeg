import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation,isInteger,packed,widths} from './descriptor.js';
export interface AudioVolumeStep {readonly name:'volume';readonly gain:number;readonly precision:'fixed'|'float'|'double'}
function gainValue(text: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:dB)?$/.test(text)) throw new AudioFilterError('Only constant numeric/dB volume expressions are implemented');
  const gain = text.endsWith('dB') ? 10 ** (Number(text.slice(0,-2)) / 20) : Number(text);
  if (!Number.isFinite(gain)) throw new AudioFilterError('Volume gain must be finite');
  return gain;
}
/** Constant gain. Float/double pin packed flt/dbl; fixed keeps packed integers with Q8 gain and saturation. */
export const volume=defineAudioFilter<AudioVolumeStep>({
  name:'volume',
  examples:['volume=0.5','volume=0.5:precision=fixed','volume=2:precision=double'],
  parse(text){
    let gain = 1, precision: 'fixed' | 'float' | 'double' = 'float';
    if (text !== 'volume') {
      for (const [index, option] of text.slice(7).split(':').entries()) {
        if (option.startsWith('precision=')) {
          const value = option.slice(10);
          if (value !== 'fixed' && value !== 'float' && value !== 'double') throw new AudioFilterError('Unsupported volume precision');
          precision = value;
        } else if (option.startsWith('volume=')) gain = gainValue(option.slice(7));
        else if (index === 0 && !option.includes('=')) gain = gainValue(option);
        else throw new AudioFilterError(`Unsupported volume option: ${option}`);
      }
    }
    if (precision === 'float' && !Number.isFinite(Math.fround(gain))) throw new AudioFilterError('Volume gain exceeds selected precision');
    if (precision === 'fixed' && gain > 65535) throw new AudioFilterError('Fixed volume gain exceeds the supported integer arithmetic profile');
    return Object.freeze({ name: 'volume', gain, precision });
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:true,timeSelection:true,flacInput:true}),
  precision:step=>({bytesPerSample:step.precision==='double'?8:4,kind:step.precision==='fixed'?'integer':step.precision==='double'?'dbl':'flt'}),
  formats:step=>step.precision==='fixed'?'integer':step.precision==='double'?'dbl':'flt',
  nativeFormats:step=>step.precision==='fixed'?['u8','u8p','s16','s16p','s32','s32p']:step.precision==='double'?['dbl','dblp']:['flt','fltp'],
  negotiate(step,input,{outputHint,nextPinned,planarNeighbour}){
    if (step.precision !== 'fixed') return step.precision === 'double' ? 'dbl' : 'flt';
    let current = input;
    if (!isInteger(current)&&planarNeighbour!==null) {
      // A planar-only neighbour (adelay) merged into the fixed-volume format set keeps the encoder format out; native then picks s32p from floating input.
      if(nextPinned!==null&&isInteger(nextPinned))throw new AudioFilterError(`${planarNeighbour} with fixed volume and an integer sample format constraint on floating input requires unimplemented format negotiation`);
      current='s32';
    }
    else if (!isInteger(current)) {
      // A later floating pin keeps s32; otherwise the next integer pin or the encoder format is reachable.
      const output=nextPinned??outputHint;
      current = isInteger(output) ? packed(output) : 's32';
    }
    return packed(current);
  },
  apply(step,frame,target,options){
    const converted = convertAudioFrame(frame, target, options);
    const data = converted.planes[0]!, view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = widths[target]!;
    if (step.precision === 'fixed') {
      const quantized = BigInt(Math.floor(Math.max(0,step.gain) * 256 + 0.5));
      const low = target === 'u8' ? -128n : target === 's16' ? -32768n : -2147483648n;
      const high = target === 'u8' ? 127n : target === 's16' ? 32767n : 2147483647n;
      for (let offset = 0; offset < data.length; offset += width) {
        if ((offset & 16383) === 0) options.signal?.throwIfAborted();
        const value = target === 'u8' ? view.getUint8(offset) - 128 : target === 's16' ? view.getInt16(offset,true) : view.getInt32(offset,true);
        const scaled = (BigInt(value) * quantized + 128n) >> 8n;
        const clipped = Number(scaled < low ? low : scaled > high ? high : scaled);
        if (target === 'u8') view.setUint8(offset,clipped + 128);
        else if (target === 's16') view.setInt16(offset,clipped,true);
        else view.setInt32(offset,clipped,true);
      }
      return converted;
    }
    const gain = step.precision === 'double' ? step.gain : Math.fround(step.gain);
    if (!Number.isFinite(gain)) throw new AudioFilterError('Volume gain exceeds selected precision');
    for (let offset = 0; offset < data.length; offset += width) {
      if ((offset & 16383) === 0) options.signal?.throwIfAborted();
      const value = width === 8 ? view.getFloat64(offset,true) : view.getFloat32(offset,true);
      if (!Number.isFinite(value)) throw new AudioFilterError('Non-finite volume input is not yet supported');
      if (width === 8) view.setFloat64(offset,value * gain,true);
      else view.setFloat32(offset,value * gain,true);
    }
    return converted;
  },
  reserve:()=>frameReservation
});
