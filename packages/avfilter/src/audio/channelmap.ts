/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8: libavfilter/af_channelmap.c
 * (Copyright (c) 2012 Google, Inc.), channelmap_init, channelmap_config_input and channelmap_filter_frame. See packages/avfilter/NOTICE-CHANNELMAP.
 */
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {defaultChannelLayout} from '@edge-ffmpeg/avutil';
import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
/** MappingMode of af_channelmap.c; 'none' is a channel_layout without map. */
export type AudioChannelMapMode = 'none'|'one-int'|'one-str'|'pair-int-int'|'pair-int-str'|'pair-str-int'|'pair-str-str';
/** One mapping: an input index or channel id (resolved against the input layout), and its output index. */
export interface AudioChannelMapEntry {readonly inIndex:number|null;readonly inChannel:number|null;readonly outIndex:number}
/** The output layout: a mask, or the default layout of `channels` (mask null when that count has no default layout). */
export interface AudioChannelMapLayout {readonly channels:number;readonly mask:bigint|null;readonly name:string}
export interface AudioChannelMapStep {readonly name:'channelmap';readonly mode:AudioChannelMapMode;readonly map:readonly AudioChannelMapEntry[];readonly layout:AudioChannelMapLayout}
/** AVChannel ids 0-62 of channel_names (libavutil/channel_layout.c); av_channel_from_string matches them exactly. */
const channelNames:readonly (string|undefined)[]=Object.freeze(Object.assign(new Array<string|undefined>(63).fill(undefined),
 ['FL','FR','FC','LFE','BL','BR','FLC','FRC','BC','SL','SR','TC','TFL','TFC','TFR','TBL','TBC','TBR'],
 Object.fromEntries(['DL','DR','WL','WR','SDL','SDR','LFE2','TSL','TSR','BFC','BFL','BFR','SSL','SSR','TTL','TTR'].map((name,index)=>[29+index,name])),{61:'BIL',62:'BIR'}));
const channelIds=new Map(channelNames.flatMap((name,id)=>name===undefined?[]:[[name,id] as const]));
const maxChannels=64;
/** Default layouts by name (av_channel_layout_default); channel_layout accepts only these, so it can only name an input's own layout. */
const defaultLayouts=new Map(Array.from({length:maxChannels},(_,index)=>defaultChannelLayout(index+1)).flatMap(layout=>layout===null?[]:[[layout.name,layout] as const]));
const fail=():never=>{throw new AudioFilterError('Failed to parse channel map');};
/** get_channel_idx: sscanf("%d%n") consuming the whole token, non-negative. Signed or space-led indices, which sscanf also reads, are refused as unimplemented. */
function channelIndex(token:string):number{
  if(/^\d{1,9}$/.test(token))return Number(token);
  if(/^[\t\n\v\f\r ]*\+?\d+$/.test(token))throw new AudioFilterError(`Unsupported channelmap channel index: ${token}`);
  return fail();
}
/** get_channel: av_channel_from_string. USR, AMBI, UNK and UNSD ids are refused as unimplemented. */
function channelId(token:string):number{
  const id=channelIds.get(token);if(id!==undefined)return id;
  if(/^(?:USR|AMBI)/.test(token)||token==='UNK'||token==='UNSD')throw new AudioFilterError(`Unsupported channelmap channel name: ${token}`);
  return fail();
}
const describe=(layout:AudioChannelMapLayout)=>layout.name;
const maskName=(mask:bigint)=>{
  for(const layout of defaultLayouts.values())if(layout.mask===mask)return layout.name;
  const names:string[]=[];for(let id=0;id<63;id++)if(mask>>BigInt(id)&1n)names.push(channelNames[id]??`USR${id}`);
  return `${names.length} channels (${names.join('+')})`;
};
const popcount=(mask:bigint)=>{let count=0;for(let rest=mask;rest>0n;rest>>=1n)count+=Number(rest&1n);return count;};
const defaultLayout=(channels:number):AudioChannelMapLayout=>{const layout=defaultChannelLayout(channels);return Object.freeze(layout?{channels,mask:layout.mask,name:layout.name}:{channels,mask:null,name:`${channels} channels`});};
/** av_channel_layout_index_from_channel for a native-order mask. */
const indexIn=(mask:bigint|null,channel:number)=>mask===null||!(mask>>BigInt(channel)&1n)?-1:popcount(mask&((1n<<BigInt(channel))-1n));
/** channelmap_init: mode from the first character and the character after the first '-', entries from '|' separators with a trailing one allowed. */
function parseMap(mapping:string|null,explicit:AudioChannelMapLayout|null):Pick<AudioChannelMapStep,'mode'|'map'|'layout'>{
  let mode:AudioChannelMapMode='none';
  if(mapping!==null){
    const dash=mapping.indexOf('-'),digit=(char:string|undefined)=>char!==undefined&&char>='0'&&char<='9';
    mode=dash<0?(digit(mapping[0])?'one-int':'one-str'):digit(mapping[0])?(digit(mapping[dash+1])?'pair-int-int':'pair-int-str'):(digit(mapping[dash+1])?'pair-str-int':'pair-str-str');
  }
  let entries=0;
  if(mapping!==null){entries=1;for(let at=mapping.indexOf('|');at>=0;at=mapping.indexOf('|',at+1))if(at+1<mapping.length)entries++;}
  if(entries>maxChannels)throw new AudioFilterError(`channelmap supports at most ${maxChannels} mappings`);
  // split(): the token ends at the next delimiter; a pair without '-' fails; the rest continues after it.
  let rest:string|null=mapping;
  const take=(delimiter:string):string=>{
    if(rest===null)return fail();
    const at=rest.indexOf(delimiter);if(at<0&&delimiter==='-')return fail();
    const token=at<0?rest:rest.slice(0,at);rest=at<0?null:rest.slice(at+1);return token;
  };
  const raw:{inIndex:number|null;inChannel:number|null;outIndex:number|null;outChannel:number|null}[]=[];
  let outMask=0n;
  for(let index=0;index<entries;index++){
    let inIndex:number|null=null,inChannel:number|null=null,outIndex:number|null=null,outChannel:number|null=null;
    if(mode==='one-int'){inIndex=channelIndex(take('|'));outIndex=index;}
    else if(mode==='one-str'){inChannel=channelId(take('|'));outIndex=index;}
    else{
      const first=take('-'),second=take('|');
      if(mode==='pair-int-int'||mode==='pair-int-str')inIndex=channelIndex(first);else inChannel=channelId(first);
      if(mode==='pair-int-int'||mode==='pair-str-int')outIndex=channelIndex(second);else{outChannel=channelId(second);outMask|=1n<<BigInt(outChannel);}
    }
    raw.push({inIndex,inChannel,outIndex,outChannel});
  }
  const layout=explicit??(outMask>0n?Object.freeze({channels:popcount(outMask),mask:outMask,name:maskName(outMask)}):entries>0?defaultLayout(entries):null);
  if(layout===null)throw new AudioFilterError('Output channel layout is not set and cannot be guessed from the maps.');
  if(mode==='none')return {mode,layout,map:Object.freeze(Array.from({length:layout.channels},(_,index)=>Object.freeze({inIndex:index,inChannel:null,outIndex:index})))};
  if(entries!==layout.channels)throw new AudioFilterError(`Output channel layout ${describe(layout)} does not match the number of channels mapped ${entries}.`);
  const present=new Set<number>();
  const map=raw.map((entry,index)=>{
    const outIndex=entry.outChannel===null?entry.outIndex!:indexIn(layout.mask,entry.outChannel);
    if(outIndex<0||outIndex>=layout.channels)throw new AudioFilterError(entry.outChannel===null?`Output channel #${outIndex} not available from output layout '${describe(layout)}'`:`Output channel '${channelNames[entry.outChannel]}' not available from output layout '${describe(layout)}'`);
    if(present.has(outIndex))throw new AudioFilterError(`Mapping ${index+1} assigns channel #${outIndex} twice in output layout '${describe(layout)}'.`);
    present.add(outIndex);
    return Object.freeze({inIndex:entry.inIndex,inChannel:entry.inChannel,outIndex});
  });
  return {mode,layout,map:Object.freeze(map)};
}
/** The PCM layout name of the default layout for `channels` (descriptor.ts AudioFormatCheck). */
const defaultName=(channels:number)=>channels===1?'mono':channels===2?'stereo':'unspecified';
/** Input index of each output channel, or a refusal naming the first map that does not fit the input layout. */
function sources(step:AudioChannelMapStep,channels:number,channelLayout:string):readonly number[]{
  const input=defaultChannelLayout(channels);
  if(input===null||channelLayout!==defaultName(channels))throw new AudioFilterError('channelmap requires the default channel layout for its input channel count');
  if(step.layout.channels!==channels||step.layout.mask!==input.mask)throw new AudioFilterError(`channelmap output layout ${describe(step.layout)} differs from input layout ${input.name}, which is not implemented`);
  const order=new Array<number>(channels).fill(-1);
  for(const entry of step.map){
    const index=entry.inChannel===null?entry.inIndex!:indexIn(input.mask,entry.inChannel);
    if(index<0||index>=channels)throw new AudioFilterError(entry.inChannel===null?`Input channel #${index} not available from input layout '${input.name}'`:`Input channel '${channelNames[entry.inChannel]}' not available from input layout '${input.name}'`);
    order[entry.outIndex]=index;
  }
  return order;
}
/** Constant channel permutation and duplication within the input's default layout: every output plane is a copy of one input plane. */
export const channelmap=defineAudioFilter<AudioChannelMapStep>({
  name:'channelmap',
  examples:['channelmap=1|0','channelmap=map=FR|FL','channelmap=0-1|1-0:channel_layout=stereo','channelmap=0|0'],
  parse(text){
    if(text!=='channelmap'&&!text.startsWith('channelmap='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    let mapping:string|null=null,layoutName:string|null=null,keyed=false;
    if(text!=='channelmap'){
      const args=text.slice(11);
      if(/['"\\[\];]/.test(args))throw new AudioFilterError('Quoted or escaped channelmap options are not implemented');
      for(const [index,option] of args.split(':').entries()){
        const equals=option.indexOf('=');
        if(equals<0){
          if(keyed||index>1)throw new AudioFilterError(`Unsupported channelmap option: ${option}`);
          if(index===0)mapping=option;else layoutName=option;
          continue;
        }
        keyed=true;
        const key=option.slice(0,equals),value=option.slice(equals+1);
        if(key==='map')mapping=value;else if(key==='channel_layout')layoutName=value;
        else throw new AudioFilterError(`Unsupported channelmap option: ${option}`);
      }
    }
    let explicit:AudioChannelMapLayout|null=null;
    if(layoutName!==null){
      const layout=defaultLayouts.get(layoutName);
      if(layout===undefined)throw new AudioFilterError(`Unsupported channelmap channel_layout: ${layoutName}`);
      explicit=Object.freeze({channels:layout.channels,mask:layout.mask,name:layout.name});
    }
    return Object.freeze({name:'channelmap',...parseMap(mapping,explicit)});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  // channelmap_query_formats: ff_planar_sample_fmts(). Double input picks s64p there, which the chain refuses explicitly.
  formats:()=>['u8p','s16p','s32p','fltp','dblp','s64p'],
  transparent:true,
  constraint:step=>format=>{sources(step,format.channels,format.channelLayout);},
  apply(step,frame,target,options){
    const order=sources(step,frame.channels,frame.channelLayout);
    const planar=convertAudioFrame(frame,target,options),used=new Set(order),spare=planar.planes.filter((_,index)=>!used.has(index)),taken=new Set<number>();
    // channelmap_filter_frame reassigns plane pointers. A plane used twice is copied into a plane no output reads, so no output plane aliases another and nothing new is allocated.
    const planes=order.map(index=>{options.signal?.throwIfAborted();const plane=planar.planes[index]!;if(!taken.has(index)){taken.add(index);return plane;}const copy=spare.pop()!;copy.set(plane);return copy;});
    return {...planar,planes};
  },
  reserve:()=>frameReservation
});
