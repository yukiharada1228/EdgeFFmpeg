import {beforeAll,it,expect} from 'vitest';import {execFileSync} from 'node:child_process';
import {negotiateVideoTopology} from '../../packages/avfilter/src/video-graph-formats.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native two-source pad negotiation across all declared format pairs',()=>{
 referencePixelArithmetic();const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],graphs=['[a][b]hstack[out]','[b][a]vstack[out]','[a]scale=4:4[x];[b]scale=6:4[y];[x][y]hstack[out]','[y]vflip[out];[x][b]hstack[y];[a]hflip[x]'];let checked=0;
 for(const a of formats)for(const b of formats)for(const graph of graphs)for(const targets of [[null],['rgba'],['nv12']])for(const trims of [[false,false],[true,false]])for(const inputOrder of [[0,1],[1,0]]){
  const sources=[{format:a,width:5,height:3},{format:b,width:5,height:3}],native=JSON.parse(execFileSync('.build/oracles/multi-input-formats/native',[graph,sources.map(x=>`${x.format}@${x.width}x${x.height}`).join(','),targets.map(x=>x??'-').join(','),trims.map(x=>x?'1':'0').join(''),inputOrder.join(','),'0','-'],{encoding:'utf8',timeout:10000})),actual=negotiateVideoTopology(graph,sources,targets,{inputTrim:trims,inputRegistrationOrder:inputOrder});
  expect({accepted:true,...actual},`${a}/${b}/${graph}/${targets}/${trims}/${inputOrder}`).toEqual(native);checked++;
 }expect(checked).toBe(9408);
},180000);

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','multi-input-formats'],{timeout:30000});},30000);
