import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {BackendContext} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {executeFlacCopy} from '../../packages/avformat/src/flac-copy.js';
import evidence from '../../compat/behavior-specs/flac-selection/cases.json' with {type:'json'};
import corpus from '../../compat/behavior-specs/flac-cli/cases.json' with {type:'json'};
import pictures from '../../compat/behavior-specs/flac-pictures/native-pictures.json' with {type:'json'};
// Reassemble the exact Native144 pictured input using existing independent bytes,
// as recorded by its development generator. No native execution or regeneration.
const audio=Buffer.from(corpus.input,'base64');
const picture=Buffer.from(pictures.rows.find(row=>row.id==='bmp'&&row.transport==='block')!.payload,'base64');
let at=4,last=4;
for(;;){last=at;const end=at+4+audio.readUIntBE(at+1,3);if(audio[at]!&128){at=end;break;}at=end;}
const prefix=Buffer.from(audio.subarray(0,at));prefix[last]=prefix[last]!&127;
const header=Buffer.alloc(4);header[0]=134;header.writeUIntBE(picture.length,1,3);
const pictured=Buffer.concat([prefix,header,picture,audio.subarray(at)]);
function setup(input:Uint8Array,onOpen?:()=>void){
 let opens=0,commits=0,aborts=0,maxRead=0,maxWrite=0;const chunks:Uint8Array[]=[];
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:65536,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{
  async openRead(){onOpen?.();return {size:BigInt(input.length),async readAt(offset,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(offset),Number(offset)+Math.min(length,19));}};},
  async openWrite(){opens++;return {async write(data){maxWrite=Math.max(maxWrite,data.length);chunks.push(data.slice());},async commit(){commits++;},async abort(){aborts++;}};}
 }};
 return {context,get opens(){return opens;},get commits(){return commits;},get aborts(){return aborts;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;},text:()=>Buffer.concat(chunks).toString()};
}
it('uses the exact independently generated Native144 input bytes and provenance',()=>{
 expect(evidence.rows).toHaveLength(144);expect(evidence.commit).toBe(corpus.commit);expect(evidence.binarySha256).toBe(corpus.binarySha256);
 for(const [kind,bytes] of Object.entries({audio,pictured}))expect(createHash('sha256').update(bytes).digest('hex')).toBe(evidence.inputs[kind as 'audio'|'pictured']);
});
for(const [index,row] of evidence.rows.entries())it(`copy Native144 row ${index}: ${row.kind} ${row.maps.join(',')} audio=${row.audio} video=${row.video}`,async()=>{
 const run=setup(row.kind==='audio'?audio:pictured),args=['-i','/in.flac',...row.maps.flatMap(map=>['-map',map]),...(row.audio?[]:['-an']),...(row.video?[]:['-vn']),'-c','copy','-f','framecrc','/out'];
 const command=parseArgv(args),task=executeFlacCopy(command,run.context);
 if(row.exitCode!==0){await expect(task).rejects.toMatchObject({code:'invalid-arguments',exitCode:row.exitCode});expect(run.opens).toBe(0);}
 else if(row.selected.some(id=>id!==0)){
  // Selection is conformant, picture muxing remains explicitly unsupported.
  await expect(task).rejects.toMatchObject({code:'unsupported-command',message:expect.stringMatching(/attached pictures/)});expect(run.opens).toBe(0);
 }else{
  await expect(task).resolves.toEqual(['/out']);expect(run.text()).toBe(row.stdout);expect(run.commits).toBe(1);
 }
 expect(run.aborts).toBe(0);expect(run.maxRead).toBeLessThanOrEqual(run.context.budget.maxBufferBytes);expect(run.maxWrite).toBeLessThanOrEqual(run.context.budget.maxBufferBytes);
});
it('snapshots ordered selection and -an/-vn policy before input callbacks',async()=>{
 const command=parseArgv(['-i','/in.flac','-map','0','-map','-0:v','-c','copy','-f','framecrc','/out']);
 const run=setup(pictured,()=>{command.outputs[0]!.options.find(option=>option.name==='-map')!.value='0:v';command.outputs[0]!.options.push({name:'-an',value:null});});
 await expect(executeFlacCopy(command,run.context)).resolves.toEqual(['/out']);expect(run.commits).toBe(1);expect(run.text()).toBe(evidence.rows[0]!.stdout);
});
it('rejects map overflow and malformed maps before opening input or outputs',async()=>{
 for(const maps of [Array.from({length:65},()=> '0:a'),['0:a:'],['1:a?']]){
  let reads=0;const run=setup(audio,()=>{reads++;});
  await expect(executeFlacCopy(parseArgv(['-i','/in.flac',...maps.flatMap(map=>['-map',map]),'-c','copy','-f','framecrc','/out']),run.context)).rejects.toThrow();
  expect(reads).toBe(0);expect(run.opens).toBe(0);
 }
});
it('routes public copy selection through optional fallback and ordered removals',async()=>{
 for(const maps of [['0:2?'],['0','-0:v'],['0:a','0:a'],['-0:a?']]){
  const run=setup(audio),ffmpeg=new FFmpeg({backend:createMediaBackend(),budget:run.context.budget,filesystem:run.context.filesystem});
  const result=await ffmpeg.exec(['-i','/in.flac',...maps.flatMap(map=>['-map',map]),'-c','copy','-f','framecrc','/out']);
  expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);expect(run.commits).toBe(1);
 }
});
it('selection/copy production graph bundles for browsers without Node/native dependencies',async()=>{
 const {build}=await import('esbuild');
 const result=await build({entryPoints:['packages/avformat/src/flac-copy.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('.build/')||path.includes('runtime-node'))).toBe(false);
 expect(result.outputFiles[0]!.text).not.toMatch(/node:|child_process|\.build\//);
});
