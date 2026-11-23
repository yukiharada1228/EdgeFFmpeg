import {fusedMultiplyAdd} from './fma.js';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame,AudioConversionError} from './convert.js';
import type {AudioConversionOptions,PackedSampleFormat,AudioSampleFormat} from './convert.js';
export type RemixArithmetic='separate'|'fused';
export interface AudioRemixOptions extends AudioConversionOptions {readonly arithmetic?:RemixArithmetic;readonly matrixSampleFormat?:AudioSampleFormat}
const integer=(format:PackedSampleFormat)=>['u8','s16','s32'].includes(format);
/** Native default mono/stereo matrix profile at unchanged rate. */
export function remixInternalFormat(source:AudioSampleFormat,target:AudioSampleFormat):'s16'|'flt'|'dbl'{
  const sourceBase=source.endsWith('p')?source.slice(0,-1):source,targetBase=target.endsWith('p')?target.slice(0,-1):target;
  if(!['u8','s16','s32','flt','dbl'].includes(sourceBase)||!['u8','s16','s32','flt','dbl'].includes(targetBase))throw new AudioConversionError('Unsupported remix sample format');
  if(sourceBase==='dbl')return 'dbl';
  return ['u8','s16'].includes(sourceBase)&&['u8','s16'].includes(targetBase)?'s16':'flt';
}
/** Owned packed or planar output. Only canonical mono/stereo layouts; no resampling or delay. */
export function remixAudioFrame(frame:AudioFrameData,channels:1|2,target:AudioSampleFormat,options:AudioRemixOptions):AudioFrameData{
  options.signal?.throwIfAborted();
  const arithmetic=options.arithmetic??'separate';if(arithmetic!=='separate'&&arithmetic!=='fused')throw new AudioConversionError('Unsupported remix arithmetic profile');
  const targetPlanar=target.endsWith('p'),targetBase=(targetPlanar?target.slice(0,-1):target) as PackedSampleFormat,sourcePlanar=frame.sampleFormat.endsWith('p');
  if(!['u8','s16','s32','flt','dbl'].includes(targetBase)||![1,2].includes(channels)||![1,2].includes(frame.channels)||frame.channelLayout!==(frame.channels===1?'mono':'stereo'))throw new AudioConversionError('Remixing currently requires canonical mono/stereo layouts and supported sample formats');
  if(channels===frame.channels)return convertAudioFrame(frame,target,options);
  const internal=remixInternalFormat(frame.sampleFormat as AudioSampleFormat,target),width=internal==='s16'?2:internal==='flt'?4:8,size=frame.samples*channels*width;
  if(!Number.isSafeInteger(size)||size<1||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1||size>options.maxFrameBytes)throw new AudioConversionError('Remixed audio frame exceeds allocation limit');
  const inputFormat=`${internal}${sourcePlanar?'p':''}` as AudioSampleFormat,outputFormat=`${internal}${targetPlanar?'p':''}` as AudioSampleFormat;
  const converted=convertAudioFrame(frame,inputFormat,options),inputs=converted.planes.map(plane=>new DataView(plane.buffer,plane.byteOffset,plane.byteLength)),data=new Uint8Array(size),output=new DataView(data.buffer);
  // A combined rate conversion retains its FIR precision while the final
  // encoder's integer/float constraint still determines matrix normalization.
  const matrixTarget=options.matrixSampleFormat??target;
  const matrixBase=(matrixTarget.endsWith('p')?matrixTarget.slice(0,-1):matrixTarget) as PackedSampleFormat;
  if(!['u8','s16','s32','flt','dbl'].includes(matrixBase))throw new AudioConversionError('Unsupported remix matrix sample format');
  const gain=frame.channels===2&&integer(matrixBase)?0.5:Math.SQRT1_2;
  for(let sample=0;sample<frame.samples;sample++){
    if((sample&4095)===0)options.signal?.throwIfAborted();
    const read=(channel:number)=>{const input=inputs[sourcePlanar?channel:0]!,offset=(sourcePlanar?sample:sample*frame.channels+channel)*width;return internal==='s16'?input.getInt16(offset,true):internal==='flt'?input.getFloat32(offset,true):input.getFloat64(offset,true);};
    const a=read(0),b=frame.channels===2?read(1):0;
    if(!Number.isFinite(a)||!Number.isFinite(b))throw new AudioConversionError('Non-finite rematrix input is not implemented');
    let value:number;
    if(internal==='s16'){
      const coefficient=Math.floor(gain*32768+0.5);value=Math.max(-32768,Math.min(32767,Math.floor((a*coefficient+b*coefficient+16384)/32768)));
    }else if(internal==='flt'){
      const coefficient=Math.fround(gain);value=frame.channels===1?Math.fround(a*coefficient):arithmetic==='fused'?fusedMultiplyAdd(a,coefficient,Math.fround(b*coefficient),24):Math.fround(Math.fround(a*coefficient)+Math.fround(b*coefficient));
    }else value=frame.channels===1?a*gain:arithmetic==='fused'?fusedMultiplyAdd(a,gain,b*gain,53):a*gain+b*gain;
    for(let channel=0;channel<channels;channel++){const offset=(targetPlanar?channel*frame.samples+sample:sample*channels+channel)*width;if(internal==='s16')output.setInt16(offset,value,true);else if(internal==='flt')output.setFloat32(offset,value,true);else output.setFloat64(offset,value,true);}
  }
  const mixed:AudioFrameData={...converted,channels,sampleFormat:outputFormat,channelLayout:channels===1?'mono':'stereo',planes:targetPlanar?Array.from({length:channels},(_,channel)=>data.subarray(channel*frame.samples*width,(channel+1)*frame.samples*width)):[data]};
  return outputFormat===target?mixed:convertAudioFrame(mixed,target,options);
}
