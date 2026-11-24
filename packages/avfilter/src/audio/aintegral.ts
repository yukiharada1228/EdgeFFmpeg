import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioIntegralStep {readonly name:'aintegral'}
/** Running sum per channel (libavfilter/af_aderivative.c, INTEGRAL): dst[n]=src[n]+prev, prev=dst[n], in float for fltp and double for dblp.
 * The accumulator starts at zero and crosses frames; no options, timeline enable or commands.
 */
export const aintegral=defineAudioFilter<AudioIntegralStep>({
  name:'aintegral',
  examples:['aintegral'],
  parse(text){
    if(text==='aintegral')return Object.freeze({name:'aintegral'});
    const options=text.startsWith('aintegral=')?text.slice(10):text;
    if(options.split(':').some(option=>/^enable=/.test(option)))throw new AudioFilterError('aintegral timeline enable is not implemented');
    throw new AudioFilterError('aintegral accepts no options');
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['fltp','dblp'],
  async *stream(_step,frames,options,_configured,negotiated){
    let sums:Float64Array|null=null,format:'fltp'|'dblp'|null=null;
    for await(const frame of frames){
      options.signal?.throwIfAborted();
      const target=negotiated(frame.sampleFormat as AudioSampleFormat);
      if(target!=='fltp'&&target!=='dblp')throw new AudioFilterError(`aintegral cannot work in ${target}`);
      if(format!==null&&(target!==format||sums!.length!==frame.channels))throw new AudioFilterError('aintegral input format changed between frames');
      format=target;sums??=new Float64Array(frame.channels);
      const output=convertAudioFrame(frame,target,options),double=target==='dblp',width=double?8:4;
      for(let channel=0;channel<frame.channels;channel++){
        const plane=output.planes[channel]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
        let sum=sums[channel]!;
        for(let index=0;index<frame.samples;index++){
          if((index&4095)===0)options.signal?.throwIfAborted();
          const offset=index*width;
          if(double){sum=view.getFloat64(offset,true)+sum;view.setFloat64(offset,sum,true);}
          else{sum=Math.fround(view.getFloat32(offset,true)+sum);view.setFloat32(offset,sum,true);}
        }
        sums[channel]=sum;
      }
      yield output;
    }
  },
  // One output frame plus the per-channel accumulator, held as a double whichever of fltp and dblp the step negotiates.
  reserve:(_step,{channels})=>({frames:1,buffers:[],stateBytes:BigInt(channels)*8n})
});
