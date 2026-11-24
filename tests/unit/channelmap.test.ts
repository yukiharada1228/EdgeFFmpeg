import {describe,expect,it} from 'vitest';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {pcmFilterMemory} from '../../packages/avformat/src/pcm-filter-memory.js';
const layouts=['mono','stereo','unspecified'];
const widthOf=(format:string)=>({u8:1,s16:2,s32:4,flt:4,dbl:8} as Record<string,number>)[format.replace(/p$/,'')]!;
/** A frame whose sample bytes are all distinct per channel and position. */
function frame(format:AudioSampleFormat,channels:number,samples:number,offset=0):AudioFrameData{
  const width=widthOf(format),planar=format.endsWith('p'),fill=(plane:Uint8Array,channel:number|null)=>{for(let index=0;index<plane.length;index++)plane[index]=(index+offset*width*(planar?1:channels)+(channel??0)*61)*7&255;return plane;};
  const planes=planar?Array.from({length:channels},(_,channel)=>fill(new Uint8Array(samples*width),channel)):[fill(new Uint8Array(samples*width*channels),null)];
  return {sampleRate:8000,channels,channelLayout:layouts[Math.min(channels,3)-1]!,sampleFormat:format,samples,planes,pts:{value:BigInt(offset),timeBase:{num:1n,den:8000n}}};
}
/** channelmap_filter_frame on planar input: out[map[ch].out_channel_idx] = in[map[ch].in_channel_idx]; packed input is first split into planes as swresample does. */
function transcription(input:AudioFrameData,order:readonly number[]):Uint8Array[]{
  const width=widthOf(input.sampleFormat),planes=input.sampleFormat.endsWith('p')?input.planes:Array.from({length:input.channels},(_,channel)=>{const plane=new Uint8Array(input.samples*width);for(let sample=0;sample<input.samples;sample++)plane.set(input.planes[0]!.subarray((sample*input.channels+channel)*width,(sample*input.channels+channel+1)*width),sample*width);return plane;});
  return order.map(index=>planes[index]!);
}
const refuse=(text:string,message:string)=>{let error:unknown;try{compileAudioFilterChain(text);}catch(caught){error=caught;}expect(error,text).toBeInstanceOf(AudioFilterError);expect((error as Error).message,text).toBe(message);};
describe('channelmap parser',()=>{
 it('selects the native parse mode from the first character and the character after the first dash',()=>{
  const mode=(text:string)=>(compileAudioFilterChain(text).steps[0] as unknown as {mode:string}).mode;
  expect(['channelmap=1|0','channelmap=FR|FL','channelmap=0-1|1-0','channelmap=0-FR|1-FL','channelmap=FL-1|FR-0','channelmap=FL-FR|FR-FL','channelmap=channel_layout=stereo'].map(mode))
   .toEqual(['one-int','one-str','pair-int-int','pair-int-str','pair-str-int','pair-str-str','none']);
  // Only the first dash and its next character select the pair kinds; a later separator style does not.
  refuse('channelmap=0|1-0','Failed to parse channel map');
  refuse('channelmap=FL|FR-FL','Failed to parse channel map');
 });
 it('accepts a trailing separator, keyed and positional options and an equal channel_layout',()=>{
  const steps=(text:string)=>compileAudioFilterChain(text).steps[0];
  expect(steps('channelmap=1|0|')).toEqual(steps('channelmap=1|0'));
  expect(steps('channelmap=map=1|0')).toEqual(steps('channelmap=1|0'));
  expect(steps('channelmap=1|0:stereo')).toEqual(steps('channelmap=map=1|0:channel_layout=stereo'));
  expect(steps('channelmap=0-1|1-0|')).toEqual(steps('channelmap=0-1|1-0'));
  expect(steps('channelmap=channel_layout=2.1')).toEqual({name:'channelmap',mode:'none',layout:{channels:3,mask:11n,name:'2.1'},map:[0,1,2].map(index=>({inIndex:index,inChannel:null,outIndex:index}))});
  expect(steps('channelmap=FL-FR|FR-FL')).toEqual({name:'channelmap',mode:'pair-str-str',layout:{channels:2,mask:3n,name:'stereo'},map:[{inIndex:null,inChannel:0,outIndex:1},{inIndex:null,inChannel:1,outIndex:0}]});
  expect(Object.isFrozen(steps('channelmap=1|0'))).toBe(true);
 });
 it('refuses native init failures and unimplemented syntax with exact messages',()=>{
  for(const [text,message] of [
   ['channelmap','Output channel layout is not set and cannot be guessed from the maps.'],
   ['channelmap=','Failed to parse channel map'],
   ['channelmap=1||0','Failed to parse channel map'],
   ['channelmap=1x|0','Failed to parse channel map'],
   ['channelmap=XX|FL','Failed to parse channel map'],
   ['channelmap=0-1-2|1-0','Failed to parse channel map'],
   ['channelmap=0-1|1','Failed to parse channel map'],
   ['channelmap=1|0:channel_layout=mono','Output channel layout mono does not match the number of channels mapped 2.'],
   ['channelmap=0-0|1-0',"Mapping 2 assigns channel #0 twice in output layout 'stereo'."],
   ['channelmap=0-2|1-0',"Output channel #2 not available from output layout 'stereo'"],
   ['channelmap=0-FL|1-FL','Output channel layout 1 channels (FL) does not match the number of channels mapped 2.'],
   ['channelmap=0-FC|1-FL:stereo',"Output channel 'FC' not available from output layout 'stereo'"],
   ['channelmap=1|+0','Unsupported channelmap channel index: +0'],
   ['channelmap=1| 0','Unsupported channelmap channel index:  0'],
   ['channelmap=USR3|FL','Unsupported channelmap channel name: USR3'],
   ['channelmap=AMBI0|FL','Unsupported channelmap channel name: AMBI0'],
   ['channelmap=1|0:channel_layout=FL+FR','Unsupported channelmap channel_layout: FL+FR'],
   ['channelmap=1|0:channel_layout=downmix','Unsupported channelmap channel_layout: downmix'],
   ['channelmap=1|0:stereo:x','Unsupported channelmap option: x'],
   ['channelmap=map=1|0:stereo','Unsupported channelmap option: stereo'],
   ['channelmap=mapping=1|0','Unsupported channelmap option: mapping=1|0'],
   ["channelmap='1|0'",'Quoted or escaped channelmap options are not implemented'],
   ['channelmap=1\\|0','Quoted or escaped channelmap options are not implemented'],
   [`channelmap=${Array.from({length:65},()=>'0').join('|')}`,'channelmap supports at most 64 mappings']
  ] as const)refuse(text,message);
  expect(()=>compileAudioFilterChain('channelmapx')).toThrow(/^Unsupported audio filter: channelmapx$/);
 });
});
describe('channelmap chain',()=>{
 it('negotiates ff_planar_sample_fmts like native and refuses the s64p pick for double input',()=>{
  const chain=compileAudioFilterChain('channelmap=1|0');
  expect(chain.nativeFormatLists).toBe(true);
  expect((['u8','s16','s32','flt'] as const).map(format=>chain.negotiatedSampleFormats(format))).toEqual([['u8p'],['s16p'],['s32p'],['fltp']]);
  expect((['u8p','s16p','s32p','fltp','dblp'] as const).map(format=>chain.negotiatedSampleFormats(format)[0])).toEqual(['u8p','s16p','s32p','fltp','dblp']);
  expect(()=>chain.negotiatedSampleFormats('dbl')).toThrow(/^channelmap with dbl input negotiates s64p, which is not implemented$/);
  expect(compileAudioFilterChain('aformat=f=dblp,channelmap=1|0').negotiatedSampleFormats('dbl')).toEqual(['dblp','dblp']);
  // Copies never round: only the encoder hint can (float input into the default s32 hint).
  for(const format of ['u8','s16','s32'] as const)expect(chain.requiresScalarRounding(format),format).toBe(false);
  expect([chain.requiresScalarRounding('flt'),compileAudioFilterChain('channelmap=1|0',{outputSampleFormat:'flt'}).requiresScalarRounding('flt')]).toEqual([true,false]);
  expect(chain.capabilities[0]).toMatchObject({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false});
 });
 it('refuses every map that changes the count or layout, unavailable inputs and non-default input layouts',async()=>{
  const check=(text:string,channels:number,channelLayout:string)=>()=>compileAudioFilterChain(text).validateInputFormat({sampleRate:8000,channels,channelLayout});
  for(const [text,channels,layout,message] of [
   ['channelmap=0',2,'stereo','channelmap output layout mono differs from input layout stereo, which is not implemented'],
   ['channelmap=0|0',1,'mono','channelmap output layout stereo differs from input layout mono, which is not implemented'],
   ['channelmap=0|1',3,'unspecified','channelmap output layout stereo differs from input layout 2.1, which is not implemented'],
   ['channelmap=FL-FC|FR-FL',2,'stereo','channelmap output layout 2 channels (FL+FC) differs from input layout stereo, which is not implemented'],
   ['channelmap=channel_layout=mono',2,'stereo','channelmap output layout mono differs from input layout stereo, which is not implemented'],
   ['channelmap=0|2',2,'stereo',"Input channel #2 not available from input layout 'stereo'"],
   ['channelmap=FC|FL',2,'stereo',"Input channel 'FC' not available from input layout 'stereo'"],
   ['channelmap=FC-FL|FL-FR',2,'stereo',"Input channel 'FC' not available from input layout 'stereo'"],
   ['channelmap=1|0',2,'2 channels (FL+FC)','channelmap requires the default channel layout for its input channel count'],
   ['channelmap=1|0',2,'downmix','channelmap requires the default channel layout for its input channel count'],
   ['channelmap=1|0|2',3,'3 channels','channelmap requires the default channel layout for its input channel count'],
   ['channelmap=0',1,'1 channels (FL)','channelmap requires the default channel layout for its input channel count']
  ] as const){let error:unknown;try{check(text,channels,layout)();}catch(caught){error=caught;}expect(error,`${text} ${layout}`).toBeInstanceOf(AudioFilterError);expect((error as Error).message,`${text} ${layout}`).toBe(message);}
  for(const [text,channels,layout] of [['channelmap=0',1,'mono'],['channelmap=FC',1,'mono'],['channelmap=0|0',2,'stereo'],['channelmap=LFE|FL|FL',3,'unspecified'],['channelmap=2-FL|0-LFE|1-FR',3,'unspecified'],['channelmap=channel_layout=stereo',2,'stereo']] as const)
   expect(check(text,channels,layout),text).not.toThrow();
  expect(()=>compileAudioFilterChain('channelmap=1|0').apply(frame('s16',1,4),{maxFrameBytes:64})).toThrow(/^channelmap output layout stereo differs from input layout mono, which is not implemented$/);
  await expect(()=>compileAudioFilterChain('channelmap=1|0').process((async function*(){})(),{maxFrameBytes:64})[Symbol.asyncIterator]().next()).rejects.toThrow(/constraints require a configured empty input format/);
 });
 it('plans an unchanged count, packet boundaries and one frame-producing stage',()=>{
  const chain=compileAudioFilterChain('channelmap=2|0|1');
  expect(chain.planSamples(1001n,8000,{configuredInput:true,channels:3}).samples).toBe(1001n);
  expect(chain.packetSections(1001n,1024n,8000,false,3)).toEqual([{samples:1001n,span:1024n}]);
  const input={sampleRate:8000,channels:3,sampleFormat:'s16' as const},plan={configuredInput:true,channels:3,samples:1001n};
  const entries=chain.plannedReservations(input,plan);
  expect(entries.map(entry=>[entry.reservation,entry.countBuffers])).toEqual([[{frames:1,buffers:[],stateBytes:0n},[]]]);
  expect([...chain.reservations(input)]).toEqual([{frames:1,buffers:[],stateBytes:0n}]);
  expect(pcmFilterMemory(chain,input,plan,{width:2,maxBufferBytes:4096,maxResidentBytes:1<<20})).toEqual({volumeNodes:1,stateBytes:0});
 });
});
describe('channelmap execution',()=>{
 const cases:readonly (readonly [string,number,readonly number[]])[]=[
  ['channelmap=0',1,[0]],['channelmap=FC',1,[0]],['channelmap=0-0',1,[0]],
  ['channelmap=1|0',2,[1,0]],['channelmap=0|0',2,[0,0]],['channelmap=1|1',2,[1,1]],['channelmap=FR|FL',2,[1,0]],['channelmap=FL|FL',2,[0,0]],['channelmap=0-1|1-0',2,[1,0]],['channelmap=1-0|1-1',2,[1,1]],
  ['channelmap=0-FR|1-FL',2,[1,0]],['channelmap=FL-1|FR-0',2,[1,0]],['channelmap=FR-FR|FR-FL',2,[1,1]],['channelmap=channel_layout=stereo',2,[0,1]],
  ['channelmap=2|0|1',3,[2,0,1]],['channelmap=2|2|0',3,[2,2,0]],['channelmap=LFE|FL|FR',3,[2,0,1]],['channelmap=0-2|1-0|2-1',3,[1,2,0]],['channelmap=FL-LFE|LFE-FL|LFE-FR',3,[2,2,0]],['channelmap=1|1|1|',3,[1,1,1]]
 ];
 it('matches a transcription of channelmap_filter_frame for every planar and packed input format, with frame-split invariance',async()=>{
  for(const [text,channels,order] of cases)for(const format of ['u8','s16','s32','flt','u8p','s16p','s32p','fltp','dblp'] as const){
   const chain=compileAudioFilterChain(text),input=frame(format,channels,13),output=chain.apply(input,{maxFrameBytes:1<<16});
   expect(output.sampleFormat,`${text} ${format}`).toBe(format.endsWith('p')?format:`${format}p`);
   expect([output.channels,output.channelLayout,output.samples,output.pts],`${text} ${format}`).toEqual([channels,input.channelLayout,13,input.pts]);
   expect(output.planes,`${text} ${format}`).toEqual(transcription(input,order));
   // process() over the same samples split in two frames yields the same planes, frame by frame.
   const parts=[frame(format,channels,5),frame(format,channels,8,5)],whole=frame(format,channels,13);
   const streamed:AudioFrameData[]=[];for await(const item of chain.process((async function*(){yield* parts;})(),{maxFrameBytes:1<<16,inputFormat:{sampleRate:8000,channels,channelLayout:input.channelLayout,sampleFormat:format,pts:null}}))streamed.push(item);
   const joined=streamed[0]!.planes.map((plane,index)=>Uint8Array.from([...plane,...streamed[1]!.planes[index]!]));
   expect(joined,`${text} ${format} split`).toEqual(transcription(whole,order));
  }
 });
 it('returns owned, non-aliasing planes and leaves the input untouched',()=>{
  for(const [text,channels] of [['channelmap=0|0',2],['channelmap=2|2|2',3],['channelmap=1|0',2]] as const)for(const format of ['s16','s16p'] as const){
   const input=frame(format,channels,6),before=input.planes.map(plane=>plane.slice()),output=compileAudioFilterChain(text).apply(input,{maxFrameBytes:1<<10});
   expect(input.planes).toEqual(before);
   const regions=output.planes.map(plane=>[plane.byteOffset,plane.byteOffset+plane.byteLength] as const);
   for(const plane of output.planes)for(const source of input.planes)expect(plane.buffer,text).not.toBe(source.buffer);
   for(let a=0;a<regions.length;a++)for(let b=a+1;b<regions.length;b++)expect(output.planes[a]!.buffer!==output.planes[b]!.buffer||regions[a]![1]<=regions[b]![0]||regions[b]![1]<=regions[a]![0],`${text} ${format} ${a}/${b}`).toBe(true);
   const copy=output.planes.map(plane=>plane.slice());output.planes[0]!.fill(0);
   expect(output.planes.slice(1),text).toEqual(copy.slice(1));
  }
 });
 it('honours the frame allocation limit and cancellation',()=>{
  const chain=compileAudioFilterChain('channelmap=1|0'),input=frame('s16',2,8);
  expect(chain.apply(input,{maxFrameBytes:32}).planes.length).toBe(2);
  expect(()=>chain.apply(input,{maxFrameBytes:31})).toThrow(/^Audio filter frame exceeds allocation limit$/);
  const controller=new AbortController();controller.abort(new Error('stopped'));
  expect(()=>chain.apply(input,{maxFrameBytes:32,signal:controller.signal})).toThrow('stopped');
 });
});
