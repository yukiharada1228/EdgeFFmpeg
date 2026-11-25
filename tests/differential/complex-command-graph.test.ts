import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {FFmpeg,planIndependentGraph,lowerComplexVideoCommand} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {complexCommandGraph,complexCommandBudget,complexCommandInput} from '../helpers/complex-command-graph.js';
import {pinnedReference} from '../helpers/reference-identity.js';
for(const mode of ['join','outputs'] as const)it(`lowers typed complex video ${mode} to Native-equivalent raw outputs`,async()=>{
 const binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const {graph,registry,bindings}=complexCommandGraph(mode),plan=planIndependentGraph(graph,registry,'node',complexCommandBudget);expect(plan.workUnits).toHaveLength(1);
 const command=lowerComplexVideoCommand(plan.workUnits[0]!,bindings,{globalArgs:['-cpuflags','0']}),outputs=new Map<string,Uint8Array[]>();
 const result=await new FFmpeg({backend:createMediaBackend(),budget:complexCommandBudget,filesystem:{async openRead(path){expect(path).toBe('/input/video.raw');return {size:BigInt(complexCommandInput.length),async readAt(offset,length){return complexCommandInput.subarray(Number(offset),Number(offset)+length);}};},async openWrite(path){const chunks:Uint8Array[]=[];outputs.set(path,chunks);return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){chunks.length=0;}};}}}).exec(command.args);
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(result.outputs).toHaveLength(mode==='join'?1:2);
 const directory=mkdtempSync(join(tmpdir(),'edge-complex-command-'));try{
  writeFileSync(join(directory,'input.raw'),complexCommandInput);const paths=new Map(command.outputs.map((output,index)=>[output.path,join(directory,'output-'+index+'.raw')]));
  execFileSync(binary,command.args.map(value=>value==='/input/video.raw'?join(directory,'input.raw'):paths.get(value)??value),{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
  if(mode==='join'){const expected=Array.from({length:3},(_,index)=>{const frame=complexCommandInput.subarray(index*4,index*4+4);return [frame[1]!,frame[0]!,frame[0]!,frame[1]!,frame[3]!,frame[2]!,frame[2]!,frame[3]!];}).flat();expect([...Buffer.concat(outputs.get('/output/joined.raw')!)]).toEqual(expected);}
  for(const output of command.outputs)expect(Buffer.concat(outputs.get(output.path)!)).toEqual(readFileSync(paths.get(output.path)!));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
