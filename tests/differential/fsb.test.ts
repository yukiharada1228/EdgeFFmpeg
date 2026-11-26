import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** The sandbox-built reference at test time: commit 946fcce0 without x86 assembly; its binary hash is never pinned. */
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
interface Fields {version?:string;count?:number;dataOffset?:number;duration?:number;format?:number;rate?:number;channels?:number}
/** libavformat/fsb.c version 3 layout: "FSB3", RL32@4 sample count (probe: 1), RL32@8 + 0x18 data offset, RL32@56 duration, RL32@72 format, RL32@76 rate, RL16@86 channels.
 * The header bytes in between are filled, and data runs from the absolute offset (possibly inside the 88-byte header) to EOF. */
function fsb(fields:Fields,payload:number,seed=1):Uint8Array{
  const {version='3',count=1,dataOffset=0x100,duration=4321,format=0x100,rate=22050,channels=2}=fields,start=Math.max(dataOffset,88),bytes=new Uint8Array(start+payload-(dataOffset<88?88-dataOffset:0)),view=new DataView(bytes.buffer);
  for(let i=8;i<start;i++)bytes[i]=(i*37+seed)&255;
  bytes.set([0x46,0x53,0x42,version.charCodeAt(0)]);view.setUint32(4,count,true);view.setUint32(8,dataOffset-0x18,true);view.setUint32(56,duration,true);view.setUint32(72,format,true);view.setInt32(76,rate,true);view.setUint16(86,channels,true);
  let x=seed*2654435761>>>0;for(let i=start;i<bytes.length;i++){x=(x*1103515245+12345)>>>0;bytes[i]=i%97<48?x>>>24:(i*13)&255;}
  return bytes;
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}})};}
const run=(args:string[])=>spawnSync(native,['-v','error',...args],{maxBuffer:1<<26});
const copyRefusal='FSB stream copy of a short final packet (flagged corrupt natively) is not implemented';
it('matches native FSB3 copy and decode framecrc, wav and raw outputs for 1/2/4 channels, three rates, data offsets and short tails',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-fsb-');let compared=0,refused=0;
  try{
    for(const channels of [1,2,4])for(const rate of [22050,24000,44100])for(const [layout,dataOffset,frames] of [['whole',0x100,3*2048],['short',0x100,2*2048+7],['offset88',88,4096],['backward',0x40,2048]] as const){
      // Data at 0x40 starts 24 bytes inside the 88-byte header (avio_skip seeks backwards), so those header bytes are the first samples; 88 starts right after it.
      const blockAlign=2*channels,payload=frames*blockAlign,name=`${channels}-${rate}-${layout}`,path=join(root,`${name}.fsb`),whole=layout!=='short';
      writeFileSync(path,fsb({dataOffset,rate,channels,duration:frames*3+rate,format:layout==='offset88'?0x00400100:0x100},payload,rate+channels*7));
      const cases:Array<[string,string[],string[]]>=[
        ['copy',[],['-c:a','copy','-bitexact','-f','framecrc']],['copy-f',['-f','fsb'],['-c:a','copy','-bitexact','-f','framecrc']],['decode',[],['-c:a','pcm_s16le','-bitexact','-f','framecrc']],
        ['wav',[],['-bitexact','-f','wav']],['raw-copy',['-f','fsb'],['-c:a','copy','-f','s16le']],['raw',[],['-f','s16le']]];
      for(const [kind,declared,tail] of cases){
        const nativeOut=join(root,`${name}-${kind}.native`),expected=run([...declared,'-i',path,...tail,nativeOut]);expect(expected.status,`${name}/${kind}`).toBe(0);
        if(kind.startsWith('copy')){
          // Claim detection only where native's framecrc header shows the FSB stream; the short final packet is flagged corrupt (F=0x3) unless the payload is whole packets.
          const text=readFileSync(nativeOut,'utf8'),rows=text.split('\n').filter(line=>/^0,/.test(line));
          if(!text.includes('#codec_id 0: pcm_s16le\n')||!text.includes(`#sample_rate 0: ${rate}\n`))throw new Error(`native did not demux ${name} as FSB: ${text.slice(0,300)}`);
          expect(rows.slice(0,-1).every(row=>/, +2048, +\d+, 0x[0-9a-f]{8}$/.test(row)),name).toBe(true);expect(rows.at(-1)!.endsWith(', F=0x3'),name).toBe(!whole);
        }
        const out=`/${name}-${kind}.out`,result=await ffmpeg.exec([...declared,'-i',`/${name}.fsb`,...tail,out]);
        if(!whole&&(kind==='copy'||kind==='copy-f'||kind==='raw-copy')){
          expect([result.exitCode,result.diagnostics.at(-1)?.message],`${name}/${kind}`).toEqual([1,copyRefusal]);expect(existsSync(join(root,out.slice(1)))).toBe(false);refused++;continue;
        }
        expect(result.exitCode,`${name}/${kind} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(nativeOut)),`${name}/${kind}`).toBe(true);compared++;
      }
    }
    expect([compared,refused]).toEqual([189,27]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native FSB3 output -ss, -t and -frames selections for copy and decode',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-fsb-time-');let compared=0;
  try{
    for(const channels of [1,2,4])for(const rate of [22050,44100])for(const short of [false,true]){
      const frames=short?5*2048+301:6*2048,name=`${channels}-${rate}-${short}`,path=join(root,`${name}.fsb`);writeFileSync(path,fsb({rate,channels},frames*2*channels,rate+channels));
      const profiles=[['-ss','0.05'],['-t','0.3'],['-ss','0.13','-t','0.21'],['-ss','0.2','-t','0.05'],['-frames:a','2'],['-ss','10']];
      for(const [index,profile] of profiles.entries())for(const copy of short?[false]:[true,false]){
        const tail=[...profile,...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=run(['-i',path,...tail,'-']);expect(expected.status).toBe(0);
        const out=`/${name}-${index}-${copy}.crc`,timed=await ffmpeg.exec(['-i',`/${name}.fsb`,...tail,out]);expect(timed.exitCode,`${name}/${index}/${copy} ${JSON.stringify(timed.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${index}/${copy}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(108);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('mirrors native FSB version, format, rate and channel statuses and refuses FSB4, ADPCM, partial samples, truncation and input seeks before any output',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-fsb-refuse-');
  try{
    // AVERROR_PATCHWELCOME (176) and AVERROR_INVALIDDATA (183) are FFERRTAG values, so the statuses are host-independent.
    const mirrored:Array<[string,Uint8Array,string[],number]>=[
      ['fsb1',fsb({version:'1'},4096),[],176],['fsb5',fsb({version:'5'},4096),['-f','fsb'],176],['fsbx',fsb({version:'X'},4096),['-f','fsb'],176],
      ['format-none',fsb({format:0x1},4096),[],176],['format-zero',fsb({format:0},4096),['-f','fsb'],176],
      ['rate0',fsb({rate:0},4096),[],183],['rate-negative',fsb({rate:-22050},4096),['-f','fsb'],183],['channels0',fsb({channels:0},4096),[],183],
      // avio reads zeros past EOF, so a header cut before the channel count is INVALIDDATA.
      ['truncated',fsb({},0).subarray(0,60),[],183]];
    for(const [label,bytes,declared,status] of mirrored){
      writeFileSync(join(root,`${label}.fsb`),bytes);
      for(const tail of [['-f','s16le'],['-c:a','copy','-f','framecrc']]){
        const expected=run([...declared,'-i',join(root,`${label}.fsb`),...tail,'-']);expect(expected.status,label).toBe(status);
        const result=await ffmpeg.exec([...declared,'-i',`/${label}.fsb`,...tail,`/${label}.out`]);expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(status);expect(existsSync(join(root,`${label}.out`))).toBe(false);
      }
    }
    // FSB4 XMA2 (format RB32@96), the three ADPCM flags, a 1-byte partial sample, 513 channels, an offset past EOF, an 87-byte header and an input seek are accepted by native copy; the port refuses them explicitly.
    const fsb4=fsb({version:'4'},4096);new DataView(fsb4.buffer).setUint32(96,0x40001001,false);new DataView(fsb4.buffer).setUint32(100,22050,true);new DataView(fsb4.buffer).setUint16(110,2,true);
    const short=fsb({channels:1},0).subarray(0,87);short[86]=1;
    const unported:Array<[string,Uint8Array,string[],RegExp]>=[
      ['fsb4',fsb4,[],/FSB4/],['ima',fsb({format:0x00400000},4096),[],/adpcm_ima_wav/],['psx',fsb({format:0x00800000},4096),[],/adpcm_psx/],['thp',fsb({format:0x02000000},4096),['-f','fsb'],/adpcm_thp/],
      ['partial',fsb({},4097),[],/partial trailing/],['channels513',fsb({channels:513},513*2*10),[],/channel count/],['past',fsb({dataOffset:0x10000},0).subarray(0,300),[],/beyond the end/],
      ['short',short,['-f','fsb'],/Truncated FSB header/],['seek',fsb({},8192),['-ss','0.01'],/FSB input seeking/]];
    for(const [label,bytes,before,message] of unported){
      writeFileSync(join(root,`${label}.fsb`),bytes);
      expect(run([...before,'-i',join(root,`${label}.fsb`),'-c:a','copy','-f','framecrc','-']).status,label).toBe(0);
      const result=await ffmpeg.exec([...before,'-i',`/${label}.fsb`,'-f','s16le',`/${label}.raw`]);expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toMatch(message);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
