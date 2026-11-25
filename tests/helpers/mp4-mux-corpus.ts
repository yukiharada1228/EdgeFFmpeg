import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{pinnedReference,referencePin}from'./reference-identity.js';
interface RecordedMp4Reference{commit:string;ffmpegSha256:string;ffprobeSha256:string}
/**
 * The darwin-arm64 records compat/behavior-specs/mp4-{demux,mux}/provenance.json name the darwin-arm64 pin, on every
 * platform: they are tracked evidence of that pin and never stand for another platform's reference.
 */
export function assertDarwinMp4Provenance(reference:RecordedMp4Reference,file:string):void{
 const darwin=referencePin('darwin-arm64').artifacts;
 if(reference.ffmpegSha256!==darwin.ffmpeg||reference.ffprobeSha256!==darwin.ffprobe)throw Error('MP4 darwin-arm64 provenance does not name the darwin-arm64 pin: '+file);
}
/**
 * The Native reference an MP4 comparison runs: the pinned reference of this platform (pinnedReference()), checked
 * against the local binaries, and on darwin-arm64 also the reference the darwin-arm64 record names.
 */
export function verifyMp4NativeReference(recorded:RecordedMp4Reference):void{
 const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),reference=pinnedReference();
 if(hash('.build/reference/ffmpeg')!==reference.ffmpeg)throw Error('MP4 evidence hash mismatch: .build/reference/ffmpeg');
 if(hash('.build/reference/ffprobe')!==reference.ffprobe)throw Error('MP4 evidence hash mismatch: .build/reference/ffprobe');
 if(reference.id==='darwin-arm64'&&(recorded.ffmpegSha256!==reference.ffmpeg||recorded.ffprobeSha256!==reference.ffprobe))throw Error('MP4 evidence hash mismatch: darwin-arm64 provenance');
}
/** Pin static media evidence and the Native oracle independently of the muxer. */
export function verifyMp4MuxCorpus(requireReference=true):void{
 const root='compat/behavior-specs/mp4-mux',hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),verify=(file:string,expected:string)=>{if(hash(file)!==expected)throw Error('MP4 evidence hash mismatch: '+file);},manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};for(const[file,digest]of Object.entries(manifest.sha256))verify(root+'/'+file,digest);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {reference:RecordedMp4Reference;sources:Record<string,string>;baseCorpusManifestSha256:string};if(provenance.reference.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('MP4 reference commit mismatch');for(const[file,digest]of Object.entries(provenance.sources))verify(file,digest);
 const base='compat/behavior-specs/mp4-demux';verify(base+'/manifest.json',provenance.baseCorpusManifestSha256);const baseManifest=JSON.parse(readFileSync(base+'/manifest.json','utf8')) as {sha256:Record<string,string>};for(const[file,digest]of Object.entries(baseManifest.sha256))verify(base+'/'+file,digest);
 assertDarwinMp4Provenance(provenance.reference,root+'/provenance.json');assertDarwinMp4Provenance((JSON.parse(readFileSync(base+'/provenance.json','utf8')) as {reference:RecordedMp4Reference}).reference,base+'/provenance.json');
 if(requireReference)verifyMp4NativeReference(provenance.reference);
}
