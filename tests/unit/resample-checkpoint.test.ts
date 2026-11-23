import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioConversionError,createAudioResampleState,deserializeAudioResampleCheckpoint,planAudioResample,resampleAudio,resampledSampleCount,serializeAudioResampleCheckpoint} from '@edge-ffmpeg/swresample';
import type {AudioResampleCheckpoint,AudioResampleOptions,ResampleSampleFormat} from '@edge-ffmpeg/swresample';
const widths:Record<ResampleSampleFormat,number>={s16:2,flt:4,dbl:8},origin=900719925474099312n,partition=[17,1,24,2,23,24,24,24,24,24,24,24,24,5],total=partition.reduce((sum,count)=>sum+count,0);
interface Case {readonly inputRate:number;readonly outputRate:number;readonly format:ResampleSampleFormat;readonly channels:number;readonly planar:boolean}
function frame(c:Case,start:number,samples:number,first:bigint|null=origin):AudioFrameData{
 const width=widths[c.format],planes=Array.from({length:c.planar?c.channels:1},()=>new Uint8Array(samples*(c.planar?1:c.channels)*width));
 for(let sample=0;sample<samples;sample++)for(let channel=0;channel<c.channels;channel++){
  const index=start+sample,value=Math.sin(index*.123+channel)+.3*Math.cos(index*.49-channel)+(index===50?.5:0),plane=planes[c.planar?channel:0]!,view=new DataView(plane.buffer),offset=(c.planar?sample:sample*c.channels+channel)*width;
  if(width===2)view.setInt16(offset,index%29===0?32767:index%31===0?-32768:Math.round(value*15000),true);else if(width===4)view.setFloat32(offset,value,true);else view.setFloat64(offset,value,true);
 }
 return {sampleRate:c.inputRate,channels:c.channels,channelLayout:c.channels===1?'mono':'stereo',sampleFormat:c.format+(c.planar?'p':''),samples,planes,pts:first===null?null:{value:first+BigInt(start),timeBase:{num:1n,den:BigInt(c.inputRate)}}};
}
function frames(c:Case,first:bigint|null=origin):AudioFrameData[]{let start=0;return partition.map(count=>{const item=frame(c,start,count,first);start+=count;return item;});}
// Output frames hold at most 24 samples, so pending output and multi-frame EOF tails cross every handoff.
const options=(c:Case):AudioResampleOptions=>({maxFrameBytes:24*c.channels*widths[c.format],maxStateBytes:1<<20});
const signature=(items:readonly AudioFrameData[])=>items.map(item=>({samples:item.samples,sampleRate:item.sampleRate,channels:item.channels,channelLayout:item.channelLayout,sampleFormat:item.sampleFormat,pts:item.pts,planes:item.planes.map(plane=>[...plane])}));
async function uninterrupted(input:AudioFrameData[],outputRate:number,limits:AudioResampleOptions){async function* source(){yield*input;}const result:AudioFrameData[]=[];for await(const output of resampleAudio(source(),outputRate,limits))result.push(output);return result;}
/** Input frames, then one-frame EOF tail steps; serialized state moves to a fresh object at each selected boundary and must re-encode identically. */
function run(input:AudioFrameData[],outputRate:number,limits:AudioResampleOptions,split:(step:number)=>boolean){
 let state=createAudioResampleState(outputRate,limits),step=0;const output:AudioFrameData[]=[],sizes:number[]=[];
 const handoff=()=>{if(split(step)){const cp=state.checkpoint(),bytes=serializeAudioResampleCheckpoint(cp,limits),decoded=deserializeAudioResampleCheckpoint(bytes,limits);expect(decoded).toEqual(cp);expect(serializeAudioResampleCheckpoint(decoded,limits)).toEqual(bytes);sizes.push(bytes.length);state.dispose();state=createAudioResampleState(outputRate,limits,decoded);expect(state.checkpoint()).toEqual(cp);}step++;};
 handoff();for(const item of input){output.push(...state.push(item));handoff();}
 while(!state.finished){output.push(...state.finish(1));handoff();}
 expect([...state.finish()]).toEqual([]);state.dispose();return {output,steps:step,sizes};
}
const rates=[[8000,44100],[44100,48000],[48000,8000],[44100,22050],[8000,16000],[44100,48001],[48001,44100],[16000,16000]] as const;
const cases:Case[]=rates.flatMap(([inputRate,outputRate])=>(['s16','flt','dbl'] as const).flatMap(format=>[1,2].flatMap(channels=>[false,true].map(planar=>({inputRate,outputRate,format,channels,planar})))));
it.each(cases)('restores $format $inputRate->$outputRate (channels=$channels planar=$planar) at every input and tail boundary with identical bytes and PTS',async c=>{
 const limits=options(c),input=frames(c),reference=await uninterrupted(input,c.outputRate,limits),expected=signature(reference),plan=planAudioResample(c.inputRate,c.outputRate,c.channels,{...limits,sampleFormat:c.format});
 expect(reference.reduce((sum,item)=>sum+item.samples,0)).toBe(Number(resampledSampleCount(BigInt(total),c.inputRate,c.outputRate)));expect(plan.interpolates).toBe(c.outputRate===48001||c.inputRate===48001);
 const {steps}=run(input,c.outputRate,limits,()=>false);expect(steps).toBeGreaterThan(partition.length+(plan.taps?1:0));
 for(let boundary=0;boundary<steps;boundary++)expect(signature(run(input,c.outputRate,limits,step=>step===boundary).output),`boundary ${boundary}`).toEqual(expected);
 const chained=run(input,c.outputRate,limits,()=>true);expect(signature(chained.output)).toEqual(expected);
 // History is bounded by taps+1 sample frames; coefficient banks are rebuilt, never serialized.
 expect(Math.max(...chained.sizes)).toBeLessThan(1024+(plan.taps+1)*c.channels*widths[c.format]+limits.maxFrameBytes);
 for(const item of chained.output)expect(input.some(source=>source.planes.some(plane=>item.planes.some(view=>view.buffer===plane.buffer)))).toBe(false);
});
// Digest and frame count per rate pair over s16/flt/dbl x packed/planar x mono/stereo x three PTS/budget/chunking variants,
// recorded from the resampleAudio implementation that preceded createAudioResampleState. They pin the refactor's byte, PTS and frame-shape identity.
const golden=[[8000,16000,'726a99eb213fab3b1d6c85fb8dca79de:646'],[16000,8000,'c24ee4e9f0ba5f5d26efedf07f662f3d:182'],[44100,48000,'3d367939583b6b7578ecd5fc6adcfb72:358'],[48000,44100,'f29ca6d6049c1ae7eca6756635e89bab:294'],[8000,44100,'b9cec6ef01580f61b7b38c1e66a10323:1734'],[48000,8000,'0f87a55568276beb455c15f912c09a9d:70'],[44100,22050,'c49d070cd3ed8a7c4169cb1418e6cae6:182'],[44100,48001,'38ef654e5105fe32ab90f6c385de4a2c:358'],[48001,44100,'02004291fd70c3052077e98d4f9180f0:294'],[8000,16001,'0e5551be1e4837a4d2a728ebb9902760:646'],[16000,16000,'97cf95c13426cadb898496f0475eb115:1356']] as const;
function goldenInput(format:ResampleSampleFormat,planar:boolean,channels:number,rate:number,first:bigint|null,chunks:readonly number[]):AudioFrameData[]{
 const width=widths[format],result:AudioFrameData[]=[];let offset=0,index=0;
 while(offset<257){const count=Math.min(chunks[index++%chunks.length]!,257-offset),planes=Array.from({length:planar?channels:1},()=>new Uint8Array(count*(planar?1:channels)*width));
  for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){const value=Math.sin((offset+sample)*.123+channel)+.3*Math.cos((offset+sample)*.49-channel),view=new DataView(planes[planar?channel:0]!.buffer),position=(planar?sample:sample*channels+channel)*width;if(width===2)view.setInt16(position,Math.max(-32768,Math.min(32767,Math.round(value*20000))),true);else if(width===4)view.setFloat32(position,value,true);else view.setFloat64(position,value,true);}
  result.push({sampleRate:rate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format+(planar?'p':''),samples:count,planes,pts:first===null?null:{value:first+BigInt(offset),timeBase:{num:1n,den:BigInt(rate)}}});offset+=count;}
 return result;
}
it.each(golden)('keeps resampleAudio %i->%i output byte-identical to the pre-checkpoint implementation',async(inputRate,outputRate,expected)=>{
 const hash=createHash('sha256');let count=0;
 for(const format of ['s16','flt','dbl'] as const)for(const planar of [false,true])for(const channels of [1,2])for(const [first,maxFrameBytes,chunks] of [[0n,512,[1,5,31]],[null,96,[1,3,6]],[-9007199254740993n,512,[7,31]]] as const){
  async function* source(){yield* goldenInput(format,planar,channels,inputRate,first,chunks);}
  for await(const item of resampleAudio(source(),outputRate,{maxFrameBytes,maxStateBytes:4<<20})){count++;hash.update(JSON.stringify([item.sampleRate,item.channels,item.channelLayout,item.sampleFormat,item.samples,item.pts&&[String(item.pts.value),String(item.pts.timeBase.num),String(item.pts.timeBase.den)],Object.keys(item).sort()]));for(const plane of item.planes)hash.update(plane);}
 }
 expect(hash.digest('hex').slice(0,32)+':'+count).toBe(expected);
});
it.each([[8000,44100,'s16'],[44100,22050,'dbl'],[44100,48001,'flt']] as const)('restores startup and short-flush states of %i->%i %s streams around the first-output and filter-length thresholds at every boundary',async(inputRate,outputRate,format)=>{
 // One-sample input frames reach every pre-start count; lengths straddle the shortest stream with output and taps+1, so EOF hits empty, reflected short and full tails.
 const c:Case={inputRate,outputRate,format,channels:2,planar:false},limits={maxFrameBytes:3*2*widths[format],maxStateBytes:1<<20},plan=planAudioResample(inputRate,outputRate,2,{...limits,sampleFormat:format});
 let first=1;while(resampledSampleCount(BigInt(first),inputRate,outputRate)===0n)first++;expect(first).toBeGreaterThan(2);expect(first).toBeLessThan(plan.taps);
 for(const samples of new Set([1,2,first-1,first,first+1,plan.taps>>1,plan.taps,plan.taps+1,plan.taps+2,plan.taps+6])){
  const input=Array.from({length:samples},(_,start)=>frame(c,start,1)),expected=signature(await uninterrupted(input,outputRate,limits)),{steps}=run(input,outputRate,limits,()=>false);
  expect(expected.reduce((sum,item)=>sum+item.samples,0)).toBe(Number(resampledSampleCount(BigInt(samples),inputRate,outputRate)));
  for(let boundary=0;boundary<steps;boundary++)expect(signature(run(input,outputRate,limits,step=>step===boundary).output),`${samples}/${boundary}`).toEqual(expected);
 }
});
it.each([null,-900719925474099312n])('preserves unknown or large negative PTS origins through serialized handoff: %s',async first=>{
 const c:Case={inputRate:44100,outputRate:48000,format:'flt',channels:2,planar:true},limits=options(c),input=frames(c,first),expected=signature(await uninterrupted(input,c.outputRate,limits)),result=run(input,c.outputRate,limits,()=>true).output;
 expect(signature(result)).toEqual(expected);if(first===null)expect(result.every(item=>item.pts===null)).toBe(true);else expect(result[0]!.pts).toEqual({value:-980375429087455033n,timeBase:{num:1n,den:48000n}});
});
it('keeps snapshots far below the coefficient bank for interpolating and long-filter plans',()=>{
 for(const [inputRate,outputRate]of [[44100,48001],[48000,8000]] as const){
  const c:Case={inputRate,outputRate,format:'dbl',channels:2,planar:false},limits=options(c),plan=planAudioResample(inputRate,outputRate,2,{...limits,sampleFormat:'dbl'}),state=createAudioResampleState(outputRate,limits);
  for(const item of frames(c).slice(0,12))void [...state.push(item)];const cp=state.checkpoint(),bytes=serializeAudioResampleCheckpoint(cp,limits);state.dispose();
  expect(cp.plan).toEqual({inputRate,outputRate,channels:2,sampleFormat:'dbl',taps:plan.taps,phases:plan.phases,interpolates:plan.interpolates});expect(cp.history.length).toBeGreaterThan(0);expect(cp.history.length).toBeLessThanOrEqual((plan.taps+1)*16);expect(bytes.length).toBeLessThan(1024+cp.history.length+cp.pending.length);if(plan.interpolates)expect(bytes.length).toBeLessThan(plan.coefficientBytes/64);
 }
});
it('restores unconfigured, empty-finished and finished snapshots without re-emitting output',async()=>{
 const c:Case={inputRate:8000,outputRate:44100,format:'s16',channels:1,planar:false},limits=options(c),input=frames(c),expected=signature(await uninterrupted(input,c.outputRate,limits));
 const fresh=createAudioResampleState(44100,limits),blank=fresh.checkpoint();expect(blank).toMatchObject({plan:null,format:null,received:'0',eof:false,finished:false});fresh.dispose();
 const restored=createAudioResampleState(44100,limits,deserializeAudioResampleCheckpoint(serializeAudioResampleCheckpoint(blank,limits),limits)),output:AudioFrameData[]=[];for(const item of input)output.push(...restored.push(item));output.push(...restored.finish());expect(signature(output)).toEqual(expected);
 const ended=restored.checkpoint();expect(ended).toMatchObject({eof:true,finished:true,history:new Uint8Array(0),pending:new Uint8Array(0)});restored.dispose();
 const again=createAudioResampleState(44100,limits,deserializeAudioResampleCheckpoint(serializeAudioResampleCheckpoint(ended,limits),limits));expect(again.finished).toBe(true);expect([...again.finish()]).toEqual([]);expect(()=>again.push(input[0]!)).toThrow('end of input');again.dispose();
 const empty=createAudioResampleState(44100,limits);expect([...empty.finish()]).toEqual([]);const none=empty.checkpoint();expect(none).toMatchObject({plan:null,eof:true,finished:true});expect(createAudioResampleState(44100,limits,none).finished).toBe(true);empty.dispose();
 const short=createAudioResampleState(44100,limits);void [...short.push(frame(c,0,5))];expect([...short.finish()]).toEqual([]);expect(short.checkpoint()).toMatchObject({received:'5',emitted:'0',finished:true});short.dispose();
});
it('does not alias checkpoints, encoded bytes, decoded state or restored history',()=>{
 const c:Case={inputRate:44100,outputRate:48000,format:'dbl',channels:2,planar:true},limits=options(c),input=frames(c),state=createAudioResampleState(48000,limits);for(const item of input.slice(0,3))void [...state.push(item)];
 const cp=state.checkpoint(),history=cp.history.slice(),pending=cp.pending.slice(),bytes=serializeAudioResampleCheckpoint(cp,limits),decoded=deserializeAudioResampleCheckpoint(bytes,limits),restored=createAudioResampleState(48000,limits,decoded);
 expect(pending.length).toBeGreaterThan(0);input.slice(0,3).forEach(item=>item.planes.forEach(plane=>plane.fill(0)));cp.history.fill(1);cp.pending.fill(1);bytes.fill(2);decoded.history.fill(3);decoded.pending.fill(3);
 for(const current of [state,restored]){const again=current.checkpoint();expect(again.history).toEqual(history);expect(again.pending).toEqual(pending);}
 expect(signature([...state.push(input[3]!),...state.finish()])).toEqual(signature([...restored.push(input[3]!),...restored.finish()]));state.dispose();restored.dispose();
});
const c:Case={inputRate:44100,outputRate:48000,format:'dbl',channels:2,planar:true},limits=options(c);
const base=():AudioResampleCheckpoint=>{const state=createAudioResampleState(48000,limits);for(const item of frames(c).slice(0,3))void [...state.push(item)];const cp=state.checkpoint();state.dispose();return cp;};
const envelope=(header:string|Uint8Array,payload:Uint8Array)=>{const bytes=typeof header==='string'?new TextEncoder().encode(header):header,result=new Uint8Array(4+bytes.length+payload.length);new DataView(result.buffer).setUint32(0,bytes.length,true);result.set(bytes,4);result.set(payload,4+bytes.length);return result;};
const corrupt:Record<string,(cp:AudioResampleCheckpoint)=>unknown>={
 version:cp=>({...cp,version:2}),kind:cp=>({...cp,kind:'audio-reframe'}),'extra-field':cp=>({...cp,extra:1}),'missing-field':cp=>{const copy:Partial<Record<keyof AudioResampleCheckpoint,unknown>>={...cp};delete copy.finished;return copy;},'output-rate':cp=>({...cp,outputRate:44100}),'requested-format':cp=>({...cp,requestedFormat:'u8'}),'requested-precision':cp=>({...cp,requestedFormat:'flt'}),
 'plan-taps':cp=>({...cp,plan:{...cp.plan!,taps:34}}),'plan-phases':cp=>({...cp,plan:{...cp.plan!,phases:320}}),'plan-interpolates':cp=>({...cp,plan:{...cp.plan!,interpolates:true}}),'plan-precision':cp=>({...cp,plan:{...cp.plan!,sampleFormat:'flt'}}),'plan-channels':cp=>({...cp,plan:{...cp.plan!,channels:1}}),'plan-rate':cp=>({...cp,plan:{...cp.plan!,inputRate:44101}}),'plan-extra':cp=>({...cp,plan:{...cp.plan!,cutoff:0.97}}),
 'format-name':cp=>({...cp,format:{...cp.format!,sampleFormat:'fltp'}}),'format-frame':cp=>({...cp,format:{...cp.format!,frameSamples:0}}),'format-layout':cp=>({...cp,format:{...cp.format!,channelLayout:7}}),'format-extra':cp=>({...cp,format:{...cp.format!,pts:null}}),
 'received-leading-zero':cp=>({...cp,received:'044'}),'received-negative':cp=>({...cp,received:'-44'}),'received-number':cp=>({...cp,received:44}),'received-advanced':cp=>({...cp,received:'45'}),'received-huge':cp=>({...cp,received:'1'.repeat(129)}),'emitted-over':cp=>({...cp,emitted:String(BigInt(cp.emitted)+1n)}),'emitted-under':cp=>({...cp,emitted:'0'}),
 origin:cp=>({...cp,origin:'1.5'}),'origin-number':cp=>({...cp,origin:1}),eof:cp=>({...cp,eof:'yes'}),'finished-pending':cp=>({...cp,finished:true}),'eof-pending':cp=>({...cp,eof:true}),'unconfigured-samples':cp=>({...cp,plan:null,format:null}),
 'history-short':cp=>({...cp,history:cp.history.subarray(1)}),'history-long':cp=>({...cp,history:new Uint8Array([...cp.history,0,0,0,0,0,0,0,0])}),'history-type':cp=>({...cp,history:[...cp.history]}),'history-nan':cp=>{const history=cp.history.slice();new DataView(history.buffer).setFloat64(8,NaN,true);return {...cp,history};},'history-infinite':cp=>{const history=cp.history.slice();new DataView(history.buffer).setFloat64(0,-Infinity,true);return {...cp,history};},'pending-short':cp=>({...cp,pending:cp.pending.subarray(8)})
};
it.each(Object.keys(corrupt))('rejects corrupt checkpoint fields before restoring: %s',name=>{
 const bad=corrupt[name]!(base()) as AudioResampleCheckpoint;
 expect(()=>createAudioResampleState(48000,limits,bad)).toThrow(AudioConversionError);expect(()=>serializeAudioResampleCheckpoint(bad,limits)).toThrow(AudioConversionError);
 const record=bad as unknown as Record<string,unknown>,{history,pending,...header}=record,payload=new Uint8Array([...(history instanceof Uint8Array?history:[]),...(pending instanceof Uint8Array?pending:[])]);
 expect(()=>deserializeAudioResampleCheckpoint(envelope(JSON.stringify(header),payload),limits)).toThrow(AudioConversionError);
});
it('bounds counters and origins to signed64: extreme in-range origins hand off exactly, values beyond them fail at serialize, decode and restore',async()=>{
 const cp=base(),max=(1n<<63n)-1n;
 // Otherwise consistent forged states: decimal syntax and the 128-digit cap alone admitted these.
 for(const changes of [{received:String(max+6n)},{received:'1'+'0'.repeat(120)},{emitted:String(max+1n)},{origin:String(max+1n)},{origin:String(-max-2n)},{origin:'-'+'9'.repeat(127)}]){
  const bad={...cp,...changes},{history,pending,...header}=bad;expect(()=>serializeAudioResampleCheckpoint(bad,limits)).toThrow('signed64');expect(()=>createAudioResampleState(48000,limits,bad)).toThrow('signed64');
  expect(()=>deserializeAudioResampleCheckpoint(envelope(JSON.stringify(header),new Uint8Array([...history,...pending])),limits)).toThrow('signed64');
 }
 for(const first of [-max-1n,max-BigInt(total)]){const input=frames(c,first);expect(signature(run(input,48000,limits,()=>true).output)).toEqual(signature(await uninterrupted(input,48000,limits)));}
 // Live streaming keeps accepting any bigint origin; only its snapshot is refused, explicitly.
 for(const first of [max+1n,-max-2n]){const input=frames(c,first),state=createAudioResampleState(48000,limits);void [...state.push(input[0]!)];const live=state.checkpoint();expect(live.origin).toBe(String(first));expect(()=>serializeAudioResampleCheckpoint(live,limits)).toThrow('signed64');expect(()=>createAudioResampleState(48000,limits,live)).toThrow('signed64');state.dispose();}
});
it('accepts only the canonical encoding: whitespace, order, escapes, number spellings, duplicates, BOM, unknown versions and fields fail',()=>{
 const cp=base(),bytes=serializeAudioResampleCheckpoint(cp,limits),length=new DataView(bytes.buffer).getUint32(0,true),text=new TextDecoder().decode(bytes.subarray(4,4+length)),payload=bytes.slice(4+length);
 expect(text.startsWith('{"version":1,"kind":"audio-resample","outputRate":48000,"requestedFormat":null,"plan":{"inputRate":44100,')).toBe(true);expect(payload.length).toBe(cp.history.length+cp.pending.length);expect(deserializeAudioResampleCheckpoint(envelope(text,payload),limits)).toEqual(cp);
 const variants=[text.replace(':',': '),text+' ',' '+text,text.replace('"version":1,"kind":"audio-resample"','"kind":"audio-resample","version":1'),text.replace('"audio-resample"','"audio\\u002dresample"'),text.replace('"outputRate":48000,','"outputRate":48000.0,'),text.replace('"outputRate":48000,','"outputRate":4.8e4,'),text.replace('{','{"version":1,'),
  text.replace('"version":1','"version":2'),text.replace('{','{"extra":1,'),text.replace('"plan":{','"plan":{"cutoff":0.97,'),text.replace('"format":{','"format":{"history":"",'),text.replace(',"finished":false',''),text.replace('"eof":false','"eof":0'),text.replace('"requestedFormat":null','"requestedFormat":""')];
 for(const variant of variants){expect(variant).not.toBe(text);expect(()=>deserializeAudioResampleCheckpoint(envelope(variant,payload),limits),variant.slice(0,120)).toThrow(AudioConversionError);}
 const utf8=new TextEncoder().encode(text);
 for(const header of [Uint8Array.of(0xef,0xbb,0xbf,...utf8),Uint8Array.of(123,255,125),new TextEncoder().encode('[]'),new TextEncoder().encode('null'),new TextEncoder().encode('{"version":1')])expect(()=>deserializeAudioResampleCheckpoint(envelope(header,payload),limits)).toThrow(AudioConversionError);
});
it('rejects truncation, trailing bytes, inconsistent payload and tampered header lengths at every position',()=>{
 const bytes=serializeAudioResampleCheckpoint(base(),limits);
 for(let size=0;size<bytes.length;size++)expect(()=>deserializeAudioResampleCheckpoint(bytes.subarray(0,size),limits)).toThrow(AudioConversionError);
 for(const extra of [[0],[0,0,0,0,0,0,0,0],[...bytes.subarray(bytes.length-8)]])expect(()=>deserializeAudioResampleCheckpoint(new Uint8Array([...bytes,...extra]),limits)).toThrow('payload length');
 for(const delta of [-1,1,4,-4,1<<24]){const changed=bytes.slice(),view=new DataView(changed.buffer);view.setUint32(0,view.getUint32(0,true)+delta,true);expect(()=>deserializeAudioResampleCheckpoint(changed,limits)).toThrow(AudioConversionError);}
 const flipped=bytes.slice(),length=new DataView(bytes.buffer).getUint32(0,true);flipped[4+length+3]=flipped[4+length+3]!^0x7f;const decoded=deserializeAudioResampleCheckpoint(flipped,limits);expect(decoded.history).not.toEqual(base().history);
 // Structural validation cannot authenticate finite sample bits; persisted state needs a digest, as the workerd fixture uses.
 expect(serializeAudioResampleCheckpoint(decoded,limits)).toEqual(flipped);
});
it('enforces allocation limits before decoding payloads or rebuilding coefficients',()=>{
 const cp=base(),bytes=serializeAudioResampleCheckpoint(cp,limits),plan=planAudioResample(44100,48000,2,{...limits,sampleFormat:'dbl'});
 expect(()=>deserializeAudioResampleCheckpoint(bytes,{...limits,maxStateBytes:plan.stateBytes-1})).toThrow('allocation limit');expect(()=>createAudioResampleState(48000,{...limits,maxStateBytes:plan.stateBytes-1},cp)).toThrow('allocation limit');expect(createAudioResampleState(48000,{...limits,maxStateBytes:plan.stateBytes},cp).finished).toBe(false);
 expect(()=>deserializeAudioResampleCheckpoint(bytes,{...limits,maxFrameBytes:23*16})).toThrow('allocation limit');expect(()=>createAudioResampleState(48000,{...limits,maxFrameBytes:23*16},cp)).toThrow('allocation limit');
 expect(()=>deserializeAudioResampleCheckpoint(new Uint8Array(4+16384+limits.maxStateBytes+limits.maxFrameBytes+1),limits)).toThrow('checkpoint bytes');expect(()=>deserializeAudioResampleCheckpoint(envelope(new Uint8Array(16385),new Uint8Array()),limits)).toThrow('header length');
 for(const invalid of [{maxFrameBytes:1,maxStateBytes:1},{maxFrameBytes:64,maxStateBytes:0},{maxFrameBytes:64.5,maxStateBytes:64}])expect(()=>deserializeAudioResampleCheckpoint(bytes,invalid)).toThrow('resource limits');
 // A hostile 2147483647->1 plan would need gigabytes of coefficients; it is rejected from the rates alone.
 const hostile={...cp,outputRate:1,plan:{...cp.plan!,inputRate:2147483647,outputRate:1,taps:2,phases:1}},start=performance.now();
 expect(()=>createAudioResampleState(1,limits,hostile)).toThrow('allocation limit');const {history,pending,...header}=hostile;expect(()=>deserializeAudioResampleCheckpoint(envelope(JSON.stringify(header),new Uint8Array([...history,...pending])),limits)).toThrow('allocation limit');expect(performance.now()-start).toBeLessThan(1000);
});
it('rejects restoring under a different rate, requested precision or output frame size',()=>{
 const cp=base();expect(createAudioResampleState(48000,limits,cp).checkpoint()).toEqual(cp);
 expect(()=>createAudioResampleState(44100,limits,cp)).toThrow('mismatch');expect(()=>createAudioResampleState(48000,{...limits,sampleFormat:'dbl'},cp)).toThrow('mismatch');expect(()=>createAudioResampleState(48000,{...limits,maxFrameBytes:25*16},cp)).toThrow('mismatch');
 expect(createAudioResampleState(48000,{...limits,maxFrameBytes:24*16+15},cp).checkpoint()).toEqual(cp);
 const requested=createAudioResampleState(48000,{...limits,sampleFormat:'dbl'});void [...requested.push(frames(c)[0]!)];const explicit=requested.checkpoint();expect(explicit.requestedFormat).toBe('dbl');expect(()=>createAudioResampleState(48000,limits,explicit)).toThrow('mismatch');requested.dispose();
});
it('rejects snapshots, push and finish while a transition is suspended and poisons an early return',()=>{
 const input=frames(c),state=createAudioResampleState(48000,limits);void [...state.push(input[0]!)];const iterator=state.push(input[1]!);
 expect(()=>state.checkpoint()).toThrow('busy');expect(()=>state.push(input[2]!)).toThrow('busy');expect(()=>state.finish()).toThrow('busy');
 const long=createAudioResampleState(48000,limits);for(const item of input.slice(0,5))void [...long.push(item)];const pushing=long.push(input[5]!);expect(pushing.next().done).toBe(false);expect(()=>long.checkpoint()).toThrow('busy');pushing.return(undefined);expect(()=>long.checkpoint()).toThrow('poisoned');expect(()=>long.push(input[6]!)).toThrow('poisoned');long.dispose();
 iterator.return(undefined);expect(()=>state.checkpoint()).toThrow('poisoned');expect(()=>state.finish()).toThrow('poisoned');state.dispose();
 const tail=createAudioResampleState(48000,limits);for(const item of input)void [...tail.push(item)];const draining=tail.finish();expect(draining.next().done).toBe(false);expect(()=>tail.checkpoint()).toThrow('busy');draining.return(undefined);expect(()=>tail.checkpoint()).toThrow('poisoned');tail.dispose();
 const limit=createAudioResampleState(48000,limits);expect(()=>limit.finish(0)).toThrow('frame limit');expect(()=>limit.finish(1.5)).toThrow('frame limit');limit.dispose();
});
it.each(['next','return','throw'] as const)('does not let a completed iterator %s alter ownership of a newer transition',action=>{
 const input=frames(c),state=createAudioResampleState(48000,limits),old=state.push(input[0]!);void [...old];const current=state.push(input[1]!),reason=Error('closed old iterator');
 if(action==='throw')expect(()=>old.throw(reason)).toThrow(reason);else expect(old[action](undefined)).toMatchObject({done:true});
 expect(()=>state.checkpoint()).toThrow('busy');void [...current];expect(state.checkpoint().received).toBe('18');state.dispose();
});
it('poisons after malformed or discontinuous input and rejects use after disposal or cancellation',()=>{
 const input=frames(c);
 for(const variant of ['pts','format','rate','layout','unknown-pts','plane','non-finite'] as const){
  const state=createAudioResampleState(48000,limits);void [...state.push(input[0]!)];const restored=createAudioResampleState(48000,limits,state.checkpoint()),next={...input[1]!,planes:input[1]!.planes.map(plane=>plane.slice())};
  if(variant==='pts')next.pts={value:origin+18n,timeBase:{num:1n,den:44100n}};else if(variant==='format')next.sampleFormat='fltp';else if(variant==='rate')next.sampleRate=48000;else if(variant==='layout')next.channelLayout='different';else if(variant==='unknown-pts')next.pts=null;else if(variant==='plane')next.planes=[new Uint8Array(3),new Uint8Array(3)];else new DataView(next.planes[1]!.buffer).setFloat64(0,NaN,true);
  expect(()=>[...restored.push(next)]).toThrow(AudioConversionError);expect(()=>restored.checkpoint()).toThrow('poisoned');state.dispose();restored.dispose();
 }
 const state=createAudioResampleState(48000,limits);state.dispose();expect(()=>state.push(input[0]!)).toThrow('disposed');expect(()=>state.checkpoint()).toThrow('disposed');expect(()=>state.finish()).toThrow('disposed');expect(()=>state.dispose()).not.toThrow();
 const controller=new AbortController(),live=createAudioResampleState(48000,{...limits,signal:controller.signal});void [...live.push(input[0]!)];const cp=live.checkpoint();controller.abort(Error('stop'));
 expect(()=>live.finish()).toThrow('stop');expect(()=>createAudioResampleState(48000,{...limits,signal:controller.signal},cp)).toThrow('stop');
 const midway=new AbortController(),running=createAudioResampleState(48000,{...limits,signal:midway.signal});for(const item of input.slice(0,5))void [...running.push(item)];const steps=running.push(input[5]!);steps.next();midway.abort(Error('halt'));expect(()=>steps.next()).toThrow('halt');expect(()=>running.checkpoint()).toThrow('poisoned');
});
