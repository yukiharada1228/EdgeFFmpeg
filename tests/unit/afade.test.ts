import {describe,expect,it} from 'vitest';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {afadeBranch,afadeGain,afadeRange} from '../../packages/avfilter/src/audio/afade.js';
import type {AudioFadeCurve,AudioFadeStep} from '../../packages/avfilter/src/audio/afade.js';

const curves:readonly AudioFadeCurve[]=['tri','qua','cub','squ','par','ipar','desi','quat','nofade'];
const widthOf=(format:string)=>format.startsWith('s16')?2:format.startsWith('dbl')?8:4;
/** Deterministic frame: integers cover the full range, floats stay finite and include negatives and -0. */
function frame(format:AudioSampleFormat,samples:number,channels:number,pts:bigint,den=8000n):AudioFrameData {
  const width=widthOf(format),planar=format.endsWith('p'),data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);
  for(let k=0;k<samples*channels;k++){
    const offset=k*width,value=Math.sin(k*0.917+1)*((k%11)/10);
    if(format.startsWith('s16'))view.setInt16(offset,k===3?-32768:Math.round(value*32767),true);else if(format.startsWith('s32'))view.setInt32(offset,k===3?-2147483648:Math.round(value*2147483647),true);else if(format.startsWith('flt'))view.setFloat32(offset,k===0?-0:value,true);else view.setFloat64(offset,k===0?-0:value,true);
  }
  const planes=planar?Array.from({length:channels},(_,c)=>data.slice(c*samples*width,(c+1)*samples*width)):[data];
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples,planes,pts:{value:pts,timeBase:{num:1n,den}}};
}
/** Sample values of a frame in [channel][sample] order. */
function values(output:AudioFrameData):number[][] {
  const width=widthOf(output.sampleFormat),planar=output.sampleFormat.endsWith('p'),read=(view:DataView,offset:number)=>output.sampleFormat.startsWith('s16')?view.getInt16(offset,true):output.sampleFormat.startsWith('s32')?view.getInt32(offset,true):output.sampleFormat.startsWith('flt')?view.getFloat32(offset,true):view.getFloat64(offset,true);
  return Array.from({length:output.channels},(_,c)=>Array.from({length:output.samples},(_,i)=>{const plane=output.planes[planar?c:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return read(view,(planar?i:i*output.channels+c)*width);}));
}
/** Direct transcription of af_afade.c filter_frame and fade_gain (TRI..QUAT, NONE), independent of the descriptor. */
function reference(step:AudioFadeStep,input:AudioFrameData,rate:number):number[][] {
  const s=values(input),n=input.samples,cur=Number(input.pts!.value)*rate/Number(input.pts!.timeBase.den),type=step.type==='out'?1:0;
  const nb=step.duration?Math.round(Number(step.duration)*rate/1e6):Number(step.nbSamples),ss=step.startTime?Math.round(Number(step.startTime)*rate/1e6):Number(step.startSample);
  const integer=!input.sampleFormat.startsWith('flt')&&!input.sampleFormat.startsWith('dbl'),store=(v:number)=>integer?Math.trunc(v)+0:input.sampleFormat.startsWith('flt')?Math.fround(v):v;
  const fadeGain=(index:number)=>{
    let gain=Math.min(Math.max(1.0*index/nb,0),1.0);
    switch(step.curve){case 'ipar':gain=(1-(1-gain)*(1-gain));break;case 'qua':gain*=gain;break;case 'cub':gain=gain*gain*gain;break;case 'squ':gain=Math.sqrt(gain);break;case 'par':gain=1-Math.sqrt(1-gain);break;case 'desi':gain=gain<=0.5?((2*gain)*(2*gain)*(2*gain))/2:1-((2*(1-gain))*(2*(1-gain))*(2*(1-gain)))/2;break;case 'quat':gain=gain*gain*gain*gain;break;case 'nofade':gain=1.0;break;default:break;}
    return step.silence+(step.unity-step.silence)*gain;
  };
  if(step.unity===1&&((!type&&ss+nb<cur)||(type&&cur+n<ss)))return s;
  if((!type&&cur+n<ss)||(type&&ss+nb<cur))return s.map(channel=>channel.map(v=>step.silence===0?0:store(v*step.silence)));
  if((type&&cur+n<ss)||(!type&&ss+nb<cur))return s.map(channel=>channel.map(v=>store(v*step.unity)));
  const start=type?ss+nb-cur:cur-ss;
  return s.map(channel=>channel.map((v,i)=>store(v*fadeGain(start+i*(type?-1:1)))));
}
const same=(a:number[][],b:number[][])=>a.every((channel,c)=>channel.every((v,i)=>Object.is(v,b[c]![i])));

describe('afade syntax',()=>{
  it('accepts names, aliases, positional options and the last value of each field',()=>{
    const parse=(text:string)=>compileAudioFilterChain(text).steps[0];
    expect(parse('afade')).toEqual({name:'afade',type:'in',startSample:0n,nbSamples:44100n,startTime:0n,duration:0n,curve:'tri',silence:0,unity:1});
    expect(parse('afade=out:5:9:0.5:1:par:0.25:0.75')).toEqual({name:'afade',type:'out',startSample:5n,nbSamples:9n,startTime:500000n,duration:1000000n,curve:'par',silence:0.25,unity:0.75});
    expect(parse('afade=t=1:start_sample=3:ns=4:st=10ms:duration=250us:c=quat:unity=0.5')).toMatchObject({type:'out',startSample:3n,nbSamples:4n,startTime:10000n,duration:250n,curve:'quat',unity:0.5});
    expect(parse('afade=type=out:t=in:ss=1:start_sample=2:nb_samples=7:c=cub:curve=desi')).toMatchObject({type:'in',startSample:2n,nbSamples:7n,curve:'desi'});
    expect(parse('afade=0:c=nofade')).toMatchObject({type:'in',curve:'nofade'});
    for(const curve of curves)expect(parse(`afade=c=${curve}`)).toMatchObject({curve});
  });
  it('refuses libm curves and unimplemented syntax with exact messages',()=>{
    for(const curve of ['qsin','esin','hsin','log','cbr','exp','iqsin','ihsin','dese','losi','sinc','isinc','quatr','qsin2','hsin2'])expect(()=>compileAudioFilterChain(`afade=c=${curve}`)).toThrow(`afade curve ${curve} requires unimplemented libm functions`);
    for(const [text,message] of [
      ['afade=c=7','Unsupported afade curve: 7'],['afade=t=in+out','Unsupported afade type: in+out'],['afade=foo=1','Unsupported afade option: foo=1'],
      ['afade=ss=5:in','Unsupported afade option: in'],['afade=in:1:2:3:4:tri:0:1:9','Unsupported afade option: 9'],['afade=ss=','Missing afade start_sample value'],['afade=','Missing afade type value'],
      ['afade=ss=1e2','Only decimal integer afade start_sample values are implemented'],['afade=ns=0','afade nb_samples is out of range'],['afade=ns=9007199254740993','afade nb_samples values above 2^53 are not implemented'],
      ['afade=st=-1','afade start_time is out of range'],['afade=d=x','Invalid afade duration'],['afade=d=9007199254.740993','afade duration values above 2^53 microseconds are not implemented'],
      ['afade=silence=2','afade silence is out of range'],['afade=unity=-0.5','Only constant decimal afade unity values are implemented'],['afade=silence=1/2','Only constant decimal afade silence values are implemented'],
      ['afade=enable=gte(t\\,1)','Quoted or escaped afade options are not implemented'],['afade=c=\'tri\'','Quoted or escaped afade options are not implemented'],
      ['afade=silence=0.2:unity=0.9','afade silence and unity whose full gain does not round to unity depend on native frame boundaries, which are not implemented'],
    ] as const)expect(()=>compileAudioFilterChain(text),text).toThrow(message);
  });
});

describe('afade gain and branches',()=>{
  it('computes fade_gain per curve with clipping and the unfused silence/unity combination',()=>{
    const at=(curve:AudioFadeCurve,index:bigint,range=4n,silence=0,unity=1)=>afadeGain(curve,index,range,silence,unity);
    expect(curves.map(curve=>at(curve,1n))).toEqual([0.25,0.0625,0.015625,0.5,1-Math.sqrt(0.75),1-0.75*0.75,0.0625,0.25**4,1]);
    expect(curves.map(curve=>at(curve,3n))).toEqual([0.75,0.5625,0.421875,Math.sqrt(0.75),0.5,1-0.25*0.25,1-0.0625,0.75**4,1]);
    for(const curve of curves.filter(curve=>curve!=='nofade')){expect(at(curve,-5n)).toBe(0);expect(at(curve,0n)).toBe(0);expect(at(curve,4n)).toBe(1);expect(at(curve,99n)).toBe(1);}
    expect(at('tri',1n,3n,0.1,0.9)).toBe(0.1+(0.9-0.1)*(1/3));expect(at('nofade',-1n,3n,0.1,0.9)).toBe(0.1+(0.9-0.1)*1);
    expect(at('desi',2n)).toBe(0.5);expect(at('squ',1n,3n)).toBe(Math.sqrt(1/3));
  });
  it('maps durations at the link rate and selects filter_frame branches with strict comparisons',()=>{
    const step=(text:string)=>compileAudioFilterChain(text).steps[0] as AudioFadeStep;
    expect(afadeRange(step('afade=ss=7:ns=9'),8000)).toEqual({start:7n,samples:9n});
    expect(afadeRange(step('afade=ss=7:ns=9:st=0.000125:d=0.00025'),8000)).toEqual({start:1n,samples:2n});
    // av_parse_time truncates to 62 us; av_rescale then rounds half away from zero (500 us at 1000 Hz is 0.5 samples).
    expect(afadeRange(step('afade=d=0.0000625'),16000)).toEqual({start:0n,samples:1n});expect(()=>afadeRange(step('afade=d=0.0000625'),8000)).toThrow('zero samples');
    expect(afadeRange(step('afade=st=0.0015:d=0.0005'),1000)).toEqual({start:2n,samples:1n});
    expect(afadeRange(step('afade=d=0.0001'),44100)).toEqual({start:0n,samples:4n});
    expect(()=>afadeRange(step('afade=d=1us'),8000)).toThrow('afade duration rounds to zero samples at 8000 Hz');
    expect(()=>afadeRange(step('afade=st=9007199254:d=1'),2000000)).toThrow('afade ranges above 2^53 samples are not implemented');
    const fadeIn=step('afade=ss=10:ns=5'),fadeOut=step('afade=t=out:ss=10:ns=5'),quiet=step('afade=ss=10:ns=5:silence=0.5:unity=0.75');
    expect([0n,1n,6n,15n,16n].map(cur=>afadeBranch(fadeIn,cur,4,10n,5n))).toEqual(['silence','silence','fade','fade','pass']);
    expect([0n,6n,15n,16n].map(cur=>afadeBranch(fadeOut,cur,4,10n,5n))).toEqual(['pass','fade','fade','silence']);
    expect([0n,16n].map(cur=>afadeBranch(quiet,cur,4,10n,5n))).toEqual(['scale-silence','scale-unity']);
  });
  it('reads cur_sample from pts in any time base with near-infinity rounding',()=>{
    const chain=compileAudioFilterChain('afade=ns=100',{outputSampleFormat:'s16'}),input=frame('s16',2,1,0n),source=values(input)[0]!;
    const at=(value:bigint,den:bigint)=>values(chain.apply({...input,pts:{value,timeBase:{num:1n,den}}},{maxFrameBytes:64}))[0]!;
    const fade=(cur:number)=>source.map((v,i)=>Math.trunc(v*((cur+i)/100))+0);
    expect(at(1n,1000n)).toEqual(fade(8));expect(at(7n,2000n)).toEqual(fade(28));
    // 3/48000 s and 5/48000 s are 0.5 and 0.8333 samples at 8000 Hz: av_rescale_q rounds half away from zero.
    expect(at(3n,48000n)).toEqual(fade(1));expect(at(2n,48000n)).toEqual(fade(0));expect(at(-3n,48000n)).toEqual(fade(-1));
    expect(()=>chain.apply({...input,pts:null},{maxFrameBytes:64})).toThrow('afade requires frame timestamps');
  });
});

describe('afade planning and negotiation',()=>{
  it('negotiates the native list per output codec and plans counts and one owned frame',()=>{
    const table:Record<string,Record<string,string>>={u8:{u8:'s16',s16:'s16',s32:'s32',flt:'flt',dbl:'dbl'},s16:{u8:'s16',s16:'s16',s32:'s16',flt:'s16',dbl:'s16'},s32:{u8:'s32',s16:'s32',s32:'s32',flt:'s32',dbl:'s32'},flt:{u8:'flt',s16:'flt',s32:'flt',flt:'flt',dbl:'flt'},dbl:{u8:'dbl',s16:'dbl',s32:'dbl',flt:'dbl',dbl:'dbl'}};
    for(const [input,outputs] of Object.entries(table))for(const [output,expected] of Object.entries(outputs)){
      const chain=compileAudioFilterChain('afade=t=out',{outputSampleFormat:output as AudioSampleFormat});
      expect(chain.negotiatedSampleFormats(input as AudioSampleFormat),`${input}->${output}`).toEqual([expected]);
    }
    expect(compileAudioFilterChain('afade').negotiatedSampleFormats('s16p')).toEqual(['s16p']);
    const chain=compileAudioFilterChain('afade=t=out:st=1:d=0.5');
    expect(chain.nativeFormatLists).toBe(true);expect(chain.reframes).toBe(true);
    expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:true,allocatesFrames:true,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false});
    expect(chain.planSamples(1000n,8000)).toMatchObject({samples:1000n,buffers:[]});
    expect(chain.packetSections(1000n,512n,8000)).toEqual([{samples:1000n,span:512n}]);
    expect(chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:1000n,configuredInput:true,channels:2}).map(entry=>entry.reservation)).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
  });
  it('refuses zero-sample durations and nofade silence outside the window before output',()=>{
    const format={sampleRate:8000,channels:2,channelLayout:'stereo'};
    expect(()=>compileAudioFilterChain('afade=d=50us').validateInputFormat(format)).toThrow('afade duration rounds to zero samples at 8000 Hz');
    expect(()=>compileAudioFilterChain('afade=d=50us').validateInputFormat({...format,sampleRate:48000})).not.toThrow();
    for(const text of ['afade=t=out:c=nofade','afade=ss=1:c=nofade','afade=st=0.001:c=nofade:silence=0.5'])expect(()=>compileAudioFilterChain(text).validateInputFormat(format),text).toThrow('afade nofade with silence outside the fade depends on native frame boundaries, which are not implemented');
    for(const text of ['afade=c=nofade','afade=t=out:c=nofade:silence=0.5:unity=0.5','afade=st=0.00001:c=nofade'])expect(()=>compileAudioFilterChain(text).validateInputFormat(format),text).not.toThrow();
  });
  it('refuses floating fades with zero silence outside the window and runs integer and from-zero fades',()=>{
    for(const [text,output] of [['afade=t=out','flt'],['afade=ss=1','dbl'],['afade=t=out:ss=0:ns=1','flt']] as const)expect(()=>compileAudioFilterChain(text,{outputSampleFormat:output}).apply(frame(output,4,2,0n),{maxFrameBytes:1024}),text).toThrow(`afade with silence=0 on ${output} samples outside the fade depends on native frame boundaries, which are not implemented`);
    for(const [text,output] of [['afade=t=out','s16'],['afade=t=out:silence=0.5','flt'],['afade=ns=3','dbl'],['afade=st=0.00001','flt']] as const)expect(()=>compileAudioFilterChain(text,{outputSampleFormat:output}).apply(frame(output,4,2,0n),{maxFrameBytes:1024}),text).not.toThrow();
  });
});

describe('afade output',()=>{
  const formats:readonly AudioSampleFormat[]=['s16','s16p','s32','s32p','flt','fltp','dbl','dblp'];
  it('matches a direct C transcription for every curve, format and branch, and is invariant under frame splits where native is',()=>{
    let checked=0;
    for(const format of formats)for(const curve of curves)for(const options of ['ss=0:ns=37','ss=13:ns=29','t=out:ss=11:ns=31','t=out:ss=0:ns=1','ss=0:ns=100:silence=0.25:unity=0.5','t=out:ss=40:ns=7:silence=0.1:unity=0.9','st=0.002:d=0.003:silence=0.3:unity=0.3']){
      const text=`afade=${options}:c=${curve}`;let chain;
      try{chain=compileAudioFilterChain(text,{outputSampleFormat:format});chain.validateInputFormat({sampleRate:8000,channels:2,channelLayout:'stereo'});}catch{continue;}
      const step=chain.steps[0] as AudioFadeStep,floating=format.startsWith('flt')||format.startsWith('dbl');
      if(floating&&step.silence===0&&(step.type==='out'||afadeRange(step,8000).start>0n))continue;
      const whole=frame(format,96,2,0n),expected=reference(step,whole,8000),output=chain.apply(whole,{maxFrameBytes:4096});
      expect(output.sampleFormat).toBe(format);expect(same(values(output),expected),`${format} ${text}`).toBe(true);
      // Native's result depends on its frame boundaries only where the refusals apply; elsewhere any split gives the whole-frame result.
      for(const split of [1,7,29,50]){
        const pieces:number[][]=[[],[]];
        for(let at=0;at<96;at+=split){
          const count=Math.min(split,96-at),width=widthOf(format),planar=format.endsWith('p');
          const piece:AudioFrameData={...whole,samples:count,planes:planar?whole.planes.map(plane=>plane.slice(at*width,(at+count)*width)):[whole.planes[0]!.slice(at*2*width,(at+count)*2*width)],pts:{value:BigInt(at),timeBase:{num:1n,den:8000n}}};
          const result=values(chain.apply(piece,{maxFrameBytes:4096}));expect(same(result,reference(step,piece,8000)),`${format} ${text} ${split}@${at}`).toBe(true);
          pieces[0]!.push(...result[0]!);pieces[1]!.push(...result[1]!);
        }
        expect(same(pieces,expected),`${format} ${text} split ${split}`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
  it('processes streams frame by frame from pts, as filter_frame does',async()=>{
    const chain=compileAudioFilterChain('asetnsamples=5:p=0,afade=ss=3:ns=8:c=ipar',{outputSampleFormat:'s32'}),input=frame('s32',23,2,0n);
    async function* frames(){yield input;}
    const output:number[][]=[[],[]];
    for await(const piece of chain.process(frames(),{maxFrameBytes:4096})){const v=values(piece);output[0]!.push(...v[0]!);output[1]!.push(...v[1]!);}
    expect(same(output,reference(chain.steps[1] as AudioFadeStep,input,8000))).toBe(true);
  });
  it('never mutates its input, returns owned planes and keeps timing',()=>{
    for(const [format,text] of [['s16','afade=ss=100:ns=5'],['s16p','afade=t=out:ss=100:ns=5'],['flt','afade=ns=3'],['dblp','afade=ns=300:silence=0.5'],['s32','afade=ss=1:ns=2'],['fltp','afade=t=out:silence=0.5']] as const){
      const input=frame(format,9,2,4n),copy=input.planes.map(plane=>plane.slice()),output=compileAudioFilterChain(text,{outputSampleFormat:format}).apply(input,{maxFrameBytes:1024});
      expect(input.planes).toEqual(copy);expect(output.pts).toEqual(input.pts);expect(output.samples).toBe(9);
      for(const plane of output.planes)for(const original of input.planes)expect(plane.buffer).not.toBe(original.buffer);
    }
  });
  it('honours allocation limits, cancellation and non-finite input refusals',()=>{
    const chain=compileAudioFilterChain('afade=ns=3',{outputSampleFormat:'dbl'}),input=frame('dbl',8,2,0n);
    expect(()=>chain.apply(input,{maxFrameBytes:127})).toThrow('allocation limit');
    const controller=new AbortController();controller.abort();expect(()=>chain.apply(input,{maxFrameBytes:128,signal:controller.signal})).toThrow();
    const bad=frame('flt',2,1,0n);new DataView(bad.planes[0]!.buffer).setFloat32(4,Number.NaN,true);
    expect(()=>compileAudioFilterChain('afade=ns=3',{outputSampleFormat:'flt'}).apply(bad,{maxFrameBytes:64})).toThrow('Non-finite afade input is not implemented');
    // A silence-filled frame never reads its samples, as av_samples_set_silence does not.
    expect(values(compileAudioFilterChain('afade=ss=10:ns=3',{outputSampleFormat:'s16'}).apply(frame('s16',2,1,0n),{maxFrameBytes:64}))).toEqual([[0,0]]);
  });
});
