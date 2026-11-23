import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
/** Pin static media evidence and the Native oracle independently of the muxer. */
export function verifyMp4MuxCorpus(requireReference=true):void{
 const root='compat/behavior-specs/mp4-mux',hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),verify=(file:string,expected:string)=>{if(hash(file)!==expected)throw Error('MP4 evidence hash mismatch: '+file);},manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};for(const[file,digest]of Object.entries(manifest.sha256))verify(root+'/'+file,digest);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {reference:{commit:string;ffmpegSha256:string;ffprobeSha256:string};sources:Record<string,string>;baseCorpusManifestSha256:string};if(provenance.reference.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('MP4 reference commit mismatch');for(const[file,digest]of Object.entries(provenance.sources))verify(file,digest);
 const base='compat/behavior-specs/mp4-demux';verify(base+'/manifest.json',provenance.baseCorpusManifestSha256);const baseManifest=JSON.parse(readFileSync(base+'/manifest.json','utf8')) as {sha256:Record<string,string>};for(const[file,digest]of Object.entries(baseManifest.sha256))verify(base+'/'+file,digest);
 if(requireReference){verify('.build/reference/ffmpeg',provenance.reference.ffmpegSha256);verify('.build/reference/ffprobe',provenance.reference.ffprobeSha256);}
}
