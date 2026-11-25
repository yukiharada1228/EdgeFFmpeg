// Characterization only: the strict libFLAC prototype has no Native CLI policy layer.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPrototypeFlacDecoder} from './prototype/adapter.mjs';
import {inspectPrototypeWasm} from './prototype/validate-wasm.mjs';
const base='.build/flac-investigation/',sha=b=>createHash('sha256').update(b).digest('hex'),oracleBytes=fs.readFileSync(base+'native-error-cases.json'),oracle=JSON.parse(oracleBytes),wasm=fs.readFileSync(base+'prototype/edge-flac.wasm'),{module}=inspectPrototypeWasm(wasm),results=[];
if(oracle.rows.length!==70)throw Error('Incomplete malformed oracle');
for(const row of oracle.rows){
 const input=Buffer.from(row.input,'base64');if(sha(input)!==row.inputSha256)throw Error('Malformed fixture hash mismatch');
 let decoder,error=null,ended=false,owned=0;const parts=[],frames=[];
 try{decoder=await createPrototypeFlacDecoder(module,{size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}},{maxReadBytes:7,maxFrameBytes:4194304,md5Checking:false,reserve(n){owned+=n;return()=>{owned-=n;};}});
  for(let step=0;step<100;step++){const item=await decoder.next();if(item.status==='end'){ended=true;break;}if(item.status!=='frame')continue;
   try{if(item.metadata.channels!==2||item.metadata.bitsPerSample!==16)throw Error('Unexpected oracle PCM format');const bytes=Buffer.alloc(item.samples*4),planes=item.planes;for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<2;channel++)bytes.writeInt16LE(planes[channel][sample],(sample*2+channel)*2);parts.push(bytes);frames.push({position:String(item.samplePosition),samples:item.samples});}finally{item.release();}
  }
  if(!ended)throw Error('Prototype step budget exhausted');
 }catch(caught){error={name:caught.name,message:caught.message};}finally{await decoder?.close();}
 if(owned!==0)throw Error('Leaked malformed decoder reservation');const output=Buffer.concat(parts),native=row.output===null?null:Buffer.from(row.output,'base64');
 if(native&&sha(native)!==row.outputSha256)throw Error('Malformed reference output hash mismatch');
 results.push({id:row.id,profile:row.profile,nativeOptions:row.inputOptions,policyOptionsImplemented:row.inputOptions.length===0,nativeExitCode:row.exitCode,nativeOutputExists:row.outputExists,nativeOutputSamples:row.outputSamples,prototypeEnded:ended,prototypeError:error,prototypeSamples:output.length/4,prototypeOutput:output.toString('base64'),prototypeSha256:sha(output),frames,pcmEqual:native!==null&&output.equals(native),completionEqual:ended===(row.exitCode===0),cliExitCodeMapped:false,diagnosticsCompared:false,publicationCompared:false});
}
const result={status:'malformed-behavior-characterized-not-conformant',cases:70,pcmEqual:results.filter(r=>r.pcmEqual).length,pcmDifferent:results.filter(r=>!r.pcmEqual).length,completionDifferent:results.filter(r=>!r.completionEqual).length,unsupportedPolicyCases:results.filter(r=>!r.policyOptionsImplemented).length,oracleSha256:sha(oracleBytes),wasmSha256:sha(wasm),adapterSha256:sha(fs.readFileSync(base+'prototype/adapter.mjs')),results,fullConformance:false};
fs.writeFileSync(base+'malformed-prototype-result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,cases:70,pcmEqual:result.pcmEqual,pcmDifferent:result.pcmDifferent,completionDifferent:result.completionDifferent,unsupportedPolicyCases:result.unsupportedPolicyCases}));
