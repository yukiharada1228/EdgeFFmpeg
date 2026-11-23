// Development-only bounded native characterization; no production parser imports.
import {readFileSync as read,writeFileSync as write,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir='compat/behavior-specs/flac-characterization',tool='tools/differential-runner/flac-characterization',sha=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(read(p)),lock=json('compat/upstream.lock.json'),ref=json('.build/reference/build-metadata.json');
assert.equal(lock.commit,ref.commit);assert.equal(execFileSync('git',['-C','upstream/ffmpeg','rev-parse','HEAD'],{encoding:'utf8'}).trim(),lock.commit);
const parts=['avformat','avcodec','swresample','avutil'],libs=parts.map(p=>`.build/reference/lib${p}/lib${p}.a`),sources=['libavcodec/flac.c','libavcodec/flac_parser.c','libavcodec/flac.h','libavcodec/flac_parse.h','libavutil/common.h'];
for(const p of sources)assert.equal(sha(read('upstream/ffmpeg/'+p)),sha(execFileSync('git',['-C','upstream/ffmpeg','show',`${lock.commit}:${p}`])));
const pins=Object.fromEntries([...libs,...sources.map(p=>'upstream/ffmpeg/'+p),tool+'/oracle.c',tool+'/generate.mjs','.build/reference/ffbuild/config.mak','compat/behavior-specs/flac-parser/cases.json'].map(p=>[p,sha(read(p))]));
const config=read('.build/reference/ffbuild/config.mak','utf8'),extra=parts.flatMap(p=>{const line=config.split('\n').find(s=>s.startsWith(`EXTRALIBS-${p}=`));assert(line);const s=line.slice(line.indexOf('=')+1).trim();assert(!/[$`"'\\]/.test(s));return s?s.split(/\s+/):[];});
mkdirSync(dir,{recursive:true});const binary=dir+'/native',input=dir+'/input.tmp',compile=['-I.build/reference','-Iupstream/ffmpeg',tool+'/oracle.c',...libs,...extra,'-o',binary];
execFileSync('cc',compile);
const raw=[];let calls=0;
function oracle(mode,bytes,...args){assert(++calls<=240);write(input,bytes);const r=spawnSync(binary,[mode,input,...args.map(String)],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});raw.push({mode,args,inputSha256:sha(bytes),status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});assert.equal(r.status,0,`${mode}: ${r.stderr}`);return r.stdout.trim().split('\n').map(s=>JSON.parse(s));}
function crc8(bytes){let c=0;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=((c<<1)^((c&128)?7:0))&255;}return c;}
function header({num=[0],block=1,rate=4,bps=4,channels=1,variable=false,blockExtra=[],rateExtra=[]}={}){const prefix=Buffer.from([255,248+Number(variable),block*16+rate,channels*16+bps*2,...num,...blockExtra,...rateExtra]);return Buffer.concat([prefix,Buffer.from([crc8(prefix),0])]);}
const recipes=[];function add(id,opts){recipes.push({id,bytes:header(opts)});}
for(const num of [[0],[127],[192,128],[193,191],[223,191],[224,128,128],[239,191,191],[240,128,128,128],[247,191,191,191],[248,128,128,128,128],[251,191,191,191,191],[252,128,128,128,128,128],[253,191,191,191,191,191],[254,128,128,128,128,128,128],[255],[128],[192,0]])add('number-'+num.join('-'),{num});
for(let block=0;block<16;block++)for(const edge of block===6||block===7?[0,255]:[0])add(`block-${block}-${edge}`,{block,blockExtra:block===6?[edge]:block===7?[edge,edge]:[]});
for(let rate=0;rate<16;rate++)for(const edge of rate>=12&&rate<=14?[0,255]:[0])add(`rate-${rate}-${edge}`,{rate,rateExtra:rate===12?[edge]:rate===13||rate===14?[edge,edge]:[]});
for(let bps=0;bps<8;bps++)add('bps-'+bps,{bps});
for(let channels=0;channels<16;channels++)add('channels-'+channels,{channels});
add('variable-inherited',{variable:true,rate:0,bps:0});
const longest=header({num:[253,191,191,191,191,191],block:7,blockExtra:[255,255],rate:14,rateExtra:[255,255]});
for(let n=0;n<longest.length;n++)recipes.push({id:'truncated-'+n,bytes:longest.subarray(0,n),truncated:true});
for(const [id,index,value] of [['bad-crc',5,1],['bad-subframe',6,128]]){const b=header();b[index]^=value;recipes.push({id,bytes:b});}
const headers=recipes.map(r=>({...r,bytes:r.bytes.toString('hex'),native:oracle('header',r.bytes)[0]}));
const old=json('compat/behavior-specs/flac-parser/cases.json'),graphs=[];
for(const id of ['samples-1728-prefix0','mutation-crc-first','mutation-missing-middle','mutation-duplicate-middle','mutation-reordered-middle','mutation-false-header-in-payload']){const b=Buffer.from(old.inputs[id].tail,'base64');graphs.push({id,hex:b.toString('hex'),native:oracle('graph',b)});}
// Zero-payload, CRC-valid overlapping candidates are generated independently.
const overlap=Buffer.concat(Array.from({length:8},(_,i)=>header({num:[i%3],rate:i%2?0:4,bps:i%3?4:0})).flatMap(b=>[b,Buffer.from([0,0])]));graphs.push({id:'synthetic-overlap',hex:overlap.toString('hex'),native:oracle('graph',overlap)});
const clean=Buffer.from(old.inputs['samples-1728-prefix0'].tail,'base64'),parser=[];
for(const chunk of [7,clean.length])for(const flags of [0,1,4096,4097])parser.push({chunk,flags,native:oracle('parser',clean,chunk,flags)});
for(const id of ['mutation-crc-first','mutation-false-header-in-payload']){const b=Buffer.from(old.inputs[id].tail,'base64');parser.push({id,hex:b.toString('hex'),chunk:b.length,flags:0,native:oracle('parser',b,b.length,0)});}
const direct=[];for(const chunk of [7,clean.length])direct.push({chunk,native:oracle('direct',clean,chunk,0)});
const avio=[];for(const chunk of [7,4096])avio.push({chunk,native:oracle('avio',clean,chunk)});
for(const[p,digest]of Object.entries(pins))assert.equal(sha(read(p)),digest);
write(dir+'/cases.json',JSON.stringify({headers,graphs,parserInput:clean.toString('hex'),parser,direct,avio},null,2)+'\n');write(dir+'/raw.json',JSON.stringify(raw,null,2)+'\n');
write(dir+'/provenance.json',JSON.stringify({referenceCommit:lock.commit,reference:ref,pins,compile,compiler:execFileSync('cc',['--version'],{encoding:'utf8'}),binarySha256:sha(read(binary)),calls,seed:'deterministic-domain-boundaries-v1',derivedExpectations:'Direct ff_flac_decode_frame_header and included pinned flac_parser.c; no production imports',rawSha256:sha(read(dir+'/raw.json')),casesSha256:sha(read(dir+'/cases.json'))},null,2)+'\n');
// Executables and transient inputs are not fixtures.
const {unlinkSync}=await import('node:fs');unlinkSync(binary);unlinkSync(input);console.log(JSON.stringify({calls,headers:headers.length,graphs:graphs.length,parser:parser.length,avio:avio.length}));
