import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),reference=resolve(root,'.build/reference'),file=resolve(root,'compat/behavior-specs/filter-topology-native.json'),fixture=JSON.parse(readFileSync(file)),metadata=JSON.parse(readFileSync(resolve(reference,'build-metadata.json'))),lock=JSON.parse(readFileSync('compat/upstream.lock.json')),flags=readFileSync(lock.configureFile,'utf8').trim().split(/\s+/),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function verify(){
 if(metadata.commit!==lock.commit||JSON.stringify(metadata.flags)!==JSON.stringify(flags)||metadata.platform!==process.platform||metadata.arch!==process.arch)throw new Error('Reference provenance or host mismatch');
 for(const name of ['ffmpeg','ffprobe'])if(hash(readFileSync(resolve(reference,name)))!==metadata.artifacts[name])throw new Error('Reference binary changed');
 if(execFileSync('git',['-C','upstream/ffmpeg','rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw new Error('Upstream commit mismatch');
}
verify();
const components=['avfilter','avformat','avcodec','swscale','swresample','avutil'],libraries=components.map(name=>`.build/reference/lib${name}/lib${name}.a`),librarySha256=Object.fromEntries(libraries.map(file=>[file,hash(readFileSync(file))])),source=resolve(import.meta.dirname,'topology-oracle.c'),oracleSourceSha256=hash(readFileSync(source)),directory=resolve(root,'.build/filter-graph-oracles');mkdirSync(directory,{recursive:true});
// Keep linker argument order and repeated framework pairs from the pinned build.
// Configure writes these component variables as literal flags; reject unresolved Make syntax.
const config=readFileSync(resolve(reference,'ffbuild/config.mak'),'utf8'),extra=components.flatMap(name=>{
 const line=config.split('\n').find(line=>line.startsWith(`EXTRALIBS-${name}=`));
 if(!line)throw new Error(`Missing link metadata for ${name}`);
 const value=line.slice(line.indexOf('=')+1).trim();if(/[$`"'\\]/.test(value))throw new Error('Nonliteral linker metadata');return value?value.split(/\s+/):[];
}),binary=resolve(directory,'topology');
execFileSync(process.env.CC||'cc',[`-I${reference}`,`-I${resolve(root,'upstream/ffmpeg')}`,source,...libraries.map(file=>resolve(root,file)),...extra,'-o',binary]);
const cases=fixture.cases.map(({description})=>({description,native:JSON.parse(execFileSync(binary,[description],{encoding:'utf8',timeout:10000}))}));
verify();for(const [file,digest]of Object.entries(librarySha256))if(hash(readFileSync(file))!==digest)throw new Error('Reference library changed');if(hash(readFileSync(source))!==oracleSourceSha256)throw new Error('Oracle source changed');
writeFileSync(file,JSON.stringify({reference:metadata,oracleSourceSha256,librarySha256,cases},null,2)+'\n');console.log(JSON.stringify({cases:cases.length,oracleSourceSha256}));
