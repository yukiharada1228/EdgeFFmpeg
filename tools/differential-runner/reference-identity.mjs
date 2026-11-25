// Pinned Native reference identity, shared by tests (tests/helpers/reference-identity.ts), corpus generators
// (platform-corpus.mjs) and the Linux tools. A local .build/reference is usable as evidence only when its
// build-metadata.json, configure flags, host and binary hashes resolve to exactly one entry of
// compat/reference-pins.json. Nothing here falls back to another platform. See docs/contributing/linux-reference.md.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const PINS_FILE='compat/reference-pins.json';
export const PROGRAMS=Object.freeze(['ffmpeg','ffprobe']);
const digest=/^[0-9a-f]{64}$/,short=value=>typeof value==='string'?value.slice(0,8)+'…':String(value);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const sha256File=path=>sha256(readFileSync(path));
export const platformId=(platform,arch)=>`${platform}-${arch}`;
const readJson=(root,path)=>{try{return JSON.parse(readFileSync(resolve(root,path),'utf8'));}catch(error){throw new Error(`${path} is unreadable: ${error.message}`);}};

/** Reads and validates compat/reference-pins.json. */
export function loadReferencePins(root=process.cwd()){
 const pins=readJson(root,PINS_FILE);
 if(pins?.schemaVersion!==1||typeof pins.commit!=='string'||typeof pins.tag!=='string'||!Array.isArray(pins.flags)||!pins.platforms||typeof pins.platforms!=='object')throw new Error(`${PINS_FILE} is not a schemaVersion 1 pin record`);
 for(const [id,pin]of Object.entries(pins.platforms)){
  const valid=pin&&platformId(pin.platform,pin.arch)===id&&PROGRAMS.every(name=>digest.test(pin.artifacts?.[name]))&&pin.libraries&&Object.values(pin.libraries).every(value=>digest.test(value))&&typeof pin.compiler==='string'&&typeof pin.source==='string'&&(pin.image===undefined||/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/.test(pin.image));
  if(!valid)throw new Error(`${PINS_FILE} platform ${id} is malformed`);
 }
 return pins;
}

/** One pin by id, with no fallback. */
export function referencePinFrom(pins,id){
 const pin=Object.hasOwn(pins.platforms,id)?pins.platforms[id]:undefined;
 if(!pin)throw new Error(`No pinned Native reference for ${id} (${PINS_FILE})`);
 return {id,...pin};
}

/**
 * Pure resolution of a reference build to its pin. Inputs: build-metadata.json (metadata), compat/upstream.lock.json
 * (upstream), compat/configure.flags as an array (flags), the executing host {platform, arch}, the sha256 of the local
 * ffmpeg and ffprobe (hashes) and the parsed pins. Throws on the first inconsistency.
 */
export function resolveReferenceIdentity({metadata,upstream,flags,host,hashes,pins}){
 if(!metadata||typeof metadata!=='object')throw new Error('Reference build-metadata.json is missing');
 if(metadata.commit!==upstream.commit)throw new Error(`Reference build-metadata.json records commit ${metadata.commit}, not ${upstream.commit} (compat/upstream.lock.json)`);
 if(JSON.stringify(metadata.flags)!==JSON.stringify(flags))throw new Error('Reference build-metadata.json flags differ from compat/configure.flags');
 const id=platformId(metadata.platform,metadata.arch),hostId=platformId(host.platform,host.arch);
 if(id!==hostId)throw new Error(`Reference build ${id} does not match this host ${hostId}`);
 for(const name of PROGRAMS)if(metadata.artifacts?.[name]!==hashes[name])throw new Error(`Reference ${name} ${short(hashes[name])} differs from build-metadata.json ${short(metadata.artifacts?.[name])}`);
 if(pins.commit!==upstream.commit||pins.tag!==upstream.tag)throw new Error(`${PINS_FILE} records ${pins.tag} ${pins.commit}, not ${upstream.tag} ${upstream.commit} (compat/upstream.lock.json)`);
 if(JSON.stringify(pins.flags)!==JSON.stringify(flags))throw new Error(`${PINS_FILE} flags differ from compat/configure.flags`);
 const pin=referencePinFrom(pins,id);
 for(const name of PROGRAMS)if(hashes[name]!==pin.artifacts[name])throw new Error(`Reference ${id} ${name} ${short(hashes[name])} is not the pinned ${short(pin.artifacts[name])} (${PINS_FILE})`);
 return {id,platform:pin.platform,arch:pin.arch,ffmpeg:pin.artifacts.ffmpeg,ffprobe:pin.artifacts.ffprobe,libraries:{...pin.libraries},metadata,pin};
}

export function configureFlags(root=process.cwd(),upstream=readJson(root,'compat/upstream.lock.json')){
 return readFileSync(resolve(root,upstream.configureFile),'utf8').trim().split(/\s+/);
}

/** Reads the inputs resolveReferenceIdentity needs from a checkout; dir is the reference build directory. */
export function readReferenceInputs(root=process.cwd(),{dir='.build/reference',host={platform:process.platform,arch:process.arch}}={}){
 const reference=resolve(root,dir),upstream=readJson(root,'compat/upstream.lock.json');
 let metadata;try{metadata=JSON.parse(readFileSync(resolve(reference,'build-metadata.json'),'utf8'));}catch(error){throw new Error(`Reference ${dir}/build-metadata.json is unreadable (${error.code??error.message}); build or bootstrap the reference first`);}
 const hashes={};for(const name of PROGRAMS){try{hashes[name]=sha256File(resolve(reference,name));}catch(error){throw new Error(`Reference ${dir}/${name} is unreadable (${error.code??error.message})`);}}
 return {metadata,upstream,flags:configureFlags(root,upstream),host,hashes,pins:loadReferencePins(root)};
}

/** The verified identity of a checkout's reference build. */
export function localReferenceIdentity(root=process.cwd(),options={}){return resolveReferenceIdentity(readReferenceInputs(root,options));}

/**
 * Asserts that a recorded reference (build-metadata shape {platform, arch, artifacts}) names the pin `id`.
 * A platform-corpus provenance ({referenceId, reference}) is accepted as well.
 */
export function assertRecordedPin(recorded,id,pins){
 const record=recorded?.reference&&typeof recorded.reference==='object'?recorded.reference:recorded,pin=referencePinFrom(pins,id);
 if(!record||typeof record!=='object')throw new Error('Recorded Native reference is missing');
 if(recorded!==record&&recorded.referenceId!==undefined&&recorded.referenceId!==id)throw new Error(`Corpus provenance names reference ${recorded.referenceId}, not ${id}`);
 const recordedId=platformId(record.platform,record.arch);
 if(recordedId!==id)throw new Error(`Corpus records Native reference ${recordedId}, not ${id}`);
 for(const name of PROGRAMS)if((name==='ffmpeg'||record.artifacts?.[name]!==undefined)&&record.artifacts?.[name]!==pin.artifacts[name])throw new Error(`Corpus records ${id} ${name} ${short(record.artifacts?.[name])}, not the pinned ${short(pin.artifacts[name])} (${PINS_FILE})`);
 return pin;
}

/** Directory holding a corpus for a platform: darwin-arm64 corpora stay at their tracked base, every other pin uses base/<id>. */
export const LEGACY_CORPUS_PLATFORM='darwin-arm64';
export function platformCorpusDirFor(base,id,pins){
 referencePinFrom(pins,id);
 return id===LEGACY_CORPUS_PLATFORM?base:`${base.replace(/\/+$/,'')}/${id}`;
}
