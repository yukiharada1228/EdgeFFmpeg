import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),linux=process.platform==='linux'&&process.arch==='x64';
const sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
/** The sandbox build is accepted unpinned: assert only its commit and that x86 assembly is disabled. */
function assertReference(){
  const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Deterministic interleaved PCM: integer formats use every byte pattern, floating formats stay finite in [-1.5,1.5] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0||i===5?-0:Math.sin(i*0.731)*((i%13)/8);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<18){
  assertReference();
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<21,maxWriteBytes:1<<21});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
/** Runs native and ours on the same arguments; returns both outputs. */
async function compare(root:string,frontend:FFmpeg,before:readonly string[],after:readonly string[],out:string){
  const expected=execFileSync(native,['-v','error','-y',...before.map(arg=>arg.startsWith('/')?join(root,arg.slice(1)):arg),...after,join(root,`native-${out}`)],{maxBuffer:1<<26});
  expect(expected.length).toBe(0);
  const result=await frontend.exec([...before,...after,`/${out}`]);
  expect(result.exitCode,JSON.stringify({before,after,diagnostics:result.diagnostics})).toBe(0);
  return {ours:readFileSync(join(root,out)),theirs:readFileSync(join(root,`native-${out}`))};
}
const modes=['lr>lr','lr>ms','ms>lr','lr>ll','lr>rr','lr>l+r','lr>rl','ms>ll','ms>rr','ms>rl','lr>l-r'];
/** Default levels, balance and base: every mix product is by 1 and every base product by 0, so FMA contraction cannot change a result. */
const portable=['stereotools',...modes.map((mode,index)=>`stereotools=mode=${index%2?mode:index}`),'stereotools=mutel=1','stereotools=muter=1','stereotools=mutel=1:muter=1','stereotools=phasel=1','stereotools=phaser=1','stereotools=phasel=on:phaser=yes:mode=lr>rl',
  ...[-20,-3,0,3,20].map(delay=>`stereotools=delay=${delay}`),'stereotools=delay=-0.01:mode=lr>ll','stereotools=delay=7.7:muter=1','stereotools=softclip=0:sclevel=40:phase=0'];
/** Non-default levels, side/middle balance, base and balance: float-sensitive (macOS contracts the mixes and base into FMA). */
const sensitive=[...modes.map(mode=>`stereotools=mode=${mode}:slev=3:sbal=-0.4:mlev=0.3:mpan=0.7`),
  ...['balance','amplitude','power'].flatMap(b=>[-1,-0.4,0,0.4,1].map(v=>`stereotools=bmode_in=${b}:balance_in=${v}:bmode_out=${b}:balance_out=${v===0?0.4:-v}`)),
  'stereotools=slev=0.015625:mlev=64:sbal=1:mpan=-1','stereotools=slev=64:mlev=0.015625:sbal=-1:mpan=1','stereotools=base=-1','stereotools=base=1','stereotools=base=0.37:mode=ms>rl','stereotools=level_in=0.015625:level_out=64','stereotools=level_in=3:level_out=0.2',
  ...[-20,-3,3,20].map(delay=>`stereotools=delay=${delay}:base=-0.6:mlev=1.3:mode=ms>lr`),'stereotools=0.5:2:-0.25:1:0:1:0:0:1:lr>rl:3:0.1:0.2:-0.3:0.4:-5:50:0:power:amplitude'];
async function rawSweep(prefix:string,chains:readonly string[],formats:readonly (typeof sources[number])[]){
  const {root,frontend}=await harness(prefix);
  let compared=0,index=0;
  try{
    for(const [raw,width]of formats){
      writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),5000*2));
      for(const rate of [8000,44100])for(const chain of chains){
        // f64 output for every case; s16 source also into s16 (rounded with -cpuflags 0) and f32.
        for(const [format,codec]of (raw==='s16le'?[['f64le','pcm_f64le'],['s16le','pcm_s16le'],['f32le','pcm_f32le']]:[['f64le','pcm_f64le']]) as [string,string][]){
          const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac','2','-i',`/${raw}.raw`],['-af',chain,'-c:a',codec,'-f',format],`${index++}.${format}`);
          expect(ours.equals(theirs),`${raw}/${rate}/${chain}/${format}`).toBe(true);compared++;
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  return compared;
}
async function crcSweep(prefix:string,options:readonly string[]){
  const {root,frontend}=await harness(prefix);
  let compared=0,index=0;
  try{
    writeFileSync(join(root,'s16le.raw'),pcm(2,false,7000*2));writeFileSync(join(root,'f64le.raw'),pcm(8,true,7000*2));
    execFileSync(native,['-v','error','-y','-f','s16le','-ar','44100','-ac','2','-i',join(root,'s16le.raw'),'-c:a','copy',join(root,'in.wav')]);
    const inputs=[['-f','s16le','-ar','8000','-ac','2','-i','/s16le.raw'],['-f','f64le','-ar','44100','-ac','2','-i','/f64le.raw'],['-i','/in.wav']];
    const profiles:[string[],string[]][]=[[[],[]],[[],['-ss','0.05']],[[],['-t','0.02']],[[],['-frames:a','2']],[[],['-ss','0.003','-t','0.05']]];
    const outputs=[['-c:a','pcm_f64le','-bitexact','-f','framecrc'],['-c:a','pcm_s16le','-bitexact','-f','wav'],['-c:a','pcm_f64le','-f','f64le']];
    for(const option of options){
      // Frame grouping: whole frames, 7-sample frames (p=0 and the padded default), 50-sample frames shorter than a 20 ms delay, then volume and apad.
      const chains=[option,`asetnsamples=n=7:p=0,${option}`,`asetnsamples=7,${option}`,`asetnsamples=n=50:p=0,${option}`,`volume=0.5,${option}`,`${option},apad=pad_len=300`,`${option},volume=0.5`];
      for(const input of inputs)for(const chain of chains)for(const [selection,output]of profiles)for(const format of selection.length||output.length?[outputs[0]!]:outputs){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0',...selection,...input],['-af',chain,...output,...format],`${index++}.out`);
        expect(ours.equals(theirs),`${input.join(' ')}/${chain}/${output.join(' ')}/${format.join(' ')}`).toBe(true);compared++;
      }
    }
    // Probe: native's output does not depend on frame grouping (p=0 keeps the length).
    for(const option of options)for(const n of [1,7,29,50]){
      const run=(chain:string)=>execFileSync(native,['-v','error','-f','f64le','-ar','8000','-ac','2','-i',join(root,'f64le.raw'),'-af',chain,'-f','f64le','-']);
      expect(run(`asetnsamples=n=${n}:p=0,${option}`).equals(run(option)),`${option} n=${n}`).toBe(true);compared++;
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  return compared;
}
it('matches native PCM bytes for every mode at default levels, mute, phase inversion and delay at 8000/44100 Hz from every source format',async()=>{
  // Per rate: 26 chains into f64 from each of the five sources, plus s16 and f32 output for s16 input.
  expect(await rawSweep('edgeffmpeg-stereotools-',portable,sources)).toBe(2*portable.length*(5+2));
},600000);
it.skipIf(!linux)('matches native PCM bytes for non-default levels, side and middle balance, base, balance modes and delay with base (linux/x64)',async()=>{
  expect(await rawSweep('edgeffmpeg-stereotools-float-',sensitive,sources)).toBe(2*sensitive.length*(5+2));
},600000);
it('matches native WAV, raw and framecrc for copy-like options across frame splits, volume, apad, WAV input and output selection',async()=>{
  expect(await crcSweep('edgeffmpeg-stereotools-crc-',['stereotools=delay=20:mode=lr>rl','stereotools=delay=-3:phasel=1:muter=1'])).toBe(2*3*7*(3+4)+2*4);
},600000);
it.skipIf(!linux)('matches native WAV, raw and framecrc for float-sensitive options across frame splits, volume, apad, WAV input and output selection (linux/x64)',async()=>{
  expect(await crcSweep('edgeffmpeg-stereotools-crc-float-',['stereotools=delay=-20:base=0.5:mode=ms>lr:slev=2:mpan=0.3:balance_in=0.4:bmode_in=power:balance_out=-0.6:bmode_out=amplitude'])).toBe(3*7*(3+4)+4);
},600000);
it('keeps the signed zeros of phase=-0, whose sin(-0) is -0, as native does',async()=>{
  // phase=-0 passes native's [0, 360] check; config_input's sin(-0/180*M_PI) is -0, so `L*1 - R*sin` turns a muted -0 into +0 where phase=0 keeps -0.
  // Default levels keep every product exact, so this runs on every platform.
  const {root,frontend}=await harness('edgeffmpeg-stereotools-negzero-');
  let compared=0,differing=0,index=0;
  try{
    const zeros=new Float64Array(3000*2);for(let i=0;i<zeros.length;i++)zeros[i]=i%3===0?-0:i%3===1?0:(i%7-3)*0.25;
    writeFileSync(join(root,'zeros.raw'),new Uint8Array(zeros.buffer));writeFileSync(join(root,'f64le.raw'),pcm(8,true,3000*2));writeFileSync(join(root,'s16le.raw'),pcm(2,false,3000*2));
    for(const [raw,file]of [['f64le','zeros.raw'],['f64le','f64le.raw'],['s16le','s16le.raw']] as const)for(const option of ['mutel=1','muter=1:phasel=1','mutel=1:muter=1:mode=lr>rl','phasel=1:delay=3']){
      const outputs:Buffer[]=[];
      for(const phase of ['phase=-0','phase=0']){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',`/${file}`],['-af',`stereotools=${phase}:${option}`,'-c:a','pcm_f64le','-f','f64le'],`${index++}.f64le`);
        expect(ours.equals(theirs),`${file}/${phase}:${option}`).toBe(true);compared++;outputs.push(theirs);
      }
      if(!outputs[0]!.equals(outputs[1]!))differing++;
    }
    expect(compared).toBe(3*4*2);
    // The sign really changes in native's output for the muted cases, so the comparison is not vacuous.
    expect(differing).toBeGreaterThan(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses softclip, phase, mono, out-of-range, unimplemented and enable= forms before output, beside native status',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-stereotools-refuse-');
  try{
    writeFileSync(join(root,'in.raw'),pcm(2,false,600*6));
    // Native exits with the negated errno's low byte; AVERROR_OPTION_NOT_FOUND gives 8.
    const ERANGE=256-constants.errno.ERANGE,EINVAL=256-constants.errno.EINVAL;
    const range=(name:string,value:string,min:number,max:number):[number,string,number,string]=>[2,`stereotools=${name}=${value}`,ERANGE,`Value ${value} for stereotools option ${name} out of range [${min} - ${max}]`];
    const cases:[number,string,number,string][]=[
      [2,'stereotools=softclip=1',0,'stereotools softclip requires unimplemented libm arithmetic'],[2,'stereotools=softclip=on:sclevel=10',0,'stereotools softclip requires unimplemented libm arithmetic'],
      [2,'stereotools=phase=90',0,'stereotools phase requires unimplemented libm arithmetic'],[2,'stereotools=phase=360',0,'stereotools phase requires unimplemented libm arithmetic'],
      [1,'stereotools',0,'stereotools requires stereo input; mono would be remixed implicitly'],[3,'stereotools',0,'stereotools requires stereo input; unspecified would be remixed implicitly'],
      range('level_in','0',0.015625,64),range('level_out','64.5',0.015625,64),range('balance_in','-1.5',-1,1),range('balance_out','1.01',-1,1),range('slev','0.01',0.015625,64),range('sbal','2',-1,1),
      range('mlev','65',0.015625,64),range('mpan','-1.1',-1,1),range('base','1.5',-1,1),range('delay','-20.5',-20,20),range('delay','21',-20,20),range('sclevel','0.5',1,100),range('phase','361',0,360),
      range('mode','11',0,10),range('bmode_in','3',0,2),range('bmode_out','-1',0,2),
      [2,'stereotools=mutel=2',EINVAL,'Unable to parse stereotools option mutel value 2 as boolean'],[2,'stereotools=phaser=auto',EINVAL,'Unable to parse stereotools option phaser value auto as boolean'],
      [2,'stereotools=mode=LR>LR',EINVAL,'Only lr>lr, lr>ms, ms>lr, lr>ll, lr>rr, lr>l+r, lr>rl, ms>ll, ms>rr, ms>rl, lr>l-r or an integer are implemented for stereotools option mode'],
      [2,'stereotools=foo=1',8,'Unsupported stereotools option: foo'],[2,'stereotools=1:level_out=2:3',EINVAL,'No stereotools option name near 3'],[2,`stereotools=${Array(21).fill('1').join(':')}`,EINVAL,'Too many stereotools option values near 1'],
      // Accepted natively, refused here: timeline enable, expressions, fractional integer options.
      [2,'stereotools=enable=1',0,'stereotools timeline enable is not implemented'],[2,'stereotools=mlev=1+1',0,'Only constant decimal values are implemented for stereotools option mlev'],
      [2,'stereotools=bmode_in=1.5',0,'Only balance, amplitude, power or an integer are implemented for stereotools option bmode_in']];
    let index=0;
    for(const [channels,chain,status,message]of cases){
      const args=['-f','s16le','-ar','8000','-ac',String(channels),'-i','/in.raw','-af',chain,'-f','f64le'];
      const run=spawnSync(native,['-v','error','-y',...args.map(arg=>arg==='/in.raw'?join(root,'in.raw'):arg),join(root,`native-${index}.raw`)],{encoding:'utf8'});
      expect(run.status,`${chain} ${run.stderr}`).toBe(status);
      const out=`${index++}.raw`,result=await frontend.exec([...args,`/${out}`]);
      expect(result.exitCode,chain).not.toBe(0);expect(existsSync(join(root,out)),chain).toBe(false);
      expect(result.diagnostics[0]?.message,chain).toBe(message);
    }
    expect(index).toBe(cases.length);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
