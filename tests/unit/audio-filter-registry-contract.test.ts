import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AudioFilterDescriptor} from '@edge-ffmpeg/avfilter';
import {channelLayoutName} from '@edge-ffmpeg/avutil';

const registryPath='../../packages/avfilter/src/audio/registry.js';
/** Loads the chain with one scratch descriptor added to the registry module, as a new filter is added. */
async function loadWith(build:(define:typeof import('../../packages/avfilter/src/audio/descriptor.js'))=>Record<string,AudioFilterDescriptor<{readonly name:string}>>){
 vi.resetModules();
 vi.doMock(registryPath,async importOriginal=>({...await importOriginal<Record<string,unknown>>(),...build(await import('../../packages/avfilter/src/audio/descriptor.js'))}));
 return import('../../packages/avfilter/src/audio/chain.js');
}
const base={parse:(text:string)=>Object.freeze({name:text}),capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:false,formatConstraint:false,rateConversion:false,timeSelection:false})};
afterEach(()=>{vi.doUnmock(registryPath);vi.resetModules();});

describe('audio filter registration contract',()=>{
 it('rejects a descriptor that defines both apply and stream when the registry loads',async()=>{
  // process() would run stream() while capabilities classify the step as stateless apply(): output -ss and FLAC placement would treat its state as absent.
  await expect(loadWith(({defineAudioFilter})=>({aboth:defineAudioFilter({...base,name:'aboth',examples:['aboth'],apply:(_step,frame)=>frame,async *stream(_step,frames){yield* frames;}})}))).rejects.toThrow(/^Invalid audio filter registration: aboth$/);
  await expect(loadWith(({defineAudioFilter})=>({anone:defineAudioFilter({...base,name:'anone',examples:['anone']})}))).rejects.toThrow(/^Invalid audio filter registration: anone$/);
 });
 it('rejects custom negotiation hooks outside the pre-registry approximations when the registry loads',async()=>{
  await expect(loadWith(({defineAudioFilter})=>({acustom:defineAudioFilter({...base,name:'acustom',examples:['acustom'],formats:()=>['s16p','fltp'],negotiate:()=>'s16p',apply:(_step,frame)=>frame})}))).rejects.toThrow(/^Invalid audio filter registration: acustom$/);
  await expect(loadWith(({defineAudioFilter})=>({aapprox:defineAudioFilter({...base,name:'aapprox',examples:['aapprox'],formats:()=>'planar',nativeFormats:()=>['s16p','fltp'],apply:(_step,frame)=>frame})}))).rejects.toThrow(/^Invalid audio filter registration: aapprox$/);
  // The same hooks on volume and adelay stay registered, and a plain native list loads.
  const chain=await loadWith(({defineAudioFilter})=>({alist:defineAudioFilter({...base,name:'alist',examples:['alist'],formats:()=>['s16p','fltp'],apply:(_step,frame)=>frame})}));
  expect(chain.compileAudioFilterChain('volume=0.5,adelay=1S,alist').steps.map(step=>step.name)).toEqual(['volume','adelay','alist']);
 });
 it('names the channel masks that constraints see as native does, and rejects masks outside 64 bits',()=>{
  // tests/differential/audio-channel-mask.test.ts compares these names with the native build.
  expect([3n,4n,5n,0x60000000n,0x103n,0x40001n,1n<<62n,1n<<63n].map(channelLayoutName)).toEqual(['stereo','mono','2 channels (FL+FC)','downmix','3.0(back)','2 channels (FL+USR18)','1 channels (BIR)','1 channels (USR63)']);
  for(const mask of [0n,-1n,1n<<64n,3 as unknown as bigint])expect(()=>channelLayoutName(mask)).toThrow(/^Invalid channel mask$/);
 });
});
