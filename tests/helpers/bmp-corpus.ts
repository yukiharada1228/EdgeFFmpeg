import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export function verifyBmpReference(requireReference=true){
 const root='compat/behavior-specs/bmp',hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const [path,digest]of Object.entries(manifest.sha256))if(hash(root+'/'+path)!==digest)throw Error('BMP corpus hash mismatch: '+path);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {commit:string;sources:Record<string,string>;recipes:Record<string,string>;reference:Record<string,string>};
 if(provenance.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('BMP reference commit mismatch');
 for(const [path,digest]of Object.entries({...provenance.sources,...provenance.recipes}))if(hash(path)!==digest)throw Error('BMP source/recipe mismatch: '+path);
 if(requireReference)for(const [name,digest]of Object.entries(provenance.reference))if(hash('.build/reference/'+name)!==digest)throw Error('BMP binary mismatch: '+name);
}
