import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
// The sandbox build need not reproduce a pinned binary: assert the source commit and flags only.
function assertReference():void{
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
// Layout from libavformat/nspdec.c: 'FORM','DS16', 4 skipped bytes, then {RB32 id, RL32 size} chunks; audio runs from the first audio chunk header to EOF.
const text=(value:string)=>[...value].map(c=>c.charCodeAt(0));
const le32=(value:number)=>[value&255,(value>>>8)&255,(value>>>16)&255,(value>>>24)&255];
const chunk=(id:string,size:number,body:readonly number[]=[])=>[...text(id),...le32(size),...body];
const hedr=(id:string,rate:number,size:number)=>chunk(id,size,[...Array.from({length:20},(_,i)=>(i*11+3)&255),...le32(rate),...Array.from({length:size-24},(_,i)=>(i*5+1)&255)]);
const file=(...parts:ReadonlyArray<readonly number[]>)=>Uint8Array.from([...text('FORMDS16'),9,8,7,6,...parts.flat()]);
const payload=(length:number)=>Array.from({length},(_,i)=>(i*131+7)&255);
const budget={maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:2000};
/** One native process per input writes every output, so each file costs one spawn. */
function nativeRun(args:readonly string[]):{status:number|null;stderr:string}{const result=spawnSync(native,['-hide_banner','-nostdin','-v','warning','-y',...args],{encoding:'utf8'});return {status:result.status,stderr:result.stderr};}
it('matches native framecrc, WAV, AIFF, AU, W64 and raw output with output -ss/-t for mono and stereo HEDR/HDR8 files, NOTE, unknown and SD_2 chunks',async()=>{
  assertReference();
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-nsp-'));let comparisons=0,refusals=0;
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    const ids=[['SDA_',1],['SD_A',1],['SD_2',1],['SDAB',2]] as const;
    for(const [id,channels] of ids)for(const rate of [8000,16000,44100])for(const hdr of ['HEDR','HDR8'])for(const extra of ['plain','unknown','note'] as const){
      const name=`${id}-${rate}-${hdr}-${extra}`,frames=rate===8000?1031:4097,size=hdr==='HEDR'?32:44;
      // unknown: unskipped ids with sizes that would overrun EOF if they were skipped; note: an odd NOTE whose bytes after the first NUL are re-parsed as a chunk.
      const before=extra==='unknown'?[chunk('ABCD',0x7ffffff0),chunk('LIST',4)]:extra==='note'?[chunk('NOTE',13,[...text('nsp note'),0,...text('Q')]),chunk('JUNK',1000)]:[];
      writeFileSync(join(root,`${name}.nsp`),file(...before,hedr(hdr,rate,size),chunk(id,frames*2*channels+7),payload(frames*2*channels)));
      const outputs:Array<readonly [readonly string[],string]>=[[['-f','framecrc'],'crc'],[['-f','s16le'],'raw'],[['-ss','0.0125','-t','0.05','-f','framecrc'],'crc'],[['-t','0.0301','-f','s16le'],'raw'],[['-f','w64'],'w64'],...(extra==='note'?[]:[[['-f','wav'],'wav'],[['-f','aiff'],'aiff'],[['-f','au'],'au']] as const)];
      const nativeArgs=['-i',join(root,`${name}.nsp`)];for(const [index,[tail,extension]] of outputs.entries())nativeArgs.push(...tail,'-bitexact',join(root,`native-${name}-${index}.${extension}`));
      const reference=nativeRun(nativeArgs);expect(reference.status,`${name} ${reference.stderr}`).toBe(0);
      if(id==='SD_2')expect(reference.stderr,name).toContain('Unsupported chunk!');
      for(const [index,[tail,extension]] of outputs.entries()){
        const out=`${name}-${index}.${extension}`,result=await ffmpeg.exec(['-i',`/${name}.nsp`,...tail,'-bitexact',`/${out}`]);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out)).equals(readFileSync(join(root,`native-${name}-${index}.${extension}`))),out).toBe(true);comparisons++;
      }
      if(extra==='note'){
        // Native carries the NOTE text into WAV (LIST/INFO ICMT) and AIFF (ANNO); AU writes no Comment, but the shared policy refuses every tag-writing muxer, before output creation.
        const tagged=nativeRun(['-i',join(root,`${name}.nsp`),'-bitexact',join(root,`native-${name}.wav`),'-bitexact',join(root,`native-${name}.aiff`)]);expect(tagged.status).toBe(0);
        expect(readFileSync(join(root,`native-${name}.wav`)).includes(Buffer.from('ICMT'))).toBe(true);expect(readFileSync(join(root,`native-${name}.aiff`)).includes(Buffer.from('nsp note'))).toBe(true);
        for(const extension of ['wav','aiff','au']){
          const result=await ffmpeg.exec(['-i',`/${name}.nsp`,`/${name}.${extension}`]);
          expect([result.exitCode,result.diagnostics.at(-1)?.message],extension).toEqual([1,expect.stringMatching(/^Input metadata for the .* muxer is not implemented$/)]);expect(existsSync(join(root,`${name}.${extension}`))).toBe(false);refusals++;
        }
      }
    }
    expect([comparisons,refusals]).toEqual([4*3*2*(8+8+5),4*3*2*3]);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('refuses -c copy (native copy timestamps use 1/90000) and input -ss before any output, and matches native refusal statuses',async()=>{
  assertReference();
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-nsp-refuse-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    writeFileSync(join(root,'ok.nsp'),file(hedr('HEDR',8000,32),chunk('SDAB',0),payload(4000)));
    const copy=spawnSync(native,['-v','error','-i',join(root,'ok.nsp'),'-c:a','copy','-f','framecrc','-'],{encoding:'utf8'});expect(copy.status).toBe(0);expect(copy.stdout).toContain('#tb 0: 1/90000');
    for(const tail of [['-f','framecrc','/copy.crc'],['-f','s16le','/copy.raw'],['/copy.w64']]){
      const result=await ffmpeg.exec(['-i','/ok.nsp','-c:a','copy',...tail]);expect([result.exitCode,result.diagnostics.at(-1)?.code],tail.join(' ')).toEqual([1,'unsupported-command']);expect(result.diagnostics.at(-1)?.message).toMatch(/^NSP stream copy is not implemented/);expect(existsSync(join(root,tail.at(-1)!.slice(1)))).toBe(false);
    }
    // An audio chunk header at EOF is a zero-sample input: native prints the 1/90000 stream time base in framecrc, so the module refuses it.
    writeFileSync(join(root,'empty.nsp'),file(hedr('HDR8',16000,32),chunk('SDA_',0)));
    const empty=spawnSync(native,['-v','error','-i',join(root,'empty.nsp'),'-f','framecrc','-'],{encoding:'utf8'});expect(empty.status).toBe(0);expect(empty.stdout).toContain('#tb 0: 1/90000');
    const refusedEmpty=await ffmpeg.exec(['-i','/empty.nsp','-f','framecrc','/empty.crc']);expect([refusedEmpty.exitCode,refusedEmpty.diagnostics.at(-1)?.message]).toEqual([1,'Empty NSP audio data is not implemented']);expect(existsSync(join(root,'empty.crc'))).toBe(false);
    const seek=await ffmpeg.exec(['-ss','0.01','-i','/ok.nsp','-f','framecrc','/seek.crc']);expect([seek.exitCode,seek.diagnostics.at(-1)?.message]).toEqual([1,'NSP input seek is not implemented']);expect(existsSync(join(root,'seek.crc'))).toBe(false);
    // Native exit statuses: AVERROR(EINVAL) is host-specific for native (256 - EINVAL) and the Linux value 234 for EdgeFFmpeg; INVALIDDATA is 183 everywhere.
    const einval=256-constants.errno.EINVAL;
    const cases:Array<[string,Uint8Array,number,number|null]>=[
      ['nodata',file(hedr('HEDR',8000,32),chunk('ABCD',8),text('EFGH')),einval,234],['bare',Uint8Array.from(text('FORMDS16')),einval,234],
      ['noteeof',file(hedr('HEDR',8000,32),chunk('NOTE',64,text('no terminator'))),einval,234],
      ['rate0',file(chunk('SDA_',0),payload(400)),einval,234],['ratenegative',file(hedr('HDR8',0x80000000,32),chunk('SDA_',0),payload(400)),einval,234],
      ['shorthedr',file(hedr('HEDR',8000,31),chunk('SDA_',0),payload(400)),183,183],
      // Native decodes a trailing odd byte as a short final packet with exit 0; the module refuses it explicitly.
      ['partial',file(hedr('HEDR',8000,32),chunk('SDA_',0),payload(401)),0,null]
    ];
    for(const [name,bytes,nativeStatus,status] of cases)for(const declare of [false,true]){
      writeFileSync(join(root,`${name}.nsp`),bytes);const before=declare?['-f','nsp']:[];
      const reference=nativeRun([...before,'-i',join(root,`${name}.nsp`),'-f','framecrc',join(root,`${name}-native.crc`)]);expect(reference.status,`${name} ${reference.stderr}`).toBe(nativeStatus);
      const result=await ffmpeg.exec([...before,'-i',`/${name}.nsp`,'-f','framecrc',`/${name}-${declare}.crc`]);
      if(status===null)expect(result.exitCode,name).not.toBe(0);else expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(status);
      expect(existsSync(join(root,`${name}-${declare}.crc`)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
