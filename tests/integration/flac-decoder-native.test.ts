/** Development-only Native fixtures; production imports only the typed decoder. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import type {FlacDecodedFrame} from '../../packages/avcodec/src/flac/decoder-types.js';
import {flacInvestigationInput} from '../helpers/flac-investigation.js';
import {pinnedReference} from '../helpers/reference-identity.js';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
const module=new WebAssembly.Module(wasm);
interface CleanRow {id:string;flac:string;pcm:string;flacSha256:string;pcmSha256:string;bits:number;channels:number;samples:number}
const clean=flacInvestigationInput<{rows:CleanRow[]}>('native-cases.json').value;
// Edge-versus-Native malformed-input divergences per pinned reference, recorded from that platform's own Native
// evidence; a platform without an entry fails instead of borrowing another platform's counts.
const malformedDivergences:Readonly<Record<string,{pcmDifferent:number;completionDifferent:number;unsupported:number}>>={
 'darwin-arm64':{pcmDifferent:22,completionDifferent:31,unsupported:56}
};
function pcm(item:FlacDecodedFrame,bits:number):Buffer{
 const width=bits<=16?2:4,output=Buffer.alloc(item.samples*item.metadata.channels*width),planes=item.planes;
 for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<planes.length;channel++){
  const value=planes[channel]![sample]!<<(width*8-bits),index=(sample*planes.length+channel)*width;
  if(width===2)output.writeInt16LE(value,index);else output.writeInt32LE(value,index);
 }
 return output;
}
async function decode(bytes:Buffer,bits:number){
 let owned=0,ended=false,error:unknown;const parts:Buffer[]=[],frames:{position:string;samples:number}[]=[];
 const decoder=await createFlacDecoder(module,{size:BigInt(bytes.length),async readAt(offset,length){expect(length).toBeLessThanOrEqual(7);return bytes.subarray(Number(offset),Number(offset)+length);}},{maxReadBytes:7,reserveExternalMemory(n){owned+=n;return()=>{owned-=n;};}});
 try{for(let step=0;step<100;step++){
  const item=await decoder.next();if(item.status==='end'){ended=true;break;}
  if(item.status==='frame'){try{parts.push(pcm(item,bits));frames.push({position:String(item.samplePosition),samples:item.samples});}finally{item.release();}}
 }}catch(caught){error=caught;}finally{await decoder.close();}
 expect(owned).toBe(0);return {output:Buffer.concat(parts),frames,ended,error};
}
describe('FLAC finite Native PCM evidence',()=>{
 it('pins actual module and corpus counts',()=>{
  expect(hash(wasm)).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');expect(clean.rows).toHaveLength(78);
 });
 it.each(clean.rows)('$id PCM parity',async row=>{
  const bytes=Buffer.from(row.flac,'base64'),expected=Buffer.from(row.pcm,'base64');
  expect(hash(bytes)).toBe(row.flacSha256);expect(hash(expected)).toBe(row.pcmSha256);
  const result=await decode(bytes,row.bits);expect(result.error).toBeUndefined();expect(result.ended).toBe(true);expect(result.output.equals(expected)).toBe(true);
 });
 it('retains explicit malformed and unsupported CLI policy divergences',async()=>{
  interface Row {id:string;profile:string;input:string;inputSha256:string;output:string|null;exitCode:number;inputOptions:string[]}
  interface Baseline {id:string;profile:string;prototypeEnded:boolean;prototypeSha256:string;frames:{position:string;samples:number}[]}
  const {bytes:oracleBytes,value:oracle}=flacInvestigationInput<{rows:Row[]}>('native-error-cases.json');
  const baseline=flacInvestigationInput<{oracleSha256:string;results:Baseline[]}>('malformed-prototype-result.json').value;
  expect(hash(oracleBytes)).toBe(baseline.oracleSha256);expect(oracle.rows).toHaveLength(70);
  let pcmDifferent=0,completionDifferent=0,unsupported=0;
  for(const row of oracle.rows){
   const bytes=Buffer.from(row.input,'base64');expect(hash(bytes)).toBe(row.inputSha256);
   const result=await decode(bytes,16),prior=baseline.results.find(item=>item.id===row.id&&item.profile===row.profile)!;
   expect(result.ended,`${row.id}/${row.profile} completion`).toBe(prior.prototypeEnded);
   expect(hash(result.output),`${row.id}/${row.profile} PCM`).toBe(prior.prototypeSha256);expect(result.frames).toEqual(prior.frames);
   if(row.output===null||!result.output.equals(Buffer.from(row.output,'base64')))pcmDifferent++;
   if(result.ended!==(row.exitCode===0))completionDifferent++;if(row.inputOptions.length)unsupported++;
  }
  const {id}=pinnedReference(),expected=malformedDivergences[id],observed={pcmDifferent,completionDifferent,unsupported};
  if(!expected)throw new Error(`No malformed-divergence counts are recorded for ${id}; observed ${JSON.stringify(observed)} against this platform's Native evidence`);
  expect(observed).toEqual(expected);
 });
});
