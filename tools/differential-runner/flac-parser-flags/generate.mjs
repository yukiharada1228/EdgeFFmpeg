// Development-only native generator; artifacts and input remain under .build.
import{readFileSync as read,writeFileSync as write,mkdirSync}from'node:fs';
import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import assert from'node:assert/strict';
const tool='tools/differential-runner/flac-parser-flags',dir='compat/behavior-specs/flac-parser-flags',build='.build/flac-parser-flags',sha=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(read(p));
const lock=json('compat/upstream.lock.json'),ref=json('.build/reference/build-metadata.json');assert.equal(lock.commit,ref.commit);assert.equal(execFileSync('git',['-C','upstream/ffmpeg','rev-parse','HEAD'],{encoding:'utf8'}).trim(),lock.commit);
const parts=['avcodec','swresample','avutil'],libs=parts.map(p=>`.build/reference/lib${p}/lib${p}.a`),config=read('.build/reference/ffbuild/config.mak','utf8'),extra=parts.flatMap(p=>{const line=config.split('\n').find(s=>s.startsWith(`EXTRALIBS-${p}=`));assert(line);const s=line.slice(line.indexOf('=')+1).trim();assert(!/[$`"'\\]/.test(s));return s?s.split(/\s+/):[];});
const files=[...libs,tool+'/oracle.c',tool+'/generate.mjs','upstream/ffmpeg/libavcodec/parser.c','upstream/ffmpeg/libavcodec/flac_parser.c','compat/behavior-specs/flac-parser/cases.json'];
for(const p of ['libavcodec/parser.c','libavcodec/flac_parser.c'])assert.equal(sha(read('upstream/ffmpeg/'+p)),sha(execFileSync('git',['-C','upstream/ffmpeg','show',`${lock.commit}:${p}`])));
const pins=Object.fromEntries(files.map(p=>[p,sha(read(p))]));mkdirSync(build,{recursive:true});mkdirSync(dir,{recursive:true});
const compile=['-I.build/reference','-Iupstream/ffmpeg',tool+'/oracle.c',...libs,...extra,'-o',build+'/oracle'];execFileSync('cc',compile);
const data=Buffer.from(json('compat/behavior-specs/flac-parser/cases.json').inputs['samples-1728-prefix0'].tail,'base64');write(build+'/input',data);const cases=[];
for(const chunk of [7,data.length])for(const flags of [0,1,4096,4097])for(const schedule of [0,1,2]){
 const stdout=execFileSync(build+'/oracle',[build+'/input',String(chunk),String(flags),String(schedule)],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});cases.push({chunk,flags,schedule,trace:stdout.trim().split('\n').map(s=>JSON.parse(s))});
}
// Explicit short backing inputs end in zeros, unlike seven-byte slices of the whole input.
for(const length of [5,7])for(const flags of [0,1,4096,4097]){
 const short=data.subarray(0,length);write(build+'/short-input',short);
 const stdout=execFileSync(build+'/oracle',[build+'/short-input',String(length),String(flags),'0'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 cases.push({inputHex:short.toString('hex'),chunk:length,flags,schedule:0,trace:stdout.trim().split('\n').map(s=>JSON.parse(s))});
}
for(const[p,digest]of Object.entries(pins))assert.equal(sha(read(p)),digest);
write(dir+'/cases.json',JSON.stringify({inputHex:data.toString('hex'),cases},null,2)+'\n');
write(dir+'/provenance.json',JSON.stringify({referenceCommit:lock.commit,pins,compile,compiler:execFileSync('cc',['--version'],{encoding:'utf8'}),calls:cases.length,binarySha256:sha(read(build+'/oracle')),casesSha256:sha(read(dir+'/cases.json')),backing:'Whole immutable input followed by AV_INPUT_BUFFER_PADDING_SIZE zeros; seven-byte declarations can inspect subsequent backing bytes.',derivedExpectations:'Independent public av_parser_parse2 calls, no production imports.'},null,2)+'\n');console.log(`${cases.length} native invocations`);
