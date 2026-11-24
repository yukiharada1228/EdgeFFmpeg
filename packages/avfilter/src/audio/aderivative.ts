import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,packed,widths} from './descriptor.js';
export interface AudioDerivativeStep {readonly name:'aderivative'}
/** Working width of the negotiated format for an arriving format: u8 widens to s16p, every other input keeps its sample type. */
const working=(format:string)=>Math.max(2,widths[packed(format as never)]??8);
/** af_aderivative.c: dst[n]=src[n]-prev per channel; prev starts at zero and carries across frames. Integer differences wrap in two's complement. */
export const aderivative=defineAudioFilter<AudioDerivativeStep>({
  name:'aderivative',
  examples:['aderivative'],
  parse(text){
    if(text==='aderivative')return Object.freeze({name:'aderivative'});
    const rest=text.slice(12);
    if(/^enable(?:=|$)/.test(rest))throw new AudioFilterError('aderivative timeline enable is not implemented');
    throw new AudioFilterError(`Unsupported aderivative option: ${rest}`);
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['s16p','fltp','s32p','dblp'],
  async *stream(_step,frames,options,_configured,negotiated){
    let previous:Float64Array|null=null,channels=0;
    for await(const frame of frames as AsyncIterable<AudioFrameData>){
      options.signal?.throwIfAborted();
      const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as never),options),format=packed(output.sampleFormat as never);
      if(previous===null){channels=output.channels;previous=new Float64Array(channels);}
      else if(output.channels!==channels)throw new AudioFilterError('aderivative channel count changed between frames');
      if(output.planes.length!==channels)throw new AudioFilterError('aderivative requires planar frames');
      for(let channel=0;channel<channels;channel++){
        const plane=output.planes[channel]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
        let prior=previous[channel]!;
        for(let index=0;index<output.samples;index++){
          if((index&16383)===0)options.signal?.throwIfAborted();
          if(format==='s16'){const current=view.getInt16(index*2,true);view.setInt16(index*2,(current-prior)<<16>>16,true);prior=current;}
          else if(format==='s32'){const current=view.getInt32(index*4,true);view.setInt32(index*4,(current-prior)|0,true);prior=current;}
          else if(format==='flt'){const current=view.getFloat32(index*4,true);if(!Number.isFinite(current))throw new AudioFilterError('Non-finite aderivative input is not yet supported');view.setFloat32(index*4,Math.fround(current-prior),true);prior=current;}
          else if(format==='dbl'){const current=view.getFloat64(index*8,true);if(!Number.isFinite(current))throw new AudioFilterError('Non-finite aderivative input is not yet supported');view.setFloat64(index*8,current-prior,true);prior=current;}
          else throw new AudioFilterError(`aderivative with ${output.sampleFormat} is not implemented`);
        }
        previous[channel]=prior;
      }
      yield output;
    }
  },
  // One output frame plus the one-sample previous value per channel at the working width.
  reserve:(_step,{channels,sampleFormat})=>({frames:1,buffers:[],stateBytes:BigInt(channels*working(sampleFormat))})
});
