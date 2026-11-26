// audit-af probe harness (linux-probe only, never merged): runs one case on native and on EdgeFFmpeg, exactly as the branch differential tests do.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
export const native=resolve('.build/reference/ffmpeg');
export interface Case {id:string;before?:string[];input:string;after:string[]}
export interface Result {id:string;nativeStatus:number|null;nativeErr:string;edgeExit:number;edgeMsg:string;nativeBytes:number;edgeBytes:number;firstDiff?:number;verdict:string}
export function assertReference(){
  const m=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
  expect(m.commit.startsWith('946fcce0')).toBe(true);expect(m.flags).toContain('--disable-x86asm');
}
export const platformLabel=`${process.platform}-${process.arch}`;
export async function harness(label:string,files:Record<string,Uint8Array>,budget=1<<24){
  assertReference();
  const base=resolve('.build/audit-af-tmp');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,label+'-'));
  for(const [name,data]of Object.entries(files))writeFileSync(join(root,name),data);
  const filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<25,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:120000}});
  let n=0;
  const make=(args:string[],out:string)=>{const r=spawnSync(native,['-v','error','-nostdin','-y',...args,join(root,out)]);if(r.status!==0)throw new Error(`native make failed ${args.join(' ')} ${r.stderr}`);};
  async function run(c:Case):Promise<Result>{
    const before=c.before??[],nfile=join(root,`n${n}.out`);
    const nat=spawnSync(native,['-v','error','-nostdin','-y',...before,'-i',join(root,c.input),...c.after,nfile],{maxBuffer:1<<28});
    const nb=existsSync(nfile)?readFileSync(nfile):Buffer.alloc(0);if(existsSync(nfile))rmSync(nfile);
    const out=`/o${n++}.out`;let edgeExit=-1,edgeMsg='';
    try{const r=await frontend.exec([...before,'-i',`/${c.input}`,...c.after,out]);edgeExit=r.exitCode;edgeMsg=r.diagnostics.map(d=>d.message).join(' | ').slice(0,300);}catch(e){edgeExit=-2;edgeMsg=String(e).slice(0,300);}
    const path=join(root,out.slice(1)),eb=existsSync(path)?readFileSync(path):null;if(eb)rmSync(path);
    let firstDiff:number|undefined,verdict:string;
    if(nat.status===0&&edgeExit===0&&eb){if(eb.equals(nb))verdict='MATCH';else{verdict='DIVERGE';firstDiff=Math.min(nb.length,eb.length);for(let i=0;i<firstDiff;i++)if(nb[i]!==eb[i]){firstDiff=i;break;}}}
    else if(edgeExit===0)verdict='EDGE-ACCEPTS-NATIVE-REFUSES';
    else verdict=eb?'REFUSED-WITH-OUTPUT':'refused';
    return {id:c.id,nativeStatus:nat.status,nativeErr:nat.stderr.toString().slice(0,200),edgeExit,edgeMsg,nativeBytes:nb.length,edgeBytes:eb?.length??0,firstDiff,verdict};
  }
  return {root,run,make,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
export function pcm(width:number,floating:boolean,count:number,seed=0):Uint8Array{
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37+seed*11)&255);else{const v=i===0?-0:Math.sin(i*0.731+seed)*((i%13)/12);if(width===4)view.setFloat32(i*4,v,true);else view.setFloat64(i*8,v,true);}}
  return data;
}
/** Runs every case, writes the results to .build/linux-probe/audit-af-<name>.json and fails listing every divergence or refusal-with-output. */
export async function runAll(name:string,tmp:Awaited<ReturnType<typeof harness>>,cases:readonly Case[]){
  const results:Result[]=[];
  try{for(const c of cases)results.push(await tmp.run(c));}finally{tmp.cleanup();}
  const summary:Record<string,number>={};for(const r of results)summary[r.verdict]=(summary[r.verdict]??0)+1;
  mkdirSync(resolve('.build/linux-probe'),{recursive:true});
  writeFileSync(resolve(`.build/linux-probe/audit-af-${name}.json`),JSON.stringify({platform:platformLabel,summary,results},null,1));
  const bad=results.filter(r=>r.verdict!=='MATCH'&&r.verdict!=='refused');
  expect(bad.map(r=>`${r.verdict} ${r.id} native=${r.nativeStatus} edge=${r.edgeExit} bytes=${r.nativeBytes}/${r.edgeBytes} diff@${r.firstDiff} ${r.edgeMsg.slice(0,80)}`),JSON.stringify(summary)).toEqual([]);
  return summary;
}
