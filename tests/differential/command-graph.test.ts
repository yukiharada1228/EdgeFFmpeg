import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {FFmpeg,FeatureRegistry,planIndependentGraph,lowerIndependentCommand} from '@edge-ffmpeg/core';
import type {OperatorDescriptor,CommandOperatorBinding} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {pinnedReference} from '../helpers/reference-identity.js';
const budget={maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:15000,maxPendingPackets:16};
for(const filters of [1,2])it(`lowers ${filters} typed audio filter nodes to Native-equivalent PCM commands`,async()=>{
 const binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const registry=new FeatureRegistry<OperatorDescriptor>();
 for(const kind of ['source','decode','filter','encode','mux','sink'] as const){const input=kind==='source'?null:kind==='filter'||kind==='encode'?'audio-frame':'packet',output=kind==='sink'?null:kind==='decode'||kind==='filter'?'audio-frame':'packet';registry.register({id:kind,kind,status:'partial',testCases:[],runtimes:['node'],inputs:input?[{name:'in',type:input}]:[],outputs:output?[{name:'out',type:output}]:[],traits:{state:kind==='filter'?'stateless':'stateful',access:'sequential',checkpointable:false,temporal:kind!=='filter',deterministic:true,minimumMemoryBytes:1024,estimatedCpuTimeMs:1}});}
 const nodes=[{id:'source',featureId:'source'},{id:'decode',featureId:'decode'},...Array.from({length:filters},(_,index)=>({id:'filter'+index,featureId:'filter'})),{id:'encode',featureId:'encode'},{id:'mux',featureId:'mux'},{id:'sink',featureId:'sink'}];
 const graph={nodes,edges:nodes.slice(0,-1).map((node,index)=>({from:{node:node.id,port:'out'},to:{node:nodes[index+1]!.id,port:'in'},queueCapacity:1}))};
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in.raw',key:'input',options:['-f','s16le','-ar','8000','-ac','2']}],['decode',{kind:'input-options',options:[]}],['encode',{kind:'output-options',options:['-c:a','pcm_s16le']}],['mux',{kind:'output-options',options:['-f','s16le']}],['sink',{kind:'sink',path:'/out.raw'}]]);
 for(let index=0;index<filters;index++)bindings.set('filter'+index,{kind:'filter',mediaType:'audio',expression:index===0?'volume=0.5':'volume=0.25'});
 const command=lowerIndependentCommand(planIndependentGraph(graph,registry,'node',budget).workUnits[0]!,bindings,{globalArgs:['-cpuflags','0']});
 const values=[1,-1,3,-3,32767,-32768,1001,-1001,7,-7,15,-15,12345,-12345,0,2],input=new Uint8Array(values.length*2),view=new DataView(input.buffer);values.forEach((value,index)=>view.setInt16(index*2,value,true));
 const chunks:Uint8Array[]=[];let commits=0;
 const result=await new FFmpeg({backend:createMediaBackend(),budget,filesystem:{async openRead(path){if(path!=='/in.raw')throw Error('Unexpected input');return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(path){if(path!=='/out.raw')throw Error('Unexpected output');return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){chunks.length=0;}};}}}).exec(command.args);
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(commits).toBe(1);
 const directory=mkdtempSync(join(tmpdir(),'edge-command-graph-'));try{writeFileSync(join(directory,'in.raw'),input);execFileSync(binary,command.args.map(value=>value==='/in.raw'?join(directory,'in.raw'):value==='/out.raw'?join(directory,'out.raw'):value),{timeout:10000,maxBuffer:1048576,stdio:'pipe'});expect(Buffer.concat(chunks)).toEqual(readFileSync(join(directory,'out.raw')));}finally{rmSync(directory,{recursive:true,force:true});}
});
