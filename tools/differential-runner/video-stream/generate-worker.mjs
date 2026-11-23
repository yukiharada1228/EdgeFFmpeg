import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','video-stream']);
const base=['1','25'],n=9007199254740993n,make=(pts,timeBase=base)=>({pts:pts.map(String),timeBase}),nested='[a]split[x][direct];[x][b]hstack[inner];[inner][direct]hstack[out]';
const recipes=[
 {graph:'[a][b]hstack[out]',a:make([0,2,4]),b:make([0,1,3])},
 {graph:'[a][b]hstack=shortest=1[out]',a:make([0,2,4]),b:make([0,1])},
 {graph:nested,a:make(Array.from({length:25},(_,i)=>i)),b:make([20,23])},
 {graph:'[inner][direct]hstack[out];[x][b]hstack[inner];[a]split[x][direct]',a:make([0,2,4,6]),b:make([1,3])},
 {graph:'[a]split[x][direct];[x][b]hstack=shortest=1[inner];[inner][direct]hstack[out]',a:make([0,2,4,6]),b:make([0,1])},
 {graph:'[a][b]vstack[out]',a:make([0,1,2],['2','50']),b:make([0,2],['4','100'])},
 {graph:'[a][b]hstack[out]',a:make([0,1,2],['1','1000001']),b:make([0,2],['1','1000001'])},
 {graph:'[a][b]hstack[out]',a:make([]),b:make([0,1])},
 {graph:'[a][b]hstack[out]',a:make([n,n+2n]),b:make([n*2n,n*2n+2n],['1','50'])}
].map((recipe,index)=>({id:String(index),...recipe}));
const provenance=JSON.parse(readFileSync('.build/oracles/video-stream/provenance.json')),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),cases=recipes.map(recipe=>{const native=JSON.parse(execFileSync('.build/oracles/video-stream/native',['0',recipe.a.timeBase.join('/'),recipe.b.timeBase.join('/'),recipe.a.pts.join(','),recipe.b.pts.join(','),recipe.graph],{encoding:'utf8',timeout:10000}));if(!native.accepted||!native.eof)throw new Error('Native graph did not finish');return {...recipe,native};});
if(hash(readFileSync('.build/oracles/video-stream/native'))!==provenance.binarySha256||hash(readFileSync('.build/reference/ffmpeg'))!==provenance.reference.artifacts.ffmpeg)throw new Error('Oracle changed during generation');
writeFileSync('compat/behavior-specs/video-stream-worker.json',JSON.stringify({provenance,cases},null,2)+'\n');writeFileSync('tests/workers/video-stream-cases.ts','export const cases='+JSON.stringify(recipes)+' as const;\n');console.log(JSON.stringify({cases:cases.length,events:cases.reduce((sum,c)=>sum+c.native.events.length,0)}));
