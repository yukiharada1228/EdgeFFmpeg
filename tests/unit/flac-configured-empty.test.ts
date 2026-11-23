import {describe,expect,it} from 'vitest';
import type {AudioPadFormat} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {ResourceContext} from '@edge-ffmpeg/core';
import {compileFlacAudioFilters,processFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';
const format=():AudioPadFormat=>({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:{value:11n,timeBase:{num:1n,den:8000n}}});
async function* empty():AsyncIterable<AudioFrameData>{return;}
function setup(description='apad=pad_len=7',resident=14,buffer=14,inputFormat:AudioPadFormat|null=format(),frames:AsyncIterable<AudioFrameData>=empty()){
 const abort=new AbortController(),resources=new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:1000},abort.signal);
 const iterator=processFlacAudioFilters(frames,compileFlacAudioFilters(description,'s16'),{resources,signal:abort.signal,maxFrameBytes:buffer,...(inputFormat?{inputFormat}:{})})[Symbol.asyncIterator]();
 return {abort,resources,iterator};
}
describe('configured empty FLAC filters',()=>{
 it('emits seven silence samples with configured timestamp and holds the exact finite-tail reservation',async()=>{
  const {iterator,resources}=setup();const first=await iterator.next();
  expect(first.value).toMatchObject({samples:7,sampleRate:8000,channels:1,sampleFormat:'s16',pts:{value:11n,timeBase:{num:1n,den:8000n}}});
  expect(first.value!.planes[0]).toEqual(new Uint8Array(14));expect(resources.allocatedBytes).toBe(14);
  expect((await iterator.next()).done).toBe(true);expect(resources.allocatedBytes).toBe(0);
 });
 it('keeps unconfigured empty streams empty',async()=>{
  const {iterator,resources}=setup('apad=pad_len=7',14,14,null);
  expect((await iterator.next()).done).toBe(true);expect(resources.allocatedBytes).toBe(0);
 });
 it.each([[14,14,/budget/i],[14,13,/allocation/i]] as const)('rejects insufficient resident or buffer limits before opening input',async(resident,buffer,message)=>{
  let opens=0;const frames:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){opens++;return empty()[Symbol.asyncIterator]();}};
  const {iterator,resources}=setup('apad=pad_len=7',resident,buffer,format(),frames);
  const held=buffer===14?resources.allocate(1):undefined;
  await expect(iterator.next()).rejects.toThrow(message);expect(opens).toBe(0);expect(resources.allocatedBytes).toBe(held?1:0);held?.release();
 });
 it('snapshots configured metadata before awaiting the empty source',async()=>{
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
  async function* delayed():AsyncIterable<AudioFrameData>{await gate;}
  const configured=format(),{iterator,resources}=setup('apad=pad_len=7',14,14,configured,delayed());
  const pending=iterator.next();configured.sampleRate=16000;configured.pts={value:99n,timeBase:{num:1n,den:16000n}};finish();
  expect((await pending).value).toMatchObject({sampleRate:8000,pts:{value:11n}});await iterator.return?.();expect(resources.allocatedBytes).toBe(0);
 });
 it.each(['return','abort'])('releases configured reservation on %s after a padding yield',async exit=>{
  const {iterator,resources,abort}=setup('apad=pad_len=7:packet_size=2',4,4);await iterator.next();expect(resources.allocatedBytes).toBe(4);
  if(exit==='return')await iterator.return?.();else{const reason=new Error('stop configured padding');abort.abort(reason);await expect(iterator.next()).rejects.toBe(reason);}
  expect(resources.allocatedBytes).toBe(0);
 });
 it('cancels blocked empty source and observes late source cleanup failures',async()=>{
  let rejectNext!:(error:unknown)=>void,rejectReturn!:(error:unknown)=>void,opened=false,returns=0;
  const blocked=new Promise<IteratorResult<AudioFrameData>>((_resolve,reject)=>{rejectNext=reject;}),cleanup=new Promise<IteratorResult<AudioFrameData>>((_resolve,reject)=>{rejectReturn=reject;});
  const frames:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){opened=true;return {next:()=>blocked,return(){returns++;return cleanup;}};}};
  const {iterator,resources,abort}=setup('apad=pad_len=7',14,14,format(),frames),pending=iterator.next(),reason=new Error('cancel empty');
  for(let turn=0;turn<20&&!opened;turn++)await Promise.resolve();expect(opened).toBe(true);expect(resources.allocatedBytes).toBe(14);
  const assertion=expect(pending).rejects.toBe(reason);abort.abort(reason);await assertion;expect(returns).toBe(1);expect(resources.allocatedBytes).toBe(0);
  rejectNext(new Error('late next'));rejectReturn(new Error('late return'));await new Promise(resolve=>setTimeout(resolve,0));
 });
 it('rejects malformed configured metadata before opening input',async()=>{
  for(const configured of [{...format(),channels:0},{...format(),sampleRate:0},{...format(),sampleFormat:'bogus'},{...format(),pts:{value:1n,timeBase:{num:1n,den:3n}}}]){
   let opens=0;const input:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){opens++;return empty()[Symbol.asyncIterator]();}};
   const {iterator,resources}=setup('apad=pad_len=7',14,14,configured,input);await expect(iterator.next()).rejects.toThrow();expect(opens).toBe(0);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('rejects nonempty input which disagrees with configured format',async()=>{
  async function* input(){yield {...format(),sampleRate:16000,samples:1,planes:[new Uint8Array(2)]};}
  const {iterator,resources}=setup('apad=pad_len=7',14,14,format(),input());await expect(iterator.next()).rejects.toThrow(/Changing/);expect(resources.allocatedBytes).toBe(0);
 });
});
