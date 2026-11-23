import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export interface DefaultLayoutCase {channels:number;samples:number;kind:string;guess:boolean;format:string;argv:string[];input:string;output:string;sha256:string;exitCode:number}
/** Host-only verification of fixed Native fixtures;never import this helper into a Worker bundle. */
export function verifiedDefaultLayoutCases():DefaultLayoutCase[]{
 const base='compat/behavior-specs/default-channel-layout/',hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const manifest=JSON.parse(readFileSync(base+'manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const[name,digest]of Object.entries(manifest.sha256))if(hash(readFileSync(base+name))!==digest)throw Error('Fixture changed:'+name);
 const provenance=JSON.parse(readFileSync(base+'provenance.json','utf8')) as {sources:Record<string,string>;librarySha256:string;reference:{artifacts:Record<string,string>}};
 for(const[name,digest]of Object.entries(provenance.sources))if(hash(readFileSync(name))!==digest)throw Error('Oracle source changed:'+name);
 if(hash(readFileSync('.build/reference/libavutil/libavutil.a'))!==provenance.librarySha256)throw Error('Native library changed');
 for(const name of ['ffmpeg','ffprobe'])if(hash(readFileSync('.build/reference/'+name))!==provenance.reference.artifacts[name])throw Error('Native artifact changed:'+name);
 const rows=JSON.parse(readFileSync(base+'cases.json','utf8')) as DefaultLayoutCase[];if(rows.length!==512)throw Error('Incomplete default-layout corpus');
 for(const row of rows)if(hash(Buffer.from(row.output,'base64'))!==row.sha256)throw Error('Native output changed');return rows;
}
