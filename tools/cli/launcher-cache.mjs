import {build,version as esbuildVersion} from 'esbuild';
import {readFile,mkdir,rename,writeFile,rm} from 'node:fs/promises';
import {readFileSync,readdirSync,readlinkSync,realpathSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function sourceKey(root,entry){
 const hash=createHash('sha256');hash.update(JSON.stringify(['launcher-cache-v1',entry,esbuildVersion,process.version,process.platform,process.arch,process.env.ESBUILD_BINARY_PATH??null]));
 if(process.env.ESBUILD_BINARY_PATH){const binary=resolve(process.env.ESBUILD_BINARY_PATH),bytes=readFileSync(binary);hash.update(JSON.stringify(['compiler-override',binary,bytes.length]));hash.update(bytes);}
 function file(relative){const path=join(root,relative);const bytes=readFileSync(path);hash.update(JSON.stringify([relative,bytes.length]));hash.update(bytes);}
 function walk(relative){
  const entries=readdirSync(join(root,relative),{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const item of entries){if(['.build','node_modules','.git'].includes(item.name))continue;const name=relative+'/'+item.name;
   if(item.isDirectory())walk(name);
   else if(item.isSymbolicLink()){hash.update(JSON.stringify(['symlink',name,readlinkSync(join(root,name))]));const target=realpathSync(join(root,name));const info=statSync(target);if(!info.isFile())throw Error('Directory symlink cannot use launcher cache');file(name);}
   else if(item.isFile())file(name);
  }
 }
 walk('packages');
 const entries=readdirSync(root);for(const name of entries.filter(n=>['package.json','package-lock.json'].includes(n)||/^tsconfig.*\.json$/.test(n)).sort())file(name);
 for(const name of ['run.mjs','launcher-cache.mjs'])try{file('tools/cli/'+name);}catch(error){if(error.code!=='ENOENT')throw error;}
 // Workspace export resolution is part of the build identity,including symlink retargeting.
 for(const name of (readdirSync(join(root,'packages'))).sort()){
  const manifest=join(root,'packages',name,'package.json');let pkg;try{pkg=JSON.parse(readFileSync(manifest,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(pkg.name){const target=realpathSync(join(root,'node_modules',pkg.name));if(target!==realpathSync(join(root,'packages',name)))throw Error('External workspace target cannot use launcher cache');hash.update(JSON.stringify(['workspace',pkg.name,target]));}
 }
 return hash.digest('hex');
}
async function compile(root,entry){const result=await build({stdin:{contents:entry,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});return result.outputFiles[0].contents;}
const memoryImport=bytes=>import('data:text/javascript;base64,'+Buffer.from(bytes).toString('base64'));
/** Trusted workspace build cache only;VFS roots,argv,codec verification and execution are never cached. */
export async function loadLauncher(entry,{root=resolve(import.meta.dirname,'../..'),cacheDirectory}={}){
 root=resolve(root);const cache=cacheDirectory??join(root,'.build','cli-launcher');let key;
 try{key=await sourceKey(root,entry);}catch{return {launcher:await memoryImport(await compile(root,entry)),cacheHit:false};}
 const manifestPath=join(cache,key+'.json');let cachedArtifact;
 try{
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.schema!==1||manifest.key!==key||!/^[a-f0-9]{64}$/.test(manifest.artifactSha256))throw Error('Invalid launcher cache manifest');
  const artifact=join(cache,key+'-'+manifest.artifactSha256+'.mjs'),bytes=await readFile(artifact);if(digest(bytes)!==manifest.artifactSha256)throw Error('Launcher cache artifact changed');
  cachedArtifact=artifact;
 }catch{/* A missing/corrupt cache is rebuilt from current workspace sources. */}
 if(cachedArtifact)return {launcher:await import(pathToFileURL(cachedArtifact).href),cacheHit:true,key};
 const bytes=await compile(root,entry);if(sourceKey(root,entry)!==key)throw Error('Workspace changed while building launcher');
 const artifactSha256=digest(bytes),artifact=join(cache,key+'-'+artifactSha256+'.mjs'),temporary=join(cache,key+'.'+process.pid+'.'+randomUUID());let stored=false;
 try{
  await mkdir(cache,{recursive:true});await writeFile(temporary+'.mjs',bytes,{flag:'wx'});await rename(temporary+'.mjs',artifact);
  await writeFile(temporary+'.json',JSON.stringify({schema:1,key,artifactSha256})+'\n',{flag:'wx'});await rename(temporary+'.json',manifestPath);stored=true;
 }catch{/* Read-only/unavailable caches retain the original in-memory build path. */}
 finally{await Promise.allSettled([rm(temporary+'.mjs',{force:true}),rm(temporary+'.json',{force:true})]);}
 return {launcher:stored?await import(pathToFileURL(artifact).href):await memoryImport(bytes),cacheHit:false,key};
}
