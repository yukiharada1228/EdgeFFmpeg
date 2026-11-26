import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** AVERROR(e) exits with (-e) & 255 on the reference host; EdgeFFmpeg uses the Linux numbering (EINVAL 22, exit 234). */
const hostEinval=(256-constants.errno.EINVAL)&255,linuxEinval=234;
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Deterministic payload bytes (xorshift), so packets never repeat. */
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};}
/** Written here, independent of the module: 'SDX:', free text, 0x1a, version 1, name length and name, 4 bytes, depth, RL32 rate, 16 bytes, unsigned PCM. */
function sdxFile(o:{depth:number;rate:number;name:number;samples:number;text?:string;seed?:number;extra?:number}):Buffer{
  const next=random(o.seed??o.depth*7919+o.rate+o.name*31+o.samples),width=Math.max(1,o.depth>>3);
  const head=Buffer.from(`SDX:${o.text??''}`,'latin1'),fixed=Buffer.alloc(3+o.name+4+1+4+16),data=Buffer.alloc(o.samples*width+(o.extra??0));
  fixed[0]=0x1a;fixed[1]=1;fixed[2]=o.name;for(let i=0;i<o.name;i++)fixed[3+i]=next()&255;fixed.fill(0x5a,3+o.name,7+o.name);fixed[7+o.name]=o.depth;fixed.writeUInt32LE(o.rate>>>0,8+o.name);fixed.fill(0xa5,12+o.name);
  for(let i=0;i<data.length;i++)data[i]=next()&255;
  return Buffer.concat([head,fixed,data]);
}
function run(args:readonly string[]){const result=spawnSync(native,['-v','error','-y',...args],{timeout:60000});return {status:result.status,stdout:result.stdout,stderr:result.stderr.toString()};}
async function setup(prefix:string,budget=256){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
/** Decode outputs; one native call writes all four. */
const outputs=[['crc',['-bitexact','-f','framecrc']],['wav',['-bitexact','-f','wav']],['raw',['-f','s32le']],['au',['-bitexact','-f','au']]] as const;
const span=(rate:number)=>{let value=1;while(value*20<=rate)value*=2;return value;};
it('matches native SDX decode framecrc WAV raw and AU for four depths three rates name lengths 0 to 255 and three lengths',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sdx-');let files=0,compared=0;
  try{
    for(const depth of [8,16,24,32])for(const rate of [8000,22050,44100])for(const [index,name] of [0,1,17,255].entries()){
      const samples=[1,span(rate)-1,2*span(rate)+3][(index+depth+rate)%3]!,text=['','x','text\x00free\xff'.repeat(9)][index%3]!,ext=index%2?'dat':'sdx',base=`d${depth}-r${rate}-n${name}`,input=join(root,`${base}.${ext}`);
      writeFileSync(input,sdxFile({depth,rate,name,samples,text}));files++;
      const expected=run(['-cpuflags','0','-i',input,...outputs.flatMap(([suffix,tail])=>[...tail,join(root,`${base}.native.${suffix}`)])]);expect(expected.status,expected.stderr).toBe(0);
      for(const [suffix,tail] of outputs){
        const out=`/${base}.${suffix}`,result=await ffmpeg.exec(['-cpuflags','0','-i',`/${base}.${ext}`,...tail,out]);expect(result.exitCode,`${base}/${suffix} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`${base}.native.${suffix}`))),`${base}/${suffix}`).toBe(true);compared++;
      }
    }
    expect([files,compared]).toEqual([48,192]);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native SDX decode with output -ss -t and -frames:a through framecrc and WAV',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sdx-time-');let compared=0;
  try{
    const profiles=[['-ss','0.0125'],['-t','0.07'],['-ss','0.03','-t','0.1'],['-ss','0.2'],['-t','1'],['-frames:a','2']];
    for(const [depth,rate] of [[8,8000],[16,22050],[24,44100],[32,22050]] as const){
      const base=`d${depth}-r${rate}`,samples=3*span(rate)+11;writeFileSync(join(root,`${base}.sdx`),sdxFile({depth,rate,name:5,samples}));
      for(const [index,profile] of profiles.entries()){
        const tails=[['crc',[...profile,'-bitexact','-f','framecrc']],['wav',[...profile,'-bitexact','-f','wav']]] as const;
        const expected=run(['-cpuflags','0','-i',join(root,`${base}.sdx`),...tails.flatMap(([suffix,tail])=>[...tail,join(root,`${base}-${index}.native.${suffix}`)])]);expect(expected.status,expected.stderr).toBe(0);
        for(const [suffix,tail] of tails){
          const out=`/${base}-${index}.${suffix}`,result=await ffmpeg.exec(['-cpuflags','0','-i',`/${base}.sdx`,...tail,out]);expect(result.exitCode,`${base}/${index}/${suffix} ${JSON.stringify(result.diagnostics)}`).toBe(0);
          expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`${base}-${index}.native.${suffix}`))),`${base}/${index}/${suffix}`).toBe(true);compared++;
        }
      }
    }
    expect(compared).toBe(48);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses SDX -c copy before any output exists while native copies with a 1/90000 time base',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sdx-copy-');
  try{
    for(const [depth,rate] of [[8,8000],[16,22050],[24,44100],[32,44100]] as const){
      const base=`d${depth}`;writeFileSync(join(root,`${base}.sdx`),sdxFile({depth,rate,name:3,samples:2*span(rate)+5}));
      const expected=run(['-i',join(root,`${base}.sdx`),'-c:a','copy','-bitexact','-f','framecrc','-']);expect(expected.status,expected.stderr).toBe(0);
      const text=expected.stdout.toString(),rows=text.split('\n').filter(line=>/^0,/.test(line));
      expect(text).toContain('#tb 0: 1/90000');expect(rows).toHaveLength(3);
      // The first packet holds the default span (2048 samples at 22050 Hz), and its duration is in 90 kHz units.
      expect(Number(rows[0]!.split(',')[3])).toBe(Math.round(span(rate)*90000/rate));expect(Number(rows[0]!.split(',')[4])).toBe(span(rate)*depth/8);
      for(const [out,tail] of [[`/${base}.crc`,['-c:a','copy','-bitexact','-f','framecrc']],[`/${base}.raw`,['-c','copy','-f',`u${depth}${depth>8?'le':''}`]]] as const){
        const result=await ffmpeg.exec(['-i',`/${base}.sdx`,...tail,out]);
        expect([result.exitCode,result.diagnostics.at(-1)?.code,result.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','SDX stream copy is not implemented: native packets use a 1/90000 time base']);expect(existsSync(join(root,out.slice(1)))).toBe(false);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native SDX statuses for depth 12 a missing 0x1a and other invalid headers, and refuses unmirrored inputs before output',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sdx-bad-');
  try{
    const good=sdxFile({depth:16,rate:22050,name:4,samples:100});
    const cases:ReadonlyArray<readonly [string,Buffer,number|'host-einval']>=[
      ['depth12',sdxFile({depth:12,rate:22050,name:4,samples:100}),183],
      ['depth0',sdxFile({depth:0,rate:22050,name:4,samples:100}),183],
      ['depth64',sdxFile({depth:64,rate:22050,name:4,samples:100}),183],
      ['nomarker',Buffer.from('SDX:no marker byte in this whole file','latin1'),183],
      ['magiconly',Buffer.from('SDX:','latin1'),183],
      ['version2',Buffer.from(good.map((byte,i)=>i===5?2:byte)),183],
      ['cutbeforedepth',good.subarray(0,4+3+4+4),183],
      ['rate0',sdxFile({depth:16,rate:0,name:4,samples:100}),'host-einval'],
      ['ratebig',sdxFile({depth:8,rate:0x80000000,name:4,samples:100}),'host-einval'],
    ];
    for(const [name,bytes,status] of cases){
      writeFileSync(join(root,`${name}.sdx`),bytes);
      const expected=run(['-i',join(root,`${name}.sdx`),'-f','framecrc','-']),result=await ffmpeg.exec(['-i',`/${name}.sdx`,'-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).toBe(status==='host-einval'?hostEinval:status);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(status==='host-einval'?linuxEinval:status);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
    // Native accepts these; EdgeFFmpeg refuses them explicitly before output.
    const refused:ReadonlyArray<readonly [string,Buffer,readonly string[],string]>=[
      ['tail',sdxFile({depth:24,rate:22050,name:4,samples:100,extra:2}),[],'Partial trailing SDX sample is not implemented'],
      ['cutafterdepth',good.subarray(0,4+3+4+4+3),[],'Truncated SDX header is not implemented'],
      ['seek',good,['-ss','0.001'],'SDX input seeking is not implemented'],
    ];
    for(const [name,bytes,before,message] of refused){
      writeFileSync(join(root,`${name}.sdx`),bytes);
      const expected=run([...before,'-i',join(root,`${name}.sdx`),'-f','framecrc','-']),result=await ffmpeg.exec([...before,'-i',`/${name}.sdx`,'-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).toBe(0);expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message,name).toBe(message);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native -f sdx on free text that native detection would hand to the mov probe',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sdx-forced-');
  try{
    // 'free' at byte 4 is an mp4 atom type: undeclared, native mov_probe outscores sdx_probe's 50 and fails (183); EdgeFFmpeg detects sdx. Only -f sdx is compared.
    writeFileSync(join(root,'free.sdx'),sdxFile({depth:16,rate:22050,name:2,samples:3000,text:'free\x00\x00\x00\x08text'}));
    const undeclared=run(['-i',join(root,'free.sdx'),'-f','framecrc','-']);expect(undeclared.status).toBe(183);
    const expected=run(['-f','sdx','-i',join(root,'free.sdx'),'-bitexact','-f','framecrc','-']);expect(expected.status,expected.stderr).toBe(0);
    const result=await ffmpeg.exec(['-f','sdx','-i','/free.sdx','-bitexact','-f','framecrc','/free.crc']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
    expect(readFileSync(join(root,'free.crc')).equals(expected.stdout)).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
