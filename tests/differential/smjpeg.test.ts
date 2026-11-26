import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** A sandbox-built reference is accepted when it is the pinned commit without x86 assembly; its binary sha is never pinned. */
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
/** AVERROR(EINVAL) exits with (-EINVAL) & 255 on the reference host; EdgeFFmpeg always uses the Linux value (234). */
const hostEinval=(256-constants.errno.EINVAL)&255,linuxEinval=234,linuxStatus=(status:number|null)=>status===hostEinval?linuxEinval:status;
async function harness(prefix:string,maxBufferBytes=4096){
  // Every comparison asserts the reference build first, so a contract run filtered to one title still checks it.
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:maxBufferBytes,maxWriteBytes:maxBufferBytes});
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes,maxPendingPackets:2,maxCpuTimeMs:20000}});
  return {root,ffmpeg};
}
function signal(samples:number,channels:number,width:number){const data=new Uint8Array(samples*channels*width);for(let i=0;i<data.length;i++)data[i]=(i*151+(i>>3)*17+(i>>11))&255;return data;}
/** Runs the same arguments natively and through EdgeFFmpeg (input and output paths replaced) and compares the output bytes. */
async function compare(root:string,ffmpeg:FFmpeg,name:string,before:string[],input:string,after:string[]){
  execFileSync(native,['-v','error','-y',...before,'-i',join(root,input),...after,'-f','smjpeg',join(root,`${name}-native.smjpeg`)]);
  const result=await ffmpeg.exec([...before,'-i',`/${input}`,...after,'-f','smjpeg',`/${name}.smjpeg`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
  const expected=readFileSync(join(root,`${name}-native.smjpeg`));expect(readFileSync(join(root,`${name}.smjpeg`)).equals(expected),name).toBe(true);return expected;
}
it('runs against the pinned reference commit built without x86 assembly',()=>{
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native SMJPEG bytes for 3 layouts x 6 rates x 3 lengths x copy/encode x bitexact',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-smjpeg-matrix-');let compared=0;
  try{
    for(const channels of [1,2,6])for(const samples of [1,4097,10000]){
      writeFileSync(join(root,`s16-${channels}-${samples}.raw`),signal(samples,channels,2));writeFileSync(join(root,`u8-${channels}-${samples}.raw`),signal(samples,channels,1));
      for(const rate of [8000,11025,44100,48000,65536,96000])for(const mode of ['copy','encode','u8'] as const)for(const bitexact of [true,false]){
        const name=`${channels}-${samples}-${rate}-${mode}-${bitexact}`,before=['-f',mode==='u8'?'u8':'s16le','-ar',String(rate),'-ac',String(channels)];
        const bytes=await compare(root,ffmpeg,name,before,`${mode==='u8'?'u8':'s16'}-${channels}-${samples}.raw`,[...(mode==='copy'?['-c:a','copy']:[]),...(bitexact?['-bitexact']:[])]);
        // The header carries the low 16 bits of the rate, and the encoder text only without -bitexact.
        expect(bytes.includes(Buffer.from('encoder = Lavf'))).toBe(!bitexact);expect(bytes.readUInt16BE(bitexact?24:54)).toBe(rate&0xffff);compared++;
      }
    }
    expect(compared).toBe(3*3*6*3*2);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native SMJPEG packet regrouping through asetnsamples and apad chains and output -ss, -t and -frames:a',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-smjpeg-timing-',1<<16);let compared=0;
  try{
    for(const [rate,channels]of [[44100,1],[48000,2],[8000,2],[11025,6]] as const){
      const input=`in-${rate}-${channels}.raw`;writeFileSync(join(root,input),signal(9001,channels,2));const before=['-f','s16le','-ar',String(rate),'-ac',String(channels)];
      const profiles:string[][]=[
        ['-af','asetnsamples=n=7:p=0'],['-af','asetnsamples=n=1000:p=0'],['-af','asetnsamples=n=4:p=0'],['-af','asetnsamples=n=333:p=1'],
        ['-af','apad=pad_len=1234'],['-af','apad=whole_len=20000'],['-af','asetnsamples=n=100:p=0,apad=pad_len=55'],
        ['-ss','0.01'],['-ss','0.0333','-t','0.1'],['-t','0.05'],['-frames:a','2'],['-ss','0.02','-frames:a','1'],
        ['-c:a','copy','-ss','0.01'],['-c:a','copy','-t','0.07'],['-c:a','copy','-frames:a','1'],['-c:a','copy','-ss','0.005','-t','0.03'],
        ['-af','asetnsamples=n=250:p=0','-t','0.09'],['-af','apad=pad_len=300','-ss','0.1']
      ];
      for(const [index,after]of profiles.entries()){await compare(root,ffmpeg,`${rate}-${channels}-${index}`,before,input,[...after,'-bitexact']);compared++;}
    }
    expect(compared).toBe(4*18);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses SMJPEG codecs other than pcm_s16le with the native status and tagged inputs before any output exists',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-smjpeg-refusal-');
  try{
    writeFileSync(join(root,'in.raw'),signal(500,2,2));
    const cases:Array<[string,string[],string[]]>=[
      ['s16be',['-f','s16le'],['-c:a','pcm_s16be']],['u8',['-f','s16le'],['-c:a','pcm_u8']],['s24le',['-f','s16le'],['-c:a','pcm_s24le']],
      ['copy-s16be',['-f','s16be'],['-c:a','copy']],['copy-u8',['-f','u8'],['-c:a','copy']]
    ];
    for(const [name,format,codec]of cases){
      const args=[...format,'-ar','8000','-ac','2'],expected=spawnSync(native,['-v','error','-y',...args,'-i',join(root,'in.raw'),...codec,'-f','smjpeg',join(root,`${name}-native.smjpeg`)]);
      const result=await ffmpeg.exec([...args,'-i','/in.raw',...codec,'-f','smjpeg',`/${name}.smjpeg`]);
      expect(expected.status,name).toBe(hostEinval);expect(expected.stderr.toString()).toContain('unsupported audio codec');
      expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(linuxStatus(expected.status));expect(result.exitCode).toBe(linuxEinval);
      expect(result.diagnostics.at(-1)?.message).toMatch(/^SMJPEG muxer does not support pcm_/);expect(existsSync(join(root,`${name}.smjpeg`))).toBe(false);
    }
    // Native writes the input's global tags as _TXT chunks; the PCM path carries no tags, so a NIST SPHERE input with an extra key is refused.
    const nist=Buffer.alloc(1024+2000,0x20);nist.write('NIST_1A\n   1024\nchannel_count -i 2\nsample_rate -i 8000\nsample_n_bytes -i 2\nsample_byte_format -s2 01\nsample_count -i 500\ndatabase_id -s5 hello\nend_head\n',0,'latin1');
    nist.set(signal(500,2,2),1024);writeFileSync(join(root,'tagged.nist'),nist);
    execFileSync(native,['-v','error','-y','-i',join(root,'tagged.nist'),'-bitexact','-f','smjpeg',join(root,'tagged-native.smjpeg')]);expect(readFileSync(join(root,'tagged-native.smjpeg')).includes(Buffer.from('_TXT\0\0\0\x13database_id = hello','latin1'))).toBe(true);
    const tagged=await ffmpeg.exec(['-i','/tagged.nist','-bitexact','-f','smjpeg','/tagged.smjpeg']);
    expect(tagged.exitCode).not.toBe(0);expect(tagged.diagnostics.at(-1)?.message).toBe('Input metadata for the SMJPEG muxer is not implemented');expect(existsSync(join(root,'tagged.smjpeg'))).toBe(false);
    // No output extension selects SMJPEG, as native has none.
    const bare=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','/out.smjpeg']);expect(bare.exitCode).not.toBe(0);expect(existsSync(join(root,'out.smjpeg'))).toBe(false);
    expect(spawnSync(native,['-v','error','-y','-f','s16le','-ar','8000','-ac','2','-i',join(root,'in.raw'),join(root,'out-native.smjpeg')]).status).not.toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
