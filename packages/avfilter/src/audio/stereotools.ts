import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** Parsed stereotools options (af_stereotools.c AVOptions, native defaults and ranges). softclip and phase are always off: their libm arithmetic is refused. */
export interface AudioStereoToolsStep {
  readonly name:'stereotools';
  readonly levelIn:number;readonly levelOut:number;readonly balanceIn:number;readonly balanceOut:number;
  readonly softclip:false;readonly muteL:boolean;readonly muteR:boolean;readonly phaseL:boolean;readonly phaseR:boolean;
  /** 0 lr>lr, 1 lr>ms, 2 ms>lr, 3 lr>ll, 4 lr>rr, 5 lr>l+r, 6 lr>rl, 7 ms>ll, 8 ms>rr, 9 ms>rl, 10 lr>l-r. */
  readonly mode:number;
  readonly slev:number;readonly sbal:number;readonly mlev:number;readonly mpan:number;readonly base:number;readonly delay:number;readonly scLevel:number;readonly phase:0;
  /** 0 balance, 1 amplitude, 2 power. */
  readonly bmodeIn:number;readonly bmodeOut:number;
}
type Key = Exclude<keyof AudioStereoToolsStep,'name'>;
type Kind = 'double'|'bool'|'mode'|'bmode';
const level:[number,number]=[0.015625,64],unit:[number,number]=[-1,1];
/** AVOption declaration order without the CONST entries: positional values fill these, as libavfilter's shorthand does. */
const options:readonly [string,Key,Kind,number,number][]=[
  ['level_in','levelIn','double',...level],['level_out','levelOut','double',...level],['balance_in','balanceIn','double',...unit],['balance_out','balanceOut','double',...unit],
  ['softclip','softclip','bool',0,1],['mutel','muteL','bool',0,1],['muter','muteR','bool',0,1],['phasel','phaseL','bool',0,1],['phaser','phaseR','bool',0,1],['mode','mode','mode',0,10],
  ['slev','slev','double',...level],['sbal','sbal','double',...unit],['mlev','mlev','double',...level],['mpan','mpan','double',...unit],['base','base','double',...unit],
  ['delay','delay','double',-20,20],['sclevel','scLevel','double',1,100],['phase','phase','double',0,360],['bmode_in','bmodeIn','bmode',0,2],['bmode_out','bmodeOut','bmode',0,2]
];
const defaults:AudioStereoToolsStep=Object.freeze({name:'stereotools',levelIn:1,levelOut:1,balanceIn:0,balanceOut:0,softclip:false,muteL:false,muteR:false,phaseL:false,phaseR:false,mode:0,slev:1,sbal:0,mlev:1,mpan:0,base:0,delay:0,scLevel:1,phase:0,bmodeIn:0,bmodeOut:0});
const constants:Readonly<Record<'mode'|'bmode',Readonly<Record<string,number>>>>={
  mode:{'lr>lr':0,'lr>ms':1,'ms>lr':2,'lr>ll':3,'lr>rr':4,'lr>l+r':5,'lr>rl':6,'ms>ll':7,'ms>rr':8,'ms>rl':9,'lr>l-r':10},
  bmode:{balance:0,amplitude:1,power:2}
};
function value(name:string,kind:Kind,min:number,max:number,text:string):number|boolean {
  let parsed:number;
  if(kind==='bool'){
    // set_string_bool: case-insensitive names, else a whole base-10 integer; 'auto' is -1, outside [0,1].
    const lower=text.toLowerCase();
    if(['true','y','yes','enable','enabled','on'].includes(lower))return true;
    if(['false','n','no','disable','disabled','off'].includes(lower))return false;
    if(lower==='auto'||/^[+-]?\d+$/.test(text)){parsed=lower==='auto'?-1:Number(text);if(parsed<min||parsed>max)throw new AudioFilterError(`Unable to parse stereotools option ${name} value ${text} as boolean`);return parsed===1;}
    throw new AudioFilterError(`Only 0, 1 and boolean names are implemented for stereotools option ${name}`);
  }
  if(kind!=='double'){
    // AV_OPT_TYPE_INT with a unit: the whole value is looked up as a CONST name (case-sensitive) before it is evaluated.
    if(Object.hasOwn(constants[kind],text))return constants[kind][text]!;
    if(!/^[+-]?\d+$/.test(text))throw new AudioFilterError(`Only ${Object.keys(constants[kind]).join(', ')} or an integer are implemented for stereotools option ${name}`);
  }else if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new AudioFilterError(`Only constant decimal values are implemented for stereotools option ${name}`);
  parsed=Number(text);
  if(!Number.isFinite(parsed)||parsed<min||parsed>max)throw new AudioFilterError(`Value ${text} for stereotools option ${name} out of range [${min} - ${max}]`);
  // -0 for an integer option is stored as int 0.
  return kind==='double'?parsed:parsed+0;
}
/** config_input's ring length FFALIGN((sample_rate + 9) / 10, 2) and filter_frame's nbuf: (int)(rate * (fabs(delay) / 1000.)) rounded down to even. */
export function stereoToolsRing(step:AudioStereoToolsStep,sampleRate:number):{readonly length:number;readonly nbuf:number} {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<=0||sampleRate>2147483647)throw new AudioFilterError('Invalid stereotools sample rate');
  const length=(Math.trunc((sampleRate+9)/10)+1)&~1;let nbuf=Math.trunc(sampleRate*(Math.abs(step.delay)/1000.));
  nbuf-=nbuf%2;
  return {length,nbuf};
}
/** gl/gr for balance_in/balance_out under bmode 0 balance, 1 amplitude, 2 power, in filter_frame's order. */
function gains(balance:number,mode:number):[number,number] {
  let gl=1.-Math.max(0.,balance),gr=1.+Math.min(0.,balance);
  if(mode===1){const gd=gl-gr;gl=1.+gd;gr=1.-gd;}
  else if(mode===2){if(balance<0.){gr=Math.max(0.5,gr);gl=1./gr;}else if(balance>0.){gl=Math.max(0.5,gl);gr=1./gl;}}
  return [gl,gr];
}
/** FFMIN(a,b) is (a>b?b:a) and FFMAX(a,b) is (a>b?a:b); every operand here is finite. */
const min=(a:number,b:number)=>a>b?b:a;
/** filter_frame on packed stereo doubles in place, with ring and pos carried across frames; phase=0 makes the rotation `L*1 - R*0`, `L*0 + R*1`. */
export function stereoToolsSamples(step:AudioStereoToolsStep,data:Float64Array,ring:Float64Array,state:{pos:number},nbuf:number,signal?:AbortSignal):void {
  const sb=step.base<0?step.base*0.5:step.base,sbal=1+step.sbal,mpan=1+step.mpan,{slev,mlev,levelIn,levelOut,delay,mode}=step,length=ring.length;
  const muteL=step.muteL?1:0,muteR=step.muteR?1:0,phaseL=step.phaseL?1:0,phaseR=step.phaseR?1:0,cos=1,sin=0;
  const [gli,gri]=gains(step.balanceIn,step.bmodeIn),[glo,gro]=gains(step.balanceOut,step.bmodeOut);
  let pos=state.pos;
  for(let n=0;n+1<data.length;n+=2){
    if((n&8191)===0)signal?.throwIfAborted();
    let L=data[n]!,R=data[n+1]!,l:number,r:number,m:number,S:number;
    // Inf*0 and Inf-Inf give a NaN whose sign the host's default NaN decides; neither is mirrored.
    if(!Number.isFinite(L)||!Number.isFinite(R))throw new AudioFilterError('Non-finite stereotools input is not yet supported');
    L*=levelIn;R*=levelIn;
    L*=gli;R*=gri;
    switch(mode){
      case 0:m=(L+R)*0.5;S=(L-R)*0.5;l=m*mlev*min(1.,2.-mpan)+S*slev*min(1.,2.-sbal);r=m*mlev*min(1.,mpan)-S*slev*min(1.,sbal);L=l;R=r;break;
      case 1:l=L*min(1.,2.-sbal);r=R*min(1.,sbal);L=0.5*(l+r)*mlev;R=0.5*(l-r)*slev;break;
      case 2:l=L*mlev*min(1.,2.-mpan)+R*slev*min(1.,2.-sbal);r=L*mlev*min(1.,mpan)-R*slev*min(1.,sbal);L=l;R=r;break;
      case 3:R=L;break;
      case 4:L=R;break;
      case 5:L=(L+R)*0.5;R=L;break;
      case 6:l=L;L=R;R=l;m=(L+R)*0.5;S=(L-R)*0.5;l=m*mlev*min(1.,2.-mpan)+S*slev*min(1.,2.-sbal);r=m*mlev*min(1.,mpan)-S*slev*min(1.,sbal);L=l;R=r;break;
      case 7:l=L*mlev*min(1.,2.-mpan)+R*slev*min(1.,2.-sbal);L=l;R=l;break;
      case 8:r=L*mlev*min(1.,mpan)-R*slev*min(1.,sbal);L=r;R=r;break;
      case 9:l=L*mlev*min(1.,2.-mpan)+R*slev*min(1.,2.-sbal);r=L*mlev*min(1.,mpan)-R*slev*min(1.,sbal);L=r;R=l;break;
      case 10:L=(L-R)*0.5;R=L;break;
    }
    L*=1.-muteL;R*=1.-muteR;
    L*=(2.*(1.-phaseL))-1.;R*=(2.*(1.-phaseR))-1.;
    ring[pos]=L;ring[pos+1]=R;
    if(delay>0.)R=ring[(pos-nbuf+1+length)%length]!;
    else if(delay<0.)L=ring[(pos-nbuf+length)%length]!;
    l=L+sb*L-sb*R;r=R+sb*R-sb*L;L=l;R=r;
    l=L*cos-R*sin;r=L*sin+R*cos;L=l;R=r;
    pos=(pos+2)%length;
    L*=glo;R*=gro;
    L*=levelOut;R*=levelOut;
    if(Number.isNaN(L)||Number.isNaN(R))throw new AudioFilterError('NaN stereotools output is not yet supported');
    data[n]=L;data[n+1]=R;
  }
  state.pos=pos;
}
/** Stereo matrix, balance, delay and base: af_stereotools.c on pinned packed dbl stereo, with its ring carried across frames. */
export const stereotools=defineAudioFilter<AudioStereoToolsStep>({
  name:'stereotools',
  examples:['stereotools','stereotools=mode=ms>lr:slev=2:sbal=-0.3:mlev=0.5:mpan=0.4:base=-0.6:delay=-3:balance_in=0.4:bmode_in=power:balance_out=-0.2:bmode_out=amplitude','stereotools=0.5:2:0:0:0:1:0:0:1:lr>rl'],
  parse(text){
    if(text==='stereotools')return defaults;
    if(!text.startsWith('stereotools=')||text.length===12)throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    const step:Record<string,unknown>={...defaults};let position=0,named=false;
    for(const option of text.slice(12).split(':')){
      if(/['"\\]/.test(option))throw new AudioFilterError('Quoted or escaped stereotools options are not implemented');
      const equals=option.indexOf('=');
      if(equals<0&&named)throw new AudioFilterError(`No stereotools option name near ${option}`);
      if(equals>=0&&option.slice(0,equals)==='enable')throw new AudioFilterError('stereotools timeline enable is not implemented');
      const entry=equals<0?options[position++]:options.find(([name])=>name===option.slice(0,equals));
      if(equals>=0)named=true;
      if(!entry)throw new AudioFilterError(equals<0?`Too many stereotools option values near ${option}`:`Unsupported stereotools option: ${option.slice(0,equals)}`);
      const [name,key,kind,low,high]=entry;
      step[key]=value(name,kind,low,high,equals<0?option:option.slice(equals+1));
    }
    if(step.softclip)throw new AudioFilterError('stereotools softclip requires unimplemented libm arithmetic');
    if(step.phase!==0)throw new AudioFilterError('stereotools phase requires unimplemented libm arithmetic');
    step.phase=0;
    return Object.freeze(step) as unknown as AudioStereoToolsStep;
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dbl'],
  constraint:()=>format=>{
    if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError(`stereotools requires stereo input; ${format.channelLayout} would be remixed implicitly`);
  },
  async *stream(step,frames,options,_configured,negotiated){
    let ring:Float64Array|null=null,rate=0,nbuf=0;const state={pos:0};
    for await(const frame of frames){
      options.signal?.throwIfAborted();
      if(frame.channels!==2||frame.channelLayout!=='stereo')throw new AudioFilterError(`stereotools requires stereo input; ${frame.channelLayout} would be remixed implicitly`);
      if(ring===null){
        const plan=stereoToolsRing(step,frame.sampleRate);
        if(plan.length*8>options.maxFrameBytes)throw new AudioFilterError('stereotools delay buffer exceeds allocation limit');
        ring=new Float64Array(plan.length);rate=frame.sampleRate;nbuf=plan.nbuf;
      }else if(frame.sampleRate!==rate)throw new AudioFilterError('stereotools sample rate changed between frames');
      const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as AudioSampleFormat),options);
      if(output.sampleFormat!=='dbl')throw new AudioFilterError(`stereotools requires dbl samples, not ${output.sampleFormat}`);
      const plane=output.planes[0]!,aligned=plane.byteOffset%8===0;
      const data=aligned?new Float64Array(plane.buffer,plane.byteOffset,output.samples*2):new Float64Array(plane.slice(0,output.samples*16).buffer);
      stereoToolsSamples(step,data,ring,state,nbuf,options.signal);
      if(!aligned)plane.set(new Uint8Array(data.buffer));
      yield output;
    }
  },
  // One output frame per input frame, plus config_input's ring of FFALIGN((rate+9)/10,2) doubles, allocated whatever the delay.
  reserve:(step,{sampleRate})=>({frames:1,buffers:[],stateBytes:BigInt(stereoToolsRing(step,sampleRate).length)*8n})
});
