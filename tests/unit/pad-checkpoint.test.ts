import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {padAudio,createAudioPadState,serializeAudioPadCheckpoint,deserializeAudioPadCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioPadOptions,AudioPadCheckpoint} from '@edge-ffmpeg/avfilter';
import {AudioPadError} from '../../packages/avfilter/src/pad-checkpoint.js';
const formats=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const;
const widths:Record<string,number>={u8:1,s16:2,s32:4,flt:4,dbl:8},origin=900719925474099312n;
function frame(format:string,start:number,samples:number,first:bigint|null=origin,rate=8000):AudioFrameData{
 const planar=format.endsWith('p'),width=widths[planar?format.slice(0,-1):format]!,planes=Array.from({length:planar?2:1},()=>new Uint8Array(samples*(planar?1:2)*width));
 for(let sample=0;sample<samples;sample++)for(let channel=0;channel<2;channel++)for(let byte=0;byte<width;byte++)planes[planar?channel:0]![(sample*(planar?1:2)+(planar?0:channel))*width+byte]=(17+(start+sample)*7+channel*41+byte*3)&255;
 return {sampleRate:rate,channels:2,channelLayout:'stereo',sampleFormat:format,samples,planes,pts:first===null?null:{value:first+BigInt(start),timeBase:{num:1n,den:BigInt(rate)}}};
}
const frames=(format:string,first:bigint|null=origin)=>[frame(format,0,2,first),frame(format,2,5,first),frame(format,7,1,first),frame(format,8,3,first)];
const signature=(items:readonly AudioFrameData[])=>items.map(item=>({samples:item.samples,sampleRate:item.sampleRate,channels:item.channels,channelLayout:item.channelLayout,sampleFormat:item.sampleFormat,pts:item.pts,planes:item.planes.map(plane=>[...plane])}));
const modes:Record<string,Omit<AudioPadOptions,'maxFrameBytes'>>={pad:{padSamples:7n,packetSamples:3},whole:{wholeSamples:20n,packetSamples:4},'whole-below':{wholeSamples:5n,packetSamples:2},'pad-dur':{padDurationMicros:625n,packetSamples:2},'whole-dur':{wholeDurationMicros:1875n,packetSamples:3},zero:{padSamples:0n}};
const budget=1024;
async function uninterrupted(input:AudioFrameData[],options:AudioPadOptions){async function* source(){yield*input;}const result:AudioFrameData[]=[];for await(const output of padAudio(source(),options))result.push(output);return result;}
/** Executes input frames then one-packet tail transitions, handing serialized state to a fresh object at each selected boundary. */
function run(input:AudioFrameData[],options:AudioPadOptions,split:(step:number)=>boolean){
 let state=createAudioPadState(options),step=0;const output:AudioFrameData[]=[],sizes:number[]=[];
 const handoff=()=>{if(split(step)){const bytes=serializeAudioPadCheckpoint(state.checkpoint(),options);sizes.push(bytes.length);state.dispose();state=createAudioPadState(options,deserializeAudioPadCheckpoint(bytes,options));}step++;};
 handoff();for(const item of input){output.push(state.push(item));handoff();}
 while(!state.finished){output.push(...state.finish(1));handoff();}
 expect([...state.finish()]).toEqual([]);state.dispose();return {output,steps:step,sizes};
}
const cases=formats.flatMap(format=>Object.keys(modes).map(mode=>({format,mode})));
it.each(cases)('restores $format apad ($mode) after every input and tail boundary with identical bytes and PTS',async({format,mode})=>{
 const options={...modes[mode]!,maxFrameBytes:budget},input=frames(format),expected=signature(await uninterrupted(input,options));
 const {steps}=run(input,options,()=>false);
 for(let boundary=0;boundary<steps;boundary++)expect(signature(run(input,options,step=>step===boundary).output)).toEqual(expected);
 const chained=run(input,options,()=>true);expect(signature(chained.output)).toEqual(expected);expect(Math.max(...chained.sizes)).toBeLessThan(1024);
 const planar=format.endsWith('p'),width=widths[planar?format.slice(0,-1):format]!,whole=frame(format,0,11),silence=format.startsWith('u8')?128:0,added=expected.reduce((sum,item)=>sum+item.samples,0)-11;
 expect(added).toBe({pad:7,whole:9,'whole-below':0,'pad-dur':5,'whole-dur':4,zero:0}[mode]);
 for(let plane=0;plane<whole.planes.length;plane++){const collected=chained.output.flatMap(item=>[...item.planes[plane]!]);expect(collected.slice(0,whole.planes[plane]!.length)).toEqual([...whole.planes[plane]!]);expect(collected.slice(whole.planes[plane]!.length)).toEqual(Array(added*(planar?1:2)*width).fill(silence));}
 expect(chained.output.map(item=>item.pts?.value)).toEqual(expected.map(item=>item.pts?.value));
 for(const item of chained.output.slice(input.length))expect(input.some(source=>source.planes.some(plane=>item.planes.some(view=>view.buffer===plane.buffer)))).toBe(false);
});
it.each([null,-900719925474099312n])('preserves unknown or large negative PTS origins through serialized tail handoff: %s',async first=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},input=frames('s16p',first),expected=signature(await uninterrupted(input,options));
 const result=run(input,options,()=>true).output;expect(signature(result)).toEqual(expected);expect(result.map(item=>item.pts?.value??null)).toEqual(first===null?Array(7).fill(null):[0n,2n,7n,8n,11n,13n,15n].map(offset=>first+offset));
});
it('restores a configured empty stream mid-tail from its empty-input descriptor',async()=>{
 const emptyInput={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}},options={emptyInput,wholeDurationMicros:625n,packetSamples:2,maxFrameBytes:4};
 const expected=signature(await uninterrupted([],options)),result=run([],options,()=>true).output;expect(signature(result)).toEqual(expected);expect(result.map(item=>[item.samples,item.pts?.value])).toEqual([[2,9007199254740993n],[2,9007199254740995n],[1,9007199254740997n]]);
 const state=createAudioPadState(options);void [...state.finish(1)];const cp=state.checkpoint();expect(cp).toMatchObject({received:'0',padded:'2',eof:true,finished:false,origin:'9007199254740993',emptyInput:{pts:{value:'9007199254740993',num:'1',den:'8000'}}});
 expect(()=>createAudioPadState({...options,emptyInput:{...emptyInput,pts:null}},cp)).toThrow('mismatch');expect(()=>createAudioPadState({wholeDurationMicros:625n,packetSamples:2,maxFrameBytes:4},cp)).toThrow('mismatch');
 expect(()=>createAudioPadState(options,{...cp,origin:'1'})).toThrow('empty-input');expect(()=>createAudioPadState(options,{...cp,format:{...cp.format!,channelLayout:'mono'}})).toThrow('empty-input');state.dispose();
 const unconfigured=createAudioPadState({padSamples:3n,maxFrameBytes:4});expect([...unconfigured.finish()]).toEqual([]);expect(unconfigured.checkpoint()).toMatchObject({format:null,eof:true,finished:true});unconfigured.dispose();
});
it('restores finished snapshots without re-emitting the tail and rejects input after end of stream',()=>{
 const options={padSamples:3n,packetSamples:2,maxFrameBytes:budget},state=createAudioPadState(options);state.push(frame('u8',0,1));expect([...state.finish()].map(item=>item.samples)).toEqual([2,1]);expect(state.finished).toBe(true);
 const restored=createAudioPadState(options,deserializeAudioPadCheckpoint(serializeAudioPadCheckpoint(state.checkpoint(),options),options));expect(restored.finished).toBe(true);expect([...restored.finish()]).toEqual([]);expect(restored.checkpoint()).toMatchObject({received:'1',padded:'3'});expect(()=>restored.push(frame('u8',1,1))).toThrow('end of input');state.dispose();restored.dispose();
});
it('does not alias checkpoints, encoded bytes or restored state',()=>{
 const options={padSamples:4n,packetSamples:2,maxFrameBytes:budget},state=createAudioPadState(options);state.push(frame('s16',0,2));const cp=state.checkpoint(),bytes=serializeAudioPadCheckpoint(cp,options),decoded=deserializeAudioPadCheckpoint(bytes,options);
 (cp.format as {sampleRate:number}).sampleRate=1;bytes.fill(0);(decoded as {received:string}).received='9';expect(state.checkpoint().format?.sampleRate).toBe(8000);expect(state.checkpoint().received).toBe('2');state.dispose();
});
const base=():AudioPadCheckpoint=>{const state=createAudioPadState({padSamples:5n,packetSamples:2,maxFrameBytes:budget});state.push(frame('s16p',0,3));void [...state.finish(1)];const cp=state.checkpoint();state.dispose();return cp;};
const corrupt:Record<string,Partial<Record<keyof AudioPadCheckpoint,unknown>>>={version:{version:2},kind:{kind:'audio-reframe'},mode:{mode:'pad'},'limit-leading-zero':{limit:'05'},'limit-signed64':{limit:'9223372036854775808'},'limit-number':{limit:5},packet:{packetSamples:0},'packet-fraction':{packetSamples:1.5},received:{received:'1.5'},'received-negative':{received:'-3'},'received-huge':{received:'1'.repeat(129)},padded:{padded:'-2'},'padded-over':{padded:'6'},'padded-unaligned':{padded:'1'},origin:{origin:'01'},eof:{eof:'yes'},'finished-mismatch':{finished:true},'pending-padded':{eof:false},format:{format:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s24'}},'format-rate':{format:{sampleRate:0,channels:2,channelLayout:'stereo',sampleFormat:'s16p'}},'unconfigured-samples':{format:null},'empty-descriptor':{emptyInput:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',pts:{value:'x',num:'1',den:'1'}}},'no-input':{received:'0'}};
it.each(Object.keys(corrupt))('rejects corrupt checkpoint fields before restoring: %s',name=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},bad={...base(),...corrupt[name]} as AudioPadCheckpoint;
 expect(()=>createAudioPadState(options,bad)).toThrow(AudioPadError);expect(()=>serializeAudioPadCheckpoint(bad,options)).toThrow(AudioPadError);
 const header=new TextEncoder().encode(JSON.stringify(bad)),bytes=new Uint8Array(4+header.length);new DataView(bytes.buffer).setUint32(0,header.length,true);bytes.set(header,4);expect(()=>deserializeAudioPadCheckpoint(bytes,options)).toThrow(AudioPadError);
});
it('rejects configuration mismatch and restoration beyond the padding packet budget',()=>{
 const cp=base(),options={padSamples:5n,packetSamples:2,maxFrameBytes:budget};expect(createAudioPadState(options,cp).checkpoint()).toEqual(cp);
 for(const other of [{padSamples:6n,packetSamples:2},{wholeSamples:5n,packetSamples:2},{padDurationMicros:5n,packetSamples:2},{padSamples:5n,packetSamples:3},{padSamples:5n}])expect(()=>createAudioPadState({...other,maxFrameBytes:budget},cp)).toThrow('mismatch');
 expect(()=>createAudioPadState({...options,maxFrameBytes:7},cp)).toThrow('allocation');expect(()=>deserializeAudioPadCheckpoint(serializeAudioPadCheckpoint(cp,options),{maxFrameBytes:7})).toThrow('allocation');expect(createAudioPadState({...options,maxFrameBytes:12},cp).finished).toBe(false);
});
it('rejects truncated, extended, tampered or invalid encoded envelopes explicitly',()=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},bytes=serializeAudioPadCheckpoint(base(),options),length=bytes.slice();length[0]=length[0]!^255;
 const text=new TextDecoder().decode(bytes.subarray(4)),encode=(value:string|Uint8Array)=>{const header=typeof value==='string'?new TextEncoder().encode(value):value,result=new Uint8Array(4+header.length);new DataView(result.buffer).setUint32(0,header.length,true);result.set(header,4);return result;};
 expect(text).toContain('"padded":"2"');
 for(const invalid of [new Uint8Array(),Uint8Array.of(0,0,0),bytes.subarray(0,bytes.length-1),new Uint8Array([...bytes,0]),length,encode(text.replace('"padded":"2"','"padded":"3"')),encode(text.replace('"padded":"2"','"padded":"02"')),encode(text.replace('"padded":"2"','"padded":2')),encode('[]'),encode('null'),encode('{"version":1'),encode(Uint8Array.of(0xef,0xbb,0xbf,...new TextEncoder().encode(text))),encode(Uint8Array.of(123,255,125)),new Uint8Array(4+16385)])expect(()=>deserializeAudioPadCheckpoint(invalid,options)).toThrow(AudioPadError);
 expect(deserializeAudioPadCheckpoint(encode(text),options)).toEqual(base());
});
it('accepts only the canonical version 1 encoding and rejects unknown, missing or re-spelled fields',()=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},emptyInput={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',pts:{value:7n,timeBase:{num:1n,den:8000n}}};
 const encode=(value:string)=>{const header=new TextEncoder().encode(value),result=new Uint8Array(4+header.length);new DataView(result.buffer).setUint32(0,header.length,true);result.set(header,4);return result;};
 const withEmpty:AudioPadOptions={...options,emptyInput},configured=createAudioPadState(withEmpty);configured.push(frame('s16p',0,3,7n));const descriptor=configured.checkpoint();configured.dispose();
 for(const [cp,restore] of [[base(),options],[descriptor,withEmpty]] as [AudioPadCheckpoint,AudioPadOptions][]){
  const bytes=serializeAudioPadCheckpoint(cp,restore),text=new TextDecoder().decode(bytes.subarray(4));expect(deserializeAudioPadCheckpoint(bytes,restore)).toEqual(cp);expect(serializeAudioPadCheckpoint(deserializeAudioPadCheckpoint(bytes,restore),restore)).toEqual(bytes);
  const variants=[text.replace('{','{"extra":1,'),text.replace('}',',"extra":null}'),text.replace(',"finished":false',''),text.replace('"format":{','"format":{"pts":null,'),text.replace(':',': '),text+'\n',' '+text,text.replace('"version":1,"kind":"audio-pad"','"kind":"audio-pad","version":1'),
   text.replace('"audio-pad"','"audio\\u002dpad"'),text.replace('"packetSamples":2','"packetSamples":2.0'),text.replace('"packetSamples":2','"packetSamples":2e0'),text.replace('{','{"version":1,'),text.replace('"version":1','"version":2'),text.replace('"version":1','"version":1.0')];
  if(cp.emptyInput)variants.push(text.replace('"emptyInput":{','"emptyInput":{"extra":1,'),text.replace('"num":"1",','"num":"1","extra":"1",'),text.replace(',"den":"8000"',''));
  for(const variant of variants){expect(variant).not.toBe(text);expect(()=>deserializeAudioPadCheckpoint(encode(variant),restore),variant).toThrow(AudioPadError);}
 }
});
it('range-checks empty-input descriptors at configuration and in snapshots and bounds every snapshot integer to signed64',async()=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},max=(1n<<63n)-1n,emptyInput={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',pts:{value:7n,timeBase:{num:1n,den:8000n}}};
 const encode=(value:unknown)=>{const header=new TextEncoder().encode(JSON.stringify(value)),result=new Uint8Array(4+header.length);new DataView(result.buffer).setUint32(0,header.length,true);result.set(header,4);return result;};
 // Formerly accepted here and failing only in finish(), a fractional rate there as a raw RangeError.
 for(const bad of [{sampleRate:8000.5},{sampleRate:0},{channels:-3},{channels:1.5},{sampleFormat:'bogus'},{pts:{value:1n,timeBase:{num:-1n,den:8000n}}},{pts:{value:1n,timeBase:{num:1n,den:0n}}},{pts:{value:max+1n,timeBase:{num:1n,den:8000n}}},{pts:{value:1n,timeBase:{num:1n,den:max+1n}}}])
  expect(()=>createAudioPadState({...options,emptyInput:{...emptyInput,...bad}}),JSON.stringify(bad,(_,value)=>typeof value==='bigint'?String(value):value)).toThrow(AudioPadError);
 expect(()=>createAudioPadState({...options,packetSamples:2,maxFrameBytes:64,emptyInput:{sampleRate:8000.5,channels:-3,channelLayout:'stereo',sampleFormat:'bogus',pts:{value:1n,timeBase:{num:-1n,den:0n}}}})).toThrow('configured');
 const configured=createAudioPadState({...options,emptyInput}),edge=createAudioPadState({...options,emptyInput:{...emptyInput,pts:{value:-max-1n,timeBase:{num:1n,den:max}}}});const descriptor=configured.checkpoint();configured.dispose();
 expect(deserializeAudioPadCheckpoint(serializeAudioPadCheckpoint(edge.checkpoint(),options),options).emptyInput?.pts).toEqual({value:String(-max-1n),num:'1',den:String(max)});edge.dispose();
 const pts=descriptor.emptyInput!.pts!,descriptors=[{sampleRate:8000.5},{channels:-3},{channels:0},{sampleFormat:'bogus'},{pts:{...pts,num:'-1'}},{pts:{...pts,num:'0'}},{pts:{...pts,den:'0'}},{pts:{...pts,value:String(max+1n)}},{pts:{...pts,den:String(max+1n)}}];
 for(const bad of descriptors){const cp={...descriptor,emptyInput:{...descriptor.emptyInput!,...bad}} as AudioPadCheckpoint;expect(()=>serializeAudioPadCheckpoint(cp,options),JSON.stringify(bad)).toThrow(AudioPadError);expect(()=>deserializeAudioPadCheckpoint(encode(cp),options)).toThrow(AudioPadError);expect(()=>createAudioPadState({...options,emptyInput},cp)).toThrow(AudioPadError);}
 const cp=base();
 for(const changes of [{received:String(max+1n)},{received:'1'+'0'.repeat(120)},{origin:String(max+1n)},{origin:String(-max-2n)},{origin:'-'+'9'.repeat(127)},{limit:String(max+1n)}]){const bad={...cp,...changes};expect(()=>serializeAudioPadCheckpoint(bad,options)).toThrow('signed64');expect(()=>deserializeAudioPadCheckpoint(encode(bad),options)).toThrow('signed64');expect(()=>createAudioPadState(options,bad)).toThrow('signed64');}
 for(const first of [-max-1n,max-11n-5n]){const input=frames('s16p',first);expect(signature(run(input,options,()=>true).output)).toEqual(signature(await uninterrupted(input,options)));}
 // Live padding keeps accepting any bigint origin; only its snapshot is refused, explicitly.
 for(const first of [max+1n,-max-2n]){const state=createAudioPadState(options);state.push(frame('s16p',0,2,first));const live=state.checkpoint();expect(live.origin).toBe(String(first));expect(()=>serializeAudioPadCheckpoint(live,options)).toThrow('signed64');expect(()=>createAudioPadState(options,live)).toThrow('signed64');state.dispose();}
});
it('rejects snapshots, push and reentry while a tail is suspended and poisons an early return',()=>{
 const options={padSamples:9n,packetSamples:2,maxFrameBytes:budget},state=createAudioPadState(options);state.push(frame('s16',0,1));const iterator=state.finish();
 expect(()=>state.checkpoint()).toThrow('busy');expect(()=>state.finish()).toThrow('busy');expect(iterator.next().value?.samples).toBe(2);expect(()=>state.push(frame('s16',1,1))).toThrow(AudioPadError);
 iterator.return();expect(()=>state.checkpoint()).toThrow('poisoned');expect(()=>state.finish()).toThrow('poisoned');state.dispose();
 const unstarted=createAudioPadState(options);unstarted.push(frame('s16',0,1));unstarted.finish().return();expect(()=>unstarted.checkpoint()).toThrow('poisoned');
 expect(()=>createAudioPadState(options).finish(0)).toThrow('packet limit');expect(()=>createAudioPadState(options).finish(1.5)).toThrow('packet limit');
});
it.each(['next','return','throw'] as const)('does not let a completed tail iterator %s alter ownership of a newer finish',action=>{
 const options={padSamples:5n,packetSamples:2,maxFrameBytes:budget},state=createAudioPadState(options);state.push(frame('u8',0,1));const old=state.finish(1);expect([...old].map(item=>item.samples)).toEqual([2]);const current=state.finish(),reason=Error('closed old iterator');
 if(action==='throw')expect(()=>old.throw(reason)).toThrow(reason);else expect(old[action]()).toMatchObject({done:true});
 expect(()=>state.checkpoint()).toThrow('busy');expect([...current].map(item=>[item.samples,item.pts?.value])).toEqual([[2,origin+3n],[1,origin+5n]]);expect(state.checkpoint()).toMatchObject({padded:'5',finished:true});state.dispose();
});
it('poisons after malformed or discontinuous input and rejects use after disposal or cancellation',()=>{
 for(const variant of ['pts','format','rate','layout','unknown-pts','plane'] as const){const options={padSamples:2n,maxFrameBytes:budget},state=createAudioPadState(options);state.push(frame('s16',0,2));const restored=createAudioPadState(options,state.checkpoint()),next=frame('s16',2,2);if(variant==='pts')next.pts={value:origin+3n,timeBase:{num:1n,den:8000n}};else if(variant==='format')next.sampleFormat='u8';else if(variant==='rate')next.sampleRate=16000;else if(variant==='layout')next.channelLayout='different';else if(variant==='unknown-pts')next.pts=null;else next.planes=[new Uint8Array(3)];expect(()=>restored.push(next)).toThrow(AudioPadError);expect(()=>restored.checkpoint()).toThrow('poisoned');state.dispose();restored.dispose();}
 const state=createAudioPadState({padSamples:2n,maxFrameBytes:budget});state.dispose();expect(()=>state.push(frame('s16',0,1))).toThrow('disposed');expect(()=>state.checkpoint()).toThrow('disposed');expect(()=>state.dispose()).not.toThrow();
 const controller=new AbortController(),live=createAudioPadState({padSamples:2n,maxFrameBytes:budget,signal:controller.signal});live.push(frame('s16',0,1));const cp=live.checkpoint();controller.abort(Error('stop'));expect(()=>live.finish().next()).toThrow('stop');expect(()=>createAudioPadState({padSamples:2n,maxFrameBytes:budget,signal:controller.signal},cp)).toThrow('stop');
});
