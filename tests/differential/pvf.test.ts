import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
function pvfFile(line:string,data:number){const head=Buffer.from(`PVF1\n${line}`,'latin1'),body=Buffer.alloc(data);for(let i=0;i<data;i++)body[i]=(i*151+(i>>3)*7+11)&255;return Buffer.concat([head,body]);}
function run(args:string[]){const result=spawnSync(native,['-v','error',...args]);return {status:result.status,stdout:result.stdout,stderr:result.stderr.toString()};}
async function setup(prefix:string,budget=128){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}})};
}
it('matches native PVF copy framecrc WAV and raw output across bit depths channels rates and lengths',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-pvf-');let compared=0;
  try{
    for(const bps of [8,16,24,32])for(const channels of [1,2,3])for(const rate of [8000,44100])for(const frames of [1,67,4100]){
      const name=`${bps}-${channels}-${rate}-${frames}`,path=join(root,`${name}.pvf`);writeFileSync(path,pvfFile(`${channels} ${rate} ${bps}\n`,frames*channels*bps/8));
      for(const [tail,ext] of [[['-c:a','copy','-bitexact','-f','framecrc'],'crc'],[['-bitexact','-f','wav'],'wav'],[['-f','s32le'],'raw']] as const){
        const nativeOut=join(root,`${name}-native.${ext}`),expected=run(['-cpuflags','0','-i',path,...tail,nativeOut]);expect(expected.status,expected.stderr).toBe(0);
        const out=`/${name}.${ext}`,result=await ffmpeg.exec(['-cpuflags','0','-i',`/${name}.pvf`,...tail,out]);expect(result.exitCode,`${name}/${ext} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(nativeOut)),`${name}/${ext}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(216);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native PVF seek duration and frame limits through copy framecrc',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-pvf-time-');
  try{
    writeFileSync(join(root,'in.pvf'),pvfFile('2 8000 16\n',4300*4));
    const profiles=[{before:[],after:[]},{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:[],after:['-frames:a','2']},{before:['-ss','0.25'],after:[]},{before:['-ss','0.1'],after:['-t','0.05']}];
    for(const [index,profile]of profiles.entries()){
      const after=[...profile.after,'-c:a','copy','-bitexact','-f','framecrc'],expected=run(['-cpuflags','0',...profile.before,'-i',join(root,'in.pvf'),...after,'-']);expect(expected.status).toBe(0);
      const result=await ffmpeg.exec(['-cpuflags','0',...profile.before,'-i','/in.pvf',...after,`/${index}.crc`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,`${index}.crc`)).equals(expected.stdout),String(index)).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
/** Each header line either matches native's framecrc and exit status, or is refused explicitly where native succeeds. */
const lines:ReadonlyArray<readonly [string,string,number,'match'|'refuse',string?]>=[
  ['plain','1 8000 16\n',20,'match'],
  ['extra spaces','  1   8000\t16  \n',20,'match'],
  ['vertical tab separators','1\t8000\v16\n',20,'match'],
  ['leading plus','+1 +8000 +16\n',20,'match'],
  ['plus-joined fields','1+8000+16\n',20,'match'],
  ['leading zeros','01 08000 016\n',20,'match'],
  ['extra fields','1 8000 16 99 abc\n',20,'match'],
  ['CRLF','1 8000 16\r\n',20,'match'],
  ['bare CR then data','1 8000 16\r',20,'match'],
  ['CR CR','2 8000 8\r\r',19,'match'],
  ['NUL terminator','1 8000 16\0',20,'match'],
  ['long line with trailing spaces','1 8000 16'+' '.repeat(40)+'\n',20,'match'],
  ['long line truncated after fields','1 8000 16 '+'a'.repeat(40)+'\n',20,'match'],
  ['long line pushing fields past 31 bytes',' '.repeat(35)+'1 8000 16\n',20,'match'],
  ['no terminator',  '1 8000 16',0,'match'],
  ['missing field','1 8000\n',20,'match'],
  ['hex rate','1 0x1f40 16\n',20,'match'],
  ['hex bps','1 8000 0x10\n',20,'match'],
  ['double sign','1 8000 +-16\n',20,'match'],
  ['zero channels','0 8000 16\n',20,'match'],
  ['513 channels','513 8000 16\n',20,'match'],
  ['negative rate','1 -8000 16\n',20,'match'],
  ['zero rate','1 0 16\n',20,'match'],
  ['zero bps','1 8000 0\n',20,'match'],
  ['bps above INT_MAX/512','1 8000 5000000\n',20,'match'],
  ['empty line','\n',20,'match'],
  ['bps 12','1 8000 12\n',20,'refuse','12 bits per sample'],
  ['bps 64','1 8000 64\n',32,'refuse','pcm_s64be'],
  ['bps 40','1 8000 40\n',20,'refuse','40 bits per sample'],
  ['bps 7','1 8000 7\n',20,'refuse','7 bits per sample'],
  ['rate wrapping past 32 bits','1 4294975296 16\n',20,'refuse','32-bit int range'],
  ['bps overflowing long','1 8000 1234567890123456789016\n',20,'refuse','32-bit int range'],
  ['partial trailing frame','2 8000 16\n',21,'refuse','Partial trailing'],
  ['line beyond the mirrored scan window','1 8000 16'+' '.repeat(130)+'\n',20,'refuse','header line extending past byte 128'],
];
it('mirrors or explicitly refuses the PVF header line-format matrix against native exit codes',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-pvf-lines-');
  try{
    for(const [index,[label,line,data,mode,message]]of lines.entries()){
      writeFileSync(join(root,`${index}.pvf`),pvfFile(line,data));
      const tail=['-c:a','copy','-bitexact','-f','framecrc'],expected=run(['-i',join(root,`${index}.pvf`),...tail,'-']),result=await ffmpeg.exec(['-i',`/${index}.pvf`,...tail,`/${index}.crc`]);
      if(mode==='match'){expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(expected.status);if(expected.status===0)expect(readFileSync(join(root,`${index}.crc`)).equals(expected.stdout),label).toBe(true);}
      else{expect(expected.status,label).toBe(label.includes('overflowing')?183:0);expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message!);}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native explicit -f pvf on a truncated file and skips the magic unchecked as native does',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-pvf-forced-');
  try{
    writeFileSync(join(root,'short.pvf'),Buffer.from('PVF','latin1'));writeFileSync(join(root,'other.pvf'),Buffer.concat([Buffer.from('XXXX\n1 8000 16\n','latin1'),Buffer.alloc(20,7)]));
    for(const name of ['short','other']){
      const expected=run(['-f','pvf','-i',join(root,`${name}.pvf`),'-c:a','copy','-bitexact','-f','framecrc','-']),result=await ffmpeg.exec(['-f','pvf','-i',`/${name}.pvf`,'-c:a','copy','-bitexact','-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).toBe(expected.status);if(expected.status===0)expect(readFileSync(join(root,`${name}.crc`)).equals(expected.stdout),name).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
it('matches native at the 512-channel maximum through copy framecrc and raw output',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-pvf-wide-',4096);
  try{
    writeFileSync(join(root,'wide.pvf'),pvfFile('512 8000 8\n',512*5));
    for(const [tail,ext] of [[['-c:a','copy','-bitexact','-f','framecrc'],'crc'],[['-f','s8'],'raw']] as const){
      const nativeOut=join(root,`native.${ext}`),expected=run(['-i',join(root,'wide.pvf'),...tail,nativeOut]);expect(expected.status,expected.stderr).toBe(0);
      const result=await ffmpeg.exec(['-i','/wide.pvf',...tail,`/edge.${ext}`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,`edge.${ext}`)).equals(readFileSync(nativeOut)),ext).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
