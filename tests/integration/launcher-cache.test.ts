import {it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const moduleUrl=pathToFileURL(resolve('tools/cli/launcher-cache.mjs')).href,entry='export {value} from "./packages/demo/value.js";';
function fixture(){const root=mkdtempSync(join(tmpdir(),'launcher-cache-control-'));mkdirSync(join(root,'packages/demo'),{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));writeFileSync(join(root,'packages/demo/value.ts'),'export const value=1;');return root;}
function run(root:string,source=entry,cacheDirectory?:string){const script=`import {loadLauncher} from ${JSON.stringify(moduleUrl)};try{const result=await loadLauncher(${JSON.stringify(source)},${JSON.stringify({root,cacheDirectory})});console.log(JSON.stringify({value:result.launcher.value,hit:result.cacheHit,key:result.key}));}catch(error){console.log(JSON.stringify({error:error.message,evaluations:globalThis.evaluations}));}`;return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000})) as {value?:number;hit?:boolean;key?:string;error?:string;evaluations?:number};}
it('reuses only matching launcher sources and invalidates edits additions removals and configuration changes',()=>{
 const root=fixture();try{
  const first=run(root);expect(first).toMatchObject({value:1,hit:false});expect(run(root)).toMatchObject({value:1,hit:true,key:first.key});
  writeFileSync(join(root,'packages/demo/value.ts'),'export const value=2;');expect(run(root)).toMatchObject({value:2,hit:false});expect(run(root)).toMatchObject({value:2,hit:true});
  writeFileSync(join(root,'packages/demo/value.js'),'export const value=3;');expect(run(root)).toMatchObject({value:3,hit:false});expect(run(root)).toMatchObject({value:3,hit:true});
  rmSync(join(root,'packages/demo/value.js'));expect(run(root)).toMatchObject({value:2,hit:true});
  writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'es2022'}}));expect(run(root)).toMatchObject({value:2,hit:false});
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('rebuilds corrupt launcher artifacts and manifests instead of evaluating modified cached code',()=>{
 const root=fixture();try{const first=run(root),manifestPath=join(root,'.build/cli-launcher',first.key+'.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8')),artifact=join(root,'.build/cli-launcher',first.key+'-'+manifest.artifactSha256+'.mjs');
  writeFileSync(artifact,'throw Error("corrupt cache must not run");');expect(run(root)).toMatchObject({value:1,hit:false});expect(run(root)).toMatchObject({value:1,hit:true});
  writeFileSync(manifestPath,'{invalid');expect(run(root)).toMatchObject({value:1,hit:false});
  const corrected=JSON.parse(readFileSync(manifestPath,'utf8'));corrected.artifactSha256='../../outside';writeFileSync(manifestPath,JSON.stringify(corrected));expect(run(root)).toMatchObject({value:1,hit:false});
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('keeps unavailable caches and retargeted external workspaces on the fresh build path',()=>{
 const root=fixture(),external=mkdtempSync(join(tmpdir(),'launcher-cache-external-'));try{
  const blocked=join(root,'blocked');writeFileSync(blocked,'file');expect(run(root,entry,blocked)).toMatchObject({value:1,hit:false});
  writeFileSync(join(root,'packages/demo/package.json'),JSON.stringify({name:'@edge-ffmpeg/demo',type:'module',exports:'./value.ts'}));expect(run(root)).toMatchObject({value:1,hit:false});expect(run(root)).toMatchObject({value:1,hit:false});mkdirSync(join(root,'node_modules/@edge-ffmpeg'),{recursive:true});const link=join(root,'node_modules/@edge-ffmpeg/demo');symlinkSync(join(root,'packages/demo'),link);
  const exported='export {value} from "@edge-ffmpeg/demo";';expect(run(root,exported)).toMatchObject({value:1,hit:false});expect(run(root,exported)).toMatchObject({value:1,hit:true});
  writeFileSync(join(external,'package.json'),JSON.stringify({name:'@edge-ffmpeg/demo',type:'module',exports:'./value.js'}));writeFileSync(join(external,'value.js'),'export const value=9;');unlinkSync(link);symlinkSync(external,link);expect(run(root,exported)).toMatchObject({value:9,hit:false});expect(run(root,exported)).toMatchObject({value:9,hit:false});
 }finally{rmSync(root,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});}
},30000);
it('propagates entry module failures without evaluating a cached or fresh module twice',()=>{
 const root=fixture();try{const source='globalThis.evaluations=(globalThis.evaluations??0)+1;throw Error("entry failure");export const value=1;';for(let i=0;i<2;i++)expect(run(root,source)).toEqual({error:'entry failure',evaluations:1});}finally{rmSync(root,{recursive:true,force:true});}
},30000);
