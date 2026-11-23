import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateNativeAacProbe} from './verify-native.mjs';
const source='tools/differential-runner/mp4-aac-explicit/probe.c',builder='tools/differential-runner/mp4-aac-explicit/build-native.mjs';
const libraries=['libavformat/libavformat.a','libavcodec/libavcodec.a','libswresample/libswresample.a','libavutil/libavutil.a'];
const read=p=>readFileSync(p),hash=b=>createHash('sha256').update(b).digest('hex');
export function ensureAacNativeProbe(){
 const metadata=JSON.parse(read('.build/reference/build-metadata.json')),lock=JSON.parse(read('compat/upstream.lock.json'));
 if(metadata.commit!==lock.commit||execFileSync('git',['-C','upstream/ffmpeg','rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw Error('Changed AAC native probe reference commit');
 if(execFileSync('git',['-C','upstream/ffmpeg','status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Modified AAC native probe reference headers');
 const snapshot=()=>{
  for(const n of ['ffmpeg','ffprobe'])if(hash(read('.build/reference/'+n))!==metadata.artifacts[n])throw Error('Changed AAC native reference binary');
  return Object.fromEntries(libraries.map(n=>[n,hash(read('.build/reference/'+n))]));
 };
 const before=snapshot(),compiler=execFileSync('cc',['--version'],{encoding:'utf8'}).trim(),binary='.build/aac-native-probe/probe',receipt='.build/aac-native-probe/build.json';
 const command=['-I','upstream/ffmpeg','-I','.build/reference',source,...libraries.map(n=>'.build/reference/'+n),'-lm','-pthread',...(process.platform==='darwin'?['-framework','CoreFoundation','-framework','CoreVideo','-framework','CoreMedia']:[]),'-o',binary];
 const fingerprint={verifierSha256:hash(read('tools/differential-runner/mp4-aac-explicit/verify-native.mjs')),baselineSourceSha256:hash(read('compat/behavior-specs/mp4-demux/inputs.json')),referenceCommit:lock.commit,sourceSha256:hash(read(source)),builderSha256:hash(read(builder)),librarySha256:before,compiler,platform:process.platform,arch:process.arch,command};
 if(existsSync(binary)&&existsSync(receipt)){const cached=JSON.parse(read(receipt));if(JSON.stringify(cached.inputs)===JSON.stringify(fingerprint)&&hash(read(binary))===cached.binarySha256)return{binary,provenance:cached};}
 mkdirSync('.build/aac-native-probe',{recursive:true});execFileSync('cc',command,{timeout:120000,maxBuffer:8388608});
 if(JSON.stringify(snapshot())!==JSON.stringify(before))throw Error('AAC reference changed while linking probe');
 const validation=validateNativeAacProbe(binary);if(JSON.stringify(snapshot())!==JSON.stringify(before))throw Error('AAC reference changed during probe validation');const provenance={inputs:fingerprint,binarySha256:hash(read(binary)),validation:{cases:validation.cases,failures:validation.failures.length}};writeFileSync(receipt,JSON.stringify(provenance,null,2)+'\n');return{binary,provenance};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=ensureAacNativeProbe();console.log(JSON.stringify({binary:result.binary,sha256:result.provenance.binarySha256}));}
