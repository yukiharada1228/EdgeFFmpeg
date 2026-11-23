import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {reframeAudio} from '@edge-ffmpeg/avfilter';
import {AudioReframeError,createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '../../packages/avfilter/src/reframe-state.js';
const formats=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const;
const widths:Record<string,number>={u8:1,s16:2,s32:4,flt:4,dbl:8};
const options={maxFrameBytes:1024},origin=900719925474099312n;
function frame(format:string,start:number,samples:number,first:bigint|null=origin):AudioFrameData{
 const planar=format.endsWith('p'),width=widths[planar?format.slice(0,-1):format]!,planes=Array.from({length:planar?2:1},()=>new Uint8Array(samples*(planar?1:2)*width));
 for(let sample=0;sample<samples;sample++)for(let channel=0;channel<2;channel++)for(let byte=0;byte<width;byte++)planes[planar?channel:0]![(sample*(planar?1:2)+(planar?0:channel))*width+byte]=(17+(start+sample)*7+channel*41+byte*3)&255;
 return {sampleRate:48000,channels:2,channelLayout:'stereo',sampleFormat:format,samples,planes,pts:first===null?null:{value:first+BigInt(start),timeBase:{num:1n,den:48000n}}};
}
const frames=(format:string,first:bigint|null=origin)=>[frame(format,0,2,first),frame(format,2,5,first),frame(format,7,1,first),frame(format,8,3,first)];
const signature=(items:readonly AudioFrameData[])=>items.map(item=>({samples:item.samples,sampleRate:item.sampleRate,channels:item.channels,channelLayout:item.channelLayout,sampleFormat:item.sampleFormat,pts:item.pts,planes:item.planes.map(plane=>[...plane])}));
async function uninterrupted(input:AudioFrameData[],pad:boolean){async function* source(){yield*input;}const result:AudioFrameData[]=[];for await(const output of reframeAudio(source(),4,pad,options))result.push(output);return result;}
function finish(state:ReturnType<typeof createAudioReframeState>,output:AudioFrameData[]){const tail=state.finish();if(tail)output.push(tail);expect(state.finish()).toBeNull();}
const cases=formats.flatMap(format=>[false,true].flatMap(pad=>[1,2,3].map(boundary=>({format,pad,boundary}))));
it.each(cases)('hands off a partial $format FIFO after input frame $boundary (pad=$pad) without byte or PTS changes',async({format,pad,boundary})=>{
 const input=frames(format),first=createAudioReframeState(4,pad,options),actual:AudioFrameData[]=[];
 for(const item of input.slice(0,boundary))actual.push(...first.push(item));
 const checkpoint=first.checkpoint();expect(checkpoint.filled).toBe([2,3,0][boundary-1]);expect(checkpoint.received).toBe(['2','7','8'][boundary-1]);
 const encoded=serializeAudioReframeCheckpoint(checkpoint,options),decoded=deserializeAudioReframeCheckpoint(encoded,options),restored=createAudioReframeState(4,pad,options,decoded);first.dispose();
 for(const item of input.slice(boundary))actual.push(...restored.push(item));finish(restored,actual);
 expect(signature(actual)).toEqual(signature(await uninterrupted(input,pad)));expect(actual.map(item=>item.samples)).toEqual(pad?[4,4,4]:[4,4,3]);expect(actual.map(item=>item.pts?.value)).toEqual([origin,origin+4n,origin+8n]);
 const planar=format.endsWith('p'),width=widths[planar?format.slice(0,-1):format]!,whole=frame(format,0,11),silence=format.startsWith('u8')?128:0;
 for(let plane=0;plane<whole.planes.length;plane++){const collected=actual.flatMap(item=>[...item.planes[plane]!]);expect(collected.slice(0,whole.planes[plane]!.length)).toEqual([...whole.planes[plane]!]);expect(collected.slice(whole.planes[plane]!.length)).toEqual(Array(pad?(planar?1:2)*width:0).fill(silence));}
 restored.dispose();
});
it.each([null,-900719925474099312n])('preserves unknown or large negative PTS through serialized handoff: %s',async first=>{
 const input=frames('s16p',first),state=createAudioReframeState(4,true,options),actual=[...state.push(input[0]!)],bytes=serializeAudioReframeCheckpoint(state.checkpoint(),options),restored=createAudioReframeState(4,true,options,deserializeAudioReframeCheckpoint(bytes,options));state.dispose();for(const item of input.slice(1))actual.push(...restored.push(item));finish(restored,actual);expect(signature(actual)).toEqual(signature(await uninterrupted(input,true)));expect(actual[0]!.pts?.value??null).toBe(first);restored.dispose();
});
it('retains configured planar metadata and unknown PTS at an aligned empty-buffer handoff',()=>{
 const state=createAudioReframeState(4,false,options),actual=[...state.push(frame('u8p',0,4,null))],cp=state.checkpoint();expect(cp.filled).toBe(0);expect(cp.pending.length).toBe(0);expect(cp.format?.sampleFormat).toBe('u8p');expect(cp.origin).toBeNull();
 const restored=createAudioReframeState(4,false,options,deserializeAudioReframeCheckpoint(serializeAudioReframeCheckpoint(cp,options),options));actual.push(...restored.push(frame('u8p',4,2,null)));finish(restored,actual);expect(actual.map(item=>item.samples)).toEqual([4,2]);expect(actual.every(item=>item.pts===null)).toBe(true);for(let plane=0;plane<2;plane++)expect(actual.flatMap(item=>[...item.planes[plane]!])).toEqual([...frame('u8p',0,6,null).planes[plane]!]);state.dispose();restored.dispose();
});
it('restores initialized and finished empty states without re-emitting output',()=>{
 const empty=createAudioReframeState(4,true,options),copy=createAudioReframeState(4,true,options,deserializeAudioReframeCheckpoint(serializeAudioReframeCheckpoint(empty.checkpoint(),options),options));expect(copy.finish()).toBeNull();const ended=createAudioReframeState(4,true,options,copy.checkpoint());expect(ended.finish()).toBeNull();expect(()=>ended.push(frame('u8',0,1))).toThrow(AudioReframeError);empty.dispose();copy.dispose();ended.dispose();
});
it('restores a finished padded checkpoint without emitting its tail twice',()=>{
 const state=createAudioReframeState(4,true,options);expect([...state.push(frame('u8p',0,2))]).toEqual([]);const tail=state.finish()!;expect(tail.samples).toBe(4);expect(tail.planes.map(plane=>[...plane.slice(2)])).toEqual([[128,128],[128,128]]);
 const cp=state.checkpoint(),restored=createAudioReframeState(4,true,options,deserializeAudioReframeCheckpoint(serializeAudioReframeCheckpoint(cp,options),options));expect(restored.finish()).toBeNull();expect(restored.checkpoint().received).toBe('2');expect(restored.checkpoint().emitted).toBe('4');state.dispose();restored.dispose();
});
it('does not alias caller frames, checkpoints, encoded bytes or restored pending storage',()=>{
 const state=createAudioReframeState(4,false,options),input=frame('u8p',0,2);state.push(input).next();const cp=state.checkpoint(),bytes=serializeAudioReframeCheckpoint(cp,options),decoded=deserializeAudioReframeCheckpoint(bytes,options),restored=createAudioReframeState(4,false,options,decoded),expected=cp.pending.slice();
 input.planes.forEach(plane=>plane.fill(0));cp.pending.fill(1);decoded.pending.fill(2);bytes.fill(3);expect(state.checkpoint().pending).toEqual(expected);expect(restored.checkpoint().pending).toEqual(expected);expect(signature([restored.finish()!])).toEqual(signature([state.finish()!]));state.dispose();restored.dispose();
});
it.each(['version','kind','samples','pad','filled','received','emitted','origin','pending','format'] as const)('rejects corrupt checkpoint fields before restoring: %s',field=>{
 const state=createAudioReframeState(4,true,options);void [...state.push(frame('s16p',0,2))];const cp=state.checkpoint(),bad={...cp};
 const changes:Record<string,unknown>={version:2,kind:'different-state',samples:0,pad:'yes',filled:4,received:'not-an-integer',emitted:'1',origin:'1.5',pending:new Uint8Array(1),format:{...cp.format,sampleFormat:'invalid'}};
 const corrupt=Object.assign(bad,{[field]:changes[field]});expect(()=>createAudioReframeState(4,true,options,corrupt)).toThrow(AudioReframeError);expect(()=>serializeAudioReframeCheckpoint(corrupt,options)).toThrow(AudioReframeError);state.dispose();
});
it('rejects configuration mismatch and restoration beyond the FIFO allocation budget',()=>{
 const state=createAudioReframeState(4,true,options);void [...state.push(frame('dblp',0,2))];const cp=state.checkpoint();expect(()=>createAudioReframeState(5,true,options,cp)).toThrow(AudioReframeError);expect(()=>createAudioReframeState(4,false,options,cp)).toThrow(AudioReframeError);expect(()=>createAudioReframeState(4,true,{maxFrameBytes:63},cp)).toThrow(AudioReframeError);expect(()=>deserializeAudioReframeCheckpoint(serializeAudioReframeCheckpoint(cp,options),{maxFrameBytes:63})).toThrow(AudioReframeError);state.dispose();
});
it('rejects truncated, extended, or invalid encoded envelopes explicitly',()=>{
 const state=createAudioReframeState(4,false,options);void [...state.push(frame('s16',0,2))];const bytes=serializeAudioReframeCheckpoint(state.checkpoint(),options),changed=bytes.slice();changed[0]=changed[0]!^255;
 for(const invalid of [new Uint8Array(),bytes.subarray(0,bytes.length-1),new Uint8Array([...bytes,0]),changed])expect(()=>deserializeAudioReframeCheckpoint(invalid,options)).toThrow(AudioReframeError);state.dispose();
});
it('accepts only the canonical version 1 encoding and rejects unknown, missing or re-spelled fields',()=>{
 const state=createAudioReframeState(4,false,options);void [...state.push(frame('s16p',0,2))];const cp=state.checkpoint(),bytes=serializeAudioReframeCheckpoint(cp,options),length=new DataView(bytes.buffer).getUint32(0,true),text=new TextDecoder().decode(bytes.subarray(4,4+length)),pending=bytes.slice(4+length);state.dispose();
 const encode=(header:string|Uint8Array)=>{const value=typeof header==='string'?new TextEncoder().encode(header):header,result=new Uint8Array(4+value.length+pending.length);new DataView(result.buffer).setUint32(0,value.length,true);result.set(value,4);result.set(pending,4+value.length);return result;};
 expect(pending.length).toBe(8);expect(deserializeAudioReframeCheckpoint(encode(text),options)).toEqual(cp);expect(serializeAudioReframeCheckpoint(deserializeAudioReframeCheckpoint(bytes,options),options)).toEqual(bytes);
 const variants=[text.replace('{','{"extra":1,'),text.replace('{','{"pending":"",'),text.replace('"format":{','"format":{"pts":null,'),text.replace(',"finished":false',''),text.replace(':',': '),text+' ','\t'+text,text.replace('"version":1,"kind":"audio-reframe"','"kind":"audio-reframe","version":1'),
  text.replace('"audio-reframe"','"audio\\u002dreframe"'),text.replace('"samples":4','"samples":4.0'),text.replace('"samples":4','"samples":4e0'),text.replace('{','{"version":1,'),text.replace('"version":1','"version":2')];
 for(const variant of variants){expect(variant).not.toBe(text);expect(()=>deserializeAudioReframeCheckpoint(encode(variant),options),variant).toThrow(AudioReframeError);}
 expect(()=>deserializeAudioReframeCheckpoint(encode(Uint8Array.of(0xef,0xbb,0xbf,...new TextEncoder().encode(text))),options)).toThrow(AudioReframeError);
});
it('bounds snapshot counters and origins to signed64 while live reframing keeps any bigint origin',async()=>{
 const max=(1n<<63n)-1n,state=createAudioReframeState(4,true,options);void [...state.push(frame('s16p',0,2))];const cp=state.checkpoint();state.dispose();
 const encode=(value:typeof cp)=>{const {pending,...metadata}=value,header=new TextEncoder().encode(JSON.stringify(metadata)),result=new Uint8Array(4+header.length+pending.length);new DataView(result.buffer).setUint32(0,header.length,true);result.set(header,4);result.set(pending,4+header.length);return result;};
 for(const changes of [{received:String(max+1n)},{received:'1'+'0'.repeat(120)},{emitted:String(max+1n)},{origin:String(max+1n)},{origin:String(-max-2n)},{origin:'-'+'9'.repeat(127)}]){const bad={...cp,...changes};expect(()=>serializeAudioReframeCheckpoint(bad,options)).toThrow('signed64');expect(()=>deserializeAudioReframeCheckpoint(encode(bad),options)).toThrow('signed64');expect(()=>createAudioReframeState(4,true,options,bad)).toThrow('signed64');}
 for(const first of [-max-1n,max-12n]){const input=frames('s16p',first),live=createAudioReframeState(4,true,options),actual=[...live.push(input[0]!)],restored=createAudioReframeState(4,true,options,deserializeAudioReframeCheckpoint(serializeAudioReframeCheckpoint(live.checkpoint(),options),options));live.dispose();for(const item of input.slice(1))actual.push(...restored.push(item));finish(restored,actual);expect(signature(actual)).toEqual(signature(await uninterrupted(input,true)));restored.dispose();}
 for(const first of [max+1n,-max-2n]){const live=createAudioReframeState(4,true,options);void [...live.push(frame('s16p',0,2,first))];const snapshot=live.checkpoint();expect(snapshot.origin).toBe(String(first));expect(()=>serializeAudioReframeCheckpoint(snapshot,options)).toThrow('signed64');expect(()=>createAudioReframeState(4,true,options,snapshot)).toThrow('signed64');live.dispose();}
});
it('rejects snapshots, finish and reentry while a push is suspended and poisons an early return',()=>{
 const state=createAudioReframeState(4,false,options),iterator=state.push(frame('s16',0,10));expect(()=>state.checkpoint()).toThrow(AudioReframeError);expect(()=>state.push(frame('s16',10,1))).toThrow(AudioReframeError);expect(()=>state.finish()).toThrow(AudioReframeError);
 expect(iterator.next().value?.samples).toBe(4);expect(()=>state.checkpoint()).toThrow(AudioReframeError);iterator.return();expect(()=>state.checkpoint()).toThrow(AudioReframeError);expect(()=>state.finish()).toThrow(AudioReframeError);expect(()=>state.push(frame('s16',10,1))).toThrow(AudioReframeError);state.dispose();
});
it('poisons a push returned before its generator body starts',()=>{
 const state=createAudioReframeState(4,false,options),iterator=state.push(frame('u8',0,1));iterator.return();expect(()=>state.checkpoint()).toThrow(AudioReframeError);state.dispose();
});
it.each(['next','return','throw'] as const)('does not let a completed iterator %s alter ownership of a newer push',action=>{
 const state=createAudioReframeState(4,false,options),old=state.push(frame('u8',0,2));expect([...old]).toEqual([]);const current=state.push(frame('u8',2,5)),reason=Error('closed old iterator');
 if(action==='throw')expect(()=>old.throw(reason)).toThrow(reason);else expect(old[action]()).toMatchObject({done:true});
 expect(()=>state.checkpoint()).toThrow(AudioReframeError);expect(()=>state.finish()).toThrow(AudioReframeError);
 const actual=[...current];finish(state,actual);expect(actual.map(item=>item.samples)).toEqual([4,3]);expect(actual.flatMap(item=>[...item.planes[0]!])).toEqual([...frame('u8',0,7).planes[0]!]);state.dispose();
});
it('rejects further execution or snapshots after explicit disposal',()=>{
 const state=createAudioReframeState(4,false,options);void [...state.push(frame('s16',0,2))];state.dispose();expect(()=>state.push(frame('s16',2,2))).toThrow(AudioReframeError);expect(()=>state.checkpoint()).toThrow(AudioReframeError);expect(()=>state.finish()).toThrow(AudioReframeError);expect(()=>state.dispose()).not.toThrow();
});
it('rejects a discontinuous restored stream and incompatible sample metadata',()=>{
 for(const variant of ['pts','format','rate','layout','unknown-pts'] as const){const state=createAudioReframeState(4,false,options);void [...state.push(frame('s16',0,2))];const restored=createAudioReframeState(4,false,options,state.checkpoint()),next=frame('s16',2,2);if(variant==='pts')next.pts={value:origin+3n,timeBase:{num:1n,den:48000n}};else if(variant==='format')next.sampleFormat='u8';else if(variant==='rate')next.sampleRate=8000;else if(variant==='layout')next.channelLayout='different';else next.pts=null;expect(()=>[...restored.push(next)]).toThrow(AudioReframeError);state.dispose();restored.dispose();}
});
