import {describe,expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {ResourceContext} from '../../packages/core/src/resources.js';
import {remixFlacAudio} from '../../packages/avformat/src/flac-wave-remix.js';

function resources(resident=4096,buffer=1024,signal=new AbortController().signal){
 return new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxCpuTimeMs:1000,maxPendingPackets:1},signal);
}
function frame(values:number[],channels:1|2=2,format:AudioSampleFormat='s16'):AudioFrameData{
 const base=format.replace(/p$/,''),width=base==='u8'?1:base==='s16'?2:base==='dbl'?8:4;
 const samples=values.length/channels,planar=format.endsWith('p');
 const planes=Array.from({length:planar?channels:1},()=>new Uint8Array(samples*(planar?1:channels)*width));
 for(let i=0;i<values.length;i++){
  const view=new DataView(planes[planar?i%channels:0]!.buffer),offset=(planar?Math.floor(i/channels):i)*width,value=values[i]!;
  if(base==='u8')view.setUint8(offset,value);else if(base==='s16')view.setInt16(offset,value,true);else if(base==='s32')view.setInt32(offset,value,true);else if(base==='flt')view.setFloat32(offset,value,true);else view.setFloat64(offset,value,true);
 }
 return {sampleRate:48000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples,planes,pts:{value:9007199254740993n,timeBase:{num:1n,den:48000n}}};
}
function source(items:AudioFrameData[],context:ResourceContext){
 const state={pulls:0,closed:0};
 const frames=(async function*(){try{for(const item of items){state.pulls++;const release=context.reserveExternalMemory(item.planes.reduce((sum,p)=>sum+p.byteLength,0));try{yield item;}finally{release();}}}finally{state.closed++;}})();
 return {frames,state};
}
function remix(items:AudioFrameData[],context:ResourceContext,channels:1|2=1,format:AudioSampleFormat='s16',maxFrameBytes=1024){
 const input=source(items,context);
 return {...input,output:remixFlacAudio(input.frames,channels,format,{resources:context,signal:new AbortController().signal,maxFrameBytes})};
}
function signed16(item:AudioFrameData){return item.planes.map(plane=>{const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:plane.byteLength/2},(_,i)=>view.getInt16(i*2,true));});}

describe('bounded FLAC audio remix helper',()=>{
 it('finishes an empty stream without allocations',async()=>{
  const context=resources(),{output,state}=remix([],context);
  expect((await output.next()).done).toBe(true);expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it('honors pre-aborted execution without opening the producer',async()=>{
  const context=resources(),abort=new AbortController(),reason=new Error('already cancelled');let opened=0;
  const input:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){opened++;return source([],context).frames;}};
  abort.abort(reason);const output=remixFlacAudio(input,1,'s16',{resources:context,signal:abort.signal,maxFrameBytes:64});
  await expect(output.next()).rejects.toBe(reason);expect(opened).toBe(0);expect(context.allocatedBytes).toBe(0);
 });
 it('rejects destination expansion beyond the frame cap even when source fits',async()=>{
  const context=resources(),{output,state}=remix([frame([1,2,3],1)],context,2,'dbl',24);
  await expect(output.next()).rejects.toThrow('allocation');expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it('does not prefetch, preserves frame boundaries and exact PTS, and owns only the yielded output',async()=>{
  const context=resources(),first=frame([-3,0,3,0,-32768,32767]),second={...frame([10,20]),pts:null};
  const {output,state}=remix([first,second],context);
  expect(state.pulls).toBe(0);expect(context.allocatedBytes).toBe(0);
  try{
   const a=(await output.next()).value!;
   expect(a).toMatchObject({samples:3,sampleRate:48000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:first.pts});
   expect(signed16(a)).toEqual([[-1,2,0]]);expect(a.planes[0]!.buffer).not.toBe(first.planes[0]!.buffer);
   expect(state.pulls).toBe(1);expect(context.allocatedBytes).toBe(18);
   a.planes[0]!.fill(0);expect(signed16(first)).toEqual([[-3,0,3,0,-32768,32767]]);
   const b=(await output.next()).value!;expect(b.samples).toBe(1);expect(b.pts).toBeNull();expect(signed16(b)).toEqual([[15]]);
   expect(state.pulls).toBe(2);expect(context.allocatedBytes).toBe(6);
   expect((await output.next()).done).toBe(true);expect(state.closed).toBe(1);
  }finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it.each(['','unknown','unspecified','1 channels','mono'])('normalizes mono layout %j',async layout=>{
  const context=resources(),input={...frame([0,32767],1),channelLayout:layout},{output}=remix([input],context,2,'s16p');
  try{const result=(await output.next()).value!;expect(result.channelLayout).toBe('stereo');expect(result.planes).toHaveLength(2);expect(signed16(result)[0]).toEqual(signed16(result)[1]);}finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it.each(['','unknown','unspecified','2 channels','stereo'])('normalizes stereo layout %j',async layout=>{
  const context=resources(),{output}=remix([{...frame([20,40]),channelLayout:layout}],context);
  try{expect(signed16((await output.next()).value!)).toEqual([[30]]);}finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it.each(['front-left','dual mono','5.1','1 channels'])('rejects explicit unsupported stereo layout %j and closes the producer',async channelLayout=>{
  const context=resources(),{output,state}=remix([{...frame([1,2]),channelLayout}],context);
  await expect(output.next()).rejects.toThrow('canonical');expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it('rejects multichannel input rather than silently selecting two channels',async()=>{
  const context=resources(),{output,state}=remix([{...frame([1,2]),channels:6,channelLayout:'5.1'}],context);
  await expect(output.next()).rejects.toThrow('canonical');expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it.each(['u8','u8p','s16','s16p','s32','s32p','flt','fltp','dbl','dblp'] as const)('owns unchanged-channel %s output without aliasing source planes',async format=>{
  const context=resources(),input=frame([0,1,2,3],2,format),{output}=remix([input],context,2,format);
  try{const result=(await output.next()).value!;expect(result.planes).toEqual(input.planes);expect(result.samples).toBe(input.samples);for(let i=0;i<input.planes.length;i++)expect(result.planes[i]!.buffer).not.toBe(input.planes[i]!.buffer);}finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it.each([29,30])('accounts input, converted-source scratch and output against a %i-byte real resident budget',async resident=>{
  const context=resources(resident,12),{output,state}=remix([frame([-3,0,3,0,-32768,32767])],context,1,'s16',12);
  try{if(resident===29)await expect(output.next()).rejects.toThrow('Memory budget');else{expect(signed16((await output.next()).value!)).toEqual([[-1,2,0]]);expect(context.allocatedBytes).toBe(18);}}finally{await output.return();}
  expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it.each([43,44])('reserves the additional internal mixed frame before final conversion with budget %i',async resident=>{
  const context=resources(resident,16),{output}=remix([frame([2,2,-2,-2],2,'flt')],context,1,'s16',16);
  try{if(resident===43)await expect(output.next()).rejects.toThrow('Memory budget');else{expect(signed16((await output.next()).value!)).toEqual([[32767,-32768]]);expect(context.allocatedBytes).toBe(20);}}finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it('bounds converted internal frames even when both source and final output fit',async()=>{
  const context=resources(100,8),{output}=remix([frame([0,1,2,3,4,5,6,7],2,'u8')],context,1,'u8',8);
  await expect(output.next()).rejects.toThrow('allocation');expect(context.allocatedBytes).toBe(0);
 });
 it('uses the smaller Core single-buffer limit instead of the requested cap',async()=>{
  const context=resources(100,8),{output}=remix([frame([1,2,3,4,5,6])],context,1,'s16',100);
  await expect(output.next()).rejects.toThrow('allocation');expect(context.allocatedBytes).toBe(0);
 });
 it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('rejects invalid maxFrameBytes %s before pulling',async maxFrameBytes=>{
  const context=resources(),{output,state}=remix([frame([1,2])],context,1,'s16',maxFrameBytes);
  await expect(output.next()).rejects.toThrow('limit');expect(state.pulls).toBe(0);expect(context.allocatedBytes).toBe(0);
 });
 it.each(['samples','sampleRate','planes'] as const)('rejects malformed %s without leaking producer storage',async field=>{
  const context=resources(),input=frame([1,2]);
  const bad=field==='samples'?{...input,samples:0}:field==='sampleRate'?{...input,sampleRate:NaN}:{...input,planes:[new Uint8Array(3)]};
  const {output,state}=remix([bad],context);await expect(output.next()).rejects.toThrow('dimensions');expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it('releases all reservations when the synchronous numerical helper rejects nonfinite input',async()=>{
  const context=resources(),{output,state}=remix([frame([NaN,0],2,'flt')],context,1,'flt');
  await expect(output.next()).rejects.toThrow('Non-finite');expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it.each(['separate','fused'] as const)('forwards the %s rounding profile unchanged',async arithmetic=>{
  const context=resources(),input=source([frame([0.734375,-0.9765625],2,'flt')],context);
  const output=remixFlacAudio(input.frames,1,'flt',{resources:context,signal:new AbortController().signal,maxFrameBytes:64,arithmetic});
  try{const result=(await output.next()).value!,p=result.planes[0]!;expect(new DataView(p.buffer,p.byteOffset,p.byteLength).getFloat32(0,true)).toBe(arithmetic==='fused'?-0.17125239968299866:-0.17125242948532104);}finally{await output.return();}
  expect(context.allocatedBytes).toBe(0);
 });
 it('releases a suspended output and producer storage on consumer throw',async()=>{
  const context=resources(),{output,state}=remix([frame([1,2])],context),reason=new Error('consumer failure');
  await output.next();expect(context.allocatedBytes).toBe(6);await expect(output.throw(reason)).rejects.toBe(reason);expect(state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it.each(['execution','resources'] as const)('observes %s cancellation when resumed from yield',async which=>{
  const execution=new AbortController(),core=new AbortController(),context=resources(4096,1024,core.signal),input=source([frame([1,2]),frame([3,4])],context);
  const output=remixFlacAudio(input.frames,1,'s16',{resources:context,signal:execution.signal,maxFrameBytes:64}),reason=new Error('cancelled');
  await output.next();(which==='execution'?execution:core).abort(reason);await expect(output.next()).rejects.toBe(reason);
  expect(input.state.pulls).toBe(1);expect(input.state.closed).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
 it('detaches an aborted next and return, while observing their late rejections',async()=>{
  const abort=new AbortController(),context=resources();let rejectNext!:(error:Error)=>void,rejectReturn!:(error:Error)=>void,entered!:()=>void,returns=0;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const input:AsyncIterableIterator<AudioFrameData>={
   [Symbol.asyncIterator](){return this;},
   next(){entered();return new Promise((_,reject)=>{rejectNext=reject;});},
   return(){returns++;return new Promise((_,reject)=>{rejectReturn=reject;});},
  };
  const output=remixFlacAudio(input,1,'s16',{resources:context,signal:abort.signal,maxFrameBytes:64});
  const reason=new Error('stop blocked producer'),pending=output.next(),assertion=expect(pending).rejects.toBe(reason);
  await started;abort.abort(reason);await assertion;expect(returns).toBe(1);expect(context.allocatedBytes).toBe(0);
  rejectNext(new Error('late next rejection'));rejectReturn(new Error('late return rejection'));await new Promise<void>(resolve=>setTimeout(resolve,0));
 });
 it('preserves a producer failure instead of masking it with cleanup failure',async()=>{
  const context=resources(),reason=new Error('source failure');let returns=0;
  const input:AsyncIterableIterator<AudioFrameData>={[Symbol.asyncIterator](){return this;},async next(){throw reason;},async return(){returns++;throw new Error('cleanup failure');}};
  const output=remixFlacAudio(input,1,'s16',{resources:context,signal:new AbortController().signal,maxFrameBytes:64});
  await expect(output.next()).rejects.toBe(reason);expect(returns).toBe(1);expect(context.allocatedBytes).toBe(0);
 });
});
