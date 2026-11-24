import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';

const native=resolve('.build/reference/ffmpeg');
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;platform:string;arch:string};
/** alg divides by sqrtf(param+s*s): the native result depends on contraction (fused on macOS arm64), so it is pinned to the Linux x64 unfused profile only. */
const linuxX64=metadata.platform==='linux'&&metadata.arch==='x64';
const algSkip='requires the linux/x64 reference (unfused alg arithmetic); build-metadata reports '+`${metadata.platform}/${metadata.arch}`;
const sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
const frames=203,channels=2;
/** Stereo 8000 Hz input with zero, negative zero (float sources), clip boundaries, full-scale values and a ramp. */
function fixture(raw:string,width:number):Uint8Array{
  const count=frames*channels,data=new Uint8Array(count*width),view=new DataView(data.buffer);
  const special=[0,-0,1,-1,0.5,-0.5,0.001,-0.001,1.5,-1.5,0.0005,-2,0.999,-0.999999];
  for(let i=0;i<count;i++){
    const value=i<special.length?special[i]!:Math.sin(i*0.123)*1.4+0.3*Math.cos(i*0.49);
    if(raw==='u8')view.setUint8(i,i<4?[128,0,255,1][i]!:(i*37+13)&255);
    else if(raw==='s16le')view.setInt16(i*2,i<4?[0,-32768,32767,-1][i]!:Math.max(-32768,Math.min(32767,Math.round(value*23000))),true);
    else if(raw==='s32le')view.setInt32(i*4,i<4?[0,-2147483648,2147483647,1][i]!:Math.round(Math.max(-1,Math.min(1,value*0.7))*2147483647),true);
    else if(raw==='f32le')view.setFloat32(i*4,value,true);
    else view.setFloat64(i*8,i>=special.length?value+1e-12*i:value,true);
  }
  return data;
}
/** Every output: raw f32/f64/s16 and s16 WAV and f32 framecrc, written by one native run each. */
const outputs=[['f32',['-f','f32le']],['f64',['-f','f64le']],['s16',['-f','s16le']],['wav',['-bitexact','-f','wav']],['crc',['-c:a','pcm_f32le','-bitexact','-f','framecrc']]] as const;
async function compare(filters:readonly string[],label:string){
  const root=mkdtempSync(join(tmpdir(),`edgeffmpeg-asoftclip-${label}-`));let comparisons=0;
  try{
    const ffmpeg=new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:256,maxCpuTimeMs:5000,maxPendingPackets:2}});
    for(const [raw,width]of sources){
      writeFileSync(join(root,`${raw}.raw`),fixture(raw,width));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)];
      for(const [index,filter]of filters.entries()){
        execFileSync(native,['-v','error','-y',...before,'-i',join(root,`${raw}.raw`),...outputs.flatMap(([name,args])=>['-af',filter,...args,join(root,`n-${raw}-${index}.${name}`)])],{timeout:30000});
        for(const [name,args]of outputs){
          const path=`/e-${raw}-${index}.${name}`,result=await ffmpeg.exec([...before,'-i',`/${raw}.raw`,'-af',filter,...args,path]);
          expect(result.exitCode,`${raw} ${filter} ${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
          expect(readFileSync(join(root,path.slice(1))).equals(readFileSync(join(root,`n-${raw}-${index}.${name}`))),`${raw} ${filter} ${name}`).toBe(true);comparisons++;
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  return comparisons;
}
const grid=(type:string)=>['1','0.5','0.001'].flatMap(threshold=>['1','1.3','16'].flatMap(output=>['0.01','1','3'].map(param=>`asoftclip=type=${type}:threshold=${threshold}:output=${output}:param=${param}`)));

it('checks the pinned native reference build',()=>{
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
});
it('matches native asoftclip type=hard over the threshold, output and param grid on every source format byte for byte',async()=>{
  expect(await compare(grid('hard'),'hard')).toBe(27*5*5);
},600000);
it.skipIf(!linuxX64)(`matches native asoftclip type=alg over the threshold, output and param grid on every source format byte for byte (${linuxX64?'linux/x64':algSkip})`,async()=>{
  expect(await compare(grid('alg'),'alg')).toBe(27*5*5);
},600000);
it('matches native asoftclip hard in composed chains with frame splits, positional options and output time selection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asoftclip-chain-'));
  try{
    const ffmpeg=new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:256,maxCpuTimeMs:5000,maxPendingPackets:2}});
    const chains=['asetnsamples=7:p=0,asoftclip=hard:0.5:1.3','asoftclip=hard:0.001:16,asetnsamples=5','volume=0.5,asoftclip=hard:0.5:2','asoftclip=hard:0.5,asoftclip=hard:0.5:1.3','adelay=3S,asoftclip=hard:0.5:1.3,apad=pad_len=4','asoftclip=hard:0.5:1.3,aformat=f=s16'];
    const selections=[[],['-ss','0.002','-t','0.01'],['-frames:a','2']];let count=0;
    for(const [raw,width]of sources){
      writeFileSync(join(root,`${raw}.raw`),fixture(raw,width));const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)];
      for(const filter of chains)for(const selection of selections)for(const target of ['f32le','s16le']){
        const after=['-af',filter,...selection,'-c:a',target==='f32le'?'pcm_f32le':'pcm_s16le','-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,`${raw}.raw`),...after,'-'],{timeout:30000}),path=`/c-${count++}.crc`,result=await ffmpeg.exec([...before,'-i',`/${raw}.raw`,...after,path]);
        expect(result.exitCode,`${raw} ${filter} ${selection.join(' ')} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,path.slice(1))).equals(expected),`${raw} ${filter} ${selection.join(' ')} ${target}`).toBe(true);
      }
    }
    expect(count).toBe(5*6*3*2);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses every libm type, oversampling and unscoped options before writing output, where native succeeds or fails',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asoftclip-refuse-'));
  try{
    writeFileSync(join(root,'input.raw'),fixture('s16le',2));
    const ffmpeg=new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:256,maxCpuTimeMs:5000,maxPendingPackets:2}});
    const cases:[string,number][]=[
      ...['tanh','atan','cubic','exp','quintic','sin','erf'].map(type=>[`asoftclip=type=${type}`,0] as [string,number]),
      ['asoftclip',0],['asoftclip=hard:oversample=2',0],['asoftclip=alg:oversample=2',0],['asoftclip=hard:enable=gt(t\\,0.01)',0],['asoftclip=hard:threshold=1e-3',0],
      ['asoftclip=hard:threshold=2',1],['asoftclip=hard:param=0',1],['asoftclip=hard:oversample=65',1]
    ];
    for(const [index,[filter,status]]of cases.entries()){
      const args=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'];
      const reference=spawnSync(native,['-v','error','-y',...args,'-i',join(root,'input.raw'),'-af',filter,'-f','s16le',join(root,`native-${index}.raw`)],{timeout:30000});
      expect(reference.status===0?0:1,`${filter} native status ${reference.status}`).toBe(status);
      const result=await ffmpeg.exec([...args,'-i','/input.raw','-af',filter,'-f','s16le',`/ours-${index}.raw`]);
      expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics[0]?.code,`${filter} ${JSON.stringify(result.diagnostics)}`).toBe('unsupported-filter');expect(existsSync(join(root,`ours-${index}.raw`)),filter).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
