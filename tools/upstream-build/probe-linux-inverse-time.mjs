import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');process.chdir(root);
const mode=process.argv[2]??'all';
if(process.argv.length>3||!['all','--prepare-only','--check-prepared','--run-prepared','--finalize-prepared'].includes(mode))throw new Error('Expected --prepare-only, --check-prepared, --run-prepared or --finalize-prepared');
const prepare=mode==='all'||mode==='--prepare-only',run=mode==='all'||mode==='--run-prepared';
const directory=resolve('.build/linux-x64/inverse-time-probe'),reference=resolve('.build/linux-x64/reference');
mkdirSync(resolve(directory,'inputs'),{recursive:true});mkdirSync(resolve(directory,'portable'),{recursive:true});
if(mode!=='--check-prepared')rmSync(resolve(directory,'report.json'),{force:true});
const hash=data=>createHash('sha256').update(data).digest('hex'),metadata=JSON.parse(readFileSync(resolve(reference,'build-metadata.json'))),lock=JSON.parse(readFileSync('compat/reference-container.lock.json'));
const upstream=JSON.parse(readFileSync('compat/upstream.lock.json')),flags=readFileSync(upstream.configureFile,'utf8').trim().split(/\s+/);
if(!/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(lock.image)||lock.platform!=='linux/amd64')throw new Error('Invalid container lock');
const referenceBefore=hash(readFileSync(resolve(reference,'ffmpeg')));if(referenceBefore!==metadata.artifacts.ffmpeg||metadata.commit!==upstream.commit||metadata.platform!=='linux'||metadata.arch!=='x64'||JSON.stringify(metadata.flags)!==JSON.stringify(flags))throw new Error('Invalid oracle');
const bundle=await build({stdin:{contents:`export {FFmpeg} from '@edge-ffmpeg/core';export {createMediaBackend} from '@edge-ffmpeg/avformat';export {pixelLayout} from '@edge-ffmpeg/avutil';`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
const {FFmpeg,createMediaBackend,pixelLayout}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const jobs=prepare?[]:JSON.parse(readFileSync(resolve(directory,'jobs.json'))),geometries=[[1,1],[2,2],[3,2],[3,3],[5,3],[6,4],[8,6],[16,6],[17,9],[32,8],[33,32],[127,65],[5,7],[16,7],[16,5],[6,7]];
if(prepare){
for(const file of ['report.json','native-results.json','native-results.json.tmp'])rmSync(resolve(directory,file),{force:true});
for(const source of ['yuv420p','yuva420p','yuv422p','nv12','nv21'])for(const [width,height]of geometries){
 let seed=53;const data=Uint8Array.from({length:pixelLayout(source,width,height).bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
 const input=`${source}-${width}x${height}.raw`;writeFileSync(resolve(directory,'inputs',input),data);
 for(const destination of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const arithmetic of ['x86_64','scalar'])for(const timed of [false,true])for(const format of ['rawvideo','framecrc']){
  const id=`${source}-${destination}-${width}x${height}-${arithmetic}-${timed?'timed':'all'}-${format}`;
  const before=[...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-pix_fmt',destination,...(timed?['-ss','0.02','-t','0.05']:[]),'-bitexact','-f',format];
  let committed=false;const chunks=[];
  const ffmpeg=new FFmpeg({filesystem:{async openRead(path){if(path!=='/input.raw')throw new Error('Unexpected read');return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return{async write(bytes){chunks.push(bytes.slice());},async commit(){committed=true;},async abort(){chunks.length=0;}};}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
  const result=await ffmpeg.exec([...before,'-i','/input.raw',...after,'/output.out']);if(result.exitCode!==0||!committed)throw new Error(`${id}: ${JSON.stringify(result)}`);
  const output=Buffer.concat(chunks);writeFileSync(resolve(directory,'portable',`${id}.bin`),output);jobs.push({id,input,args:[...before,'-i',`/probe/inputs/${input}`,...after,'-'],expectedSha256:hash(output),inputSha256:hash(data)});
 }
}
writeFileSync(resolve(directory,'jobs.json'),JSON.stringify(jobs));
}
const program=`const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');const jobs=JSON.parse(fs.readFileSync('/probe/jobs.json')),results=[];for(const [index,job]of jobs.entries()){const output=cp.execFileSync('/reference/ffmpeg',['-v','error',...job.args],{timeout:30000});const sha256=crypto.createHash('sha256').update(output).digest('hex'),matched=sha256===job.expectedSha256;results.push({id:job.id,sha256,matched,...(matched?{}:{actualBase64:output.toString('base64')})});if((index+1)%100===0)console.error('Native inverse time probe '+(index+1)+'/'+jobs.length);}console.log(JSON.stringify(results));`;
if(prepare){
 writeFileSync(resolve(directory,'native-program.cjs'),program);
 writeFileSync(resolve(directory,'portable-bundle.mjs'),bundle.outputFiles[0].text);
 writeFileSync(resolve(directory,'prepared.json'),JSON.stringify({preparedAt:new Date().toISOString(),reference:metadata,referenceBefore,container:lock.image,sourceBundleSha256:hash(bundle.outputFiles[0].text),jobsSha256:hash(readFileSync(resolve(directory,'jobs.json'))),nativeProgramSha256:hash(program),cases:jobs.length},null,2)+'\n');
}
const prepared=JSON.parse(readFileSync(resolve(directory,'prepared.json')));
function validatePrepared(){
 if(prepared.cases!==4480||jobs.length!==4480||new Set(jobs.map(job=>job.id)).size!==4480||prepared.referenceBefore!==referenceBefore||prepared.container!==lock.image||JSON.stringify(prepared.reference)!==JSON.stringify(metadata)||prepared.sourceBundleSha256!==hash(bundle.outputFiles[0].text)||prepared.jobsSha256!==hash(readFileSync(resolve(directory,'jobs.json'))))throw new Error('Prepared timing probe provenance mismatch');
 const nativeProgramSha256=hash(readFileSync(resolve(directory,'native-program.cjs')));
 if(nativeProgramSha256!==hash(program)||prepared.nativeProgramSha256&&prepared.nativeProgramSha256!==nativeProgramSha256)throw new Error('Native timing program changed');
 const inputs=new Map();
 for(const job of jobs){
  const match=/^(yuv420p|yuva420p|yuv422p|nv12|nv21)-(rgb24|bgr24|rgba|bgra|argb|abgr|gbrp)-(\d+)x(\d+)-(x86_64|scalar)-(timed|all)-(rawvideo|framecrc)$/.exec(job.id);
  if(!match)throw new Error('Invalid timing case ID');
  const [,source,destination,w,h,arithmetic,selection,format]=match,width=Number(w),height=Number(h);
  if(!geometries.some(([x,y])=>x===width&&y===height))throw new Error('Unexpected timing geometry');
  const input=`${source}-${width}x${height}.raw`,expected=[...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25','-i',`/probe/inputs/${input}`,'-pix_fmt',destination,...(selection==='timed'?['-ss','0.02','-t','0.05']:[]),'-bitexact','-f',format,'-'];
  if(job.input!==input||JSON.stringify(job.args)!==JSON.stringify(expected))throw new Error('Timing reference options changed');
  if(!inputs.has(input)){
   let seed=53;const data=Uint8Array.from({length:pixelLayout(source,width,height).bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
   const digest=hash(data);if(hash(readFileSync(resolve(directory,'inputs',input)))!==digest)throw new Error('Timing input changed');inputs.set(input,digest);
  }
  if(job.inputSha256!==inputs.get(input)||hash(readFileSync(resolve(directory,'portable',`${job.id}.bin`)))!==job.expectedSha256)throw new Error('Portable timing evidence changed');
 }
}
validatePrepared();
if(mode==='--check-prepared'){console.log(`Validated ${jobs.length} prepared cases; no native execution`);process.exit(0);}
if(mode==='--prepare-only'){console.log(`Prepared ${jobs.length} portable outputs and native commands`);process.exit(0);}
rmSync(resolve(directory,'report.json'),{force:true});
if(run){
 rmSync(resolve(directory,'native-results.json'),{force:true});
 const temporary=resolve(directory,'native-results.json.tmp'),descriptor=openSync(temporary,'w');
 try{execFileSync('docker',['run','--rm','--platform',lock.platform,'--network','none','--mount',`type=bind,src=${reference},dst=/reference,readonly`,'--mount',`type=bind,src=${directory},dst=/probe,readonly`,lock.image,'node','-e',program],{stdio:['ignore',descriptor,'inherit']});}finally{closeSync(descriptor);}
 renameSync(temporary,resolve(directory,'native-results.json'));
}
const observations=JSON.parse(readFileSync(resolve(directory,'native-results.json')));
if(observations.length!==jobs.length||new Set(observations.map(item=>item.id)).size!==jobs.length)throw new Error('Incomplete native timing evidence');
for(const [index,item]of observations.entries()){
 if(item.id!==jobs[index].id||!/^[a-f0-9]{64}$/.test(item.sha256)||item.actualBase64&&hash(Buffer.from(item.actualBase64,'base64'))!==item.sha256)throw new Error('Invalid native timing result');
 item.matched=item.sha256===jobs[index].expectedSha256;
}
validatePrepared();
const referenceAfter=hash(readFileSync(resolve(reference,'ffmpeg')));if(referenceAfter!==referenceBefore)throw new Error('Oracle changed');
const summary={total:observations.length,passed:observations.filter(x=>x.matched).length,failed:observations.filter(x=>!x.matched).length};
writeFileSync(resolve(directory,'report.json'),JSON.stringify({diagnosticOnly:true,status:summary.failed?'failed':'passed',generatedAt:new Date().toISOString(),preparedAt:prepared.preparedAt,runner:{platform:process.platform,arch:process.arch,node:process.version},reference:metadata,container:lock.image,requestedPlatform:lock.platform,sourceBundleSha256:hash(bundle.outputFiles[0].text),jobsSha256:prepared.jobsSha256,nativeProgramSha256:hash(readFileSync(resolve(directory,'native-program.cjs'))),nativeResultsSha256:hash(readFileSync(resolve(directory,'native-results.json'))),referenceBefore,referenceAfter,referenceStable:true,compatibilityCertified:false,summary,observations},null,2)+'\n');console.log(JSON.stringify(summary));
if(summary.failed)process.exitCode=1;
