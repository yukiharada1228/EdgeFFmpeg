import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),metadata=resolve('.build/reference/build-metadata.json');
// libavformat/genh.c layout: 'GENH', rl32 channels, interleave, rate, (skipped), duration, codec, start_offset, header_size, then six rl32 to byte 60.
interface Genh {channels:number;interleave:number;rate:number;codec?:number;start?:number;headerSize?:number;duration?:number;payload:number;seed?:number;fileStart?:number}
function genh({channels,interleave,rate,codec=13,start=60,headerSize=start,duration=0,payload,seed=1,fileStart}:Genh):Uint8Array{
  // The data starts at start_offset, or 0x800 when header_size is 0; fileStart overrides it for headers whose data native never reaches.
  // payload counts the data bytes from that offset; a start inside the header keeps the header and its bytes join the data, as avio_skip seeks back.
  const offset=fileStart??(headerSize?start:0x800),bytes=new Uint8Array(Math.max(offset+payload,60)),view=new DataView(bytes.buffer);
  for(let i=Math.max(offset,60);i<bytes.length;i++)bytes[i]=(i*(37+seed)+11*seed+(i>>7))&255;
  bytes.set([0x47,0x45,0x4e,0x48]);for(const [index,value] of [channels,interleave,rate,0xdeadbeef,duration,codec,start,headerSize,1,2,3,4,5,6].entries())view.setUint32(4+index*4,value>>>0,true);
  return bytes;
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}})};}
const run=(args:string[])=>spawnSync(native,['-nostdin','-v','error',...args],{maxBuffer:1<<26});
// Refusals tied to errno: the host value for native, the Linux value for EdgeFFmpeg (234 = AVERROR(EINVAL) & 255).
const nativeEinval=(256-constants.errno.EINVAL)&255;
it('uses the sandbox reference built from FFmpeg 946fcce0 without x86 assembly',()=>{
  const build=JSON.parse(readFileSync(metadata,'utf8'));expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');
});
it('matches native GENH pcm_u8 copy and decode framecrc, WAV and raw u8 for channels interleaves rates and start rules',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-genh-');let compared=0;
  try{
    // [start, header_size]: the header, 0x800 for header_size 0, data before the header end (avio_skip seeks back) and a padded start.
    const starts=[[60,60],[0,0],[16,16],[100,40]] as const;let index=0;
    for(const channels of [1,2,5])for(const interleave of [1,100,4096])for(const rate of [8000,11025]){
      const [start,headerSize]=starts[index%4]!,packets=interleave===1?2205:interleave===100?23:3,samples=packets*interleave,name=`${channels}-${interleave}-${rate}`,path=join(root,`${name}.genh`);
      writeFileSync(path,genh({channels,interleave,rate,start,headerSize,duration:index%3?samples:12345,payload:samples*channels,seed:index++}));
      const layout=channels===1?'mono':channels===2?'stereo':'5.0';
      for(const declared of [[],['-f','genh']]){
        const copy=run([...declared,'-i',path,'-c:a','copy','-bitexact','-f','framecrc','-']);expect(copy.status,name).toBe(0);
        const header=copy.stdout.toString();
        if(!header.includes('#codec_id 0: pcm_u8\n')||!header.includes(`#sample_rate 0: ${rate}\n`)||!header.includes(`#channel_layout_name 0: ${layout}\n`))throw new Error(`native did not demux ${name} as GENH: ${header.slice(0,300)}`);
        expect(header).not.toContain('F=0x');expect(header.trimEnd().split('\n').filter(line=>!line.startsWith('#')).length,name).toBe(packets);
        const outputs:Array<[string,string[]]>=[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['decode.crc',['-bitexact','-f','framecrc']]];
        if(!declared.length)outputs.push(['wav',['-bitexact','-f','wav']],['u8',['-f','u8']],['s16.crc',['-c:a','pcm_s16le','-bitexact','-f','framecrc']]);
        for(const [suffix,tail] of outputs){
          const expected=suffix==='copy.crc'?copy:suffix==='wav'?run([...declared,'-i',path,...tail,'-y',join(root,`${name}-native.wav`)]):run([...declared,'-i',path,...tail,'-']);expect(expected.status,`${name}/${suffix}`).toBe(0);
          const want=suffix==='wav'?readFileSync(join(root,`${name}-native.wav`)):expected.stdout;
          const out=`/${name}-${declared.length}.${suffix}`,result=await ffmpeg.exec([...declared,'-i',`/${name}.genh`,...tail,out]);
          expect(result.exitCode,`${name}/${suffix} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(want),`${name}/${suffix}/${declared.length}`).toBe(true);compared++;
        }
      }
    }
    expect(compared).toBe(126);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native GENH output -ss, -t and -frames selections for copy and decode',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-genh-time-');let compared=0;
  try{
    for(const [channels,interleave,rate] of [[1,100,8000],[2,1,11025],[5,4096,8000],[2,333,11025]] as const){
      const name=`${channels}-${interleave}`,path=join(root,`${name}.genh`),samples=interleave===4096?4*4096:interleave===1?2205:interleave*30;
      writeFileSync(path,genh({channels,interleave,rate,payload:samples*channels,seed:interleave}));
      const profiles=[['-ss','0.01','-t','0.1'],['-t','0.0333'],['-ss','0.3'],['-frames:a','2'],['-ss','0.0125','-frames:a','3']];
      for(const [index,profile] of profiles.entries())for(const copy of [true,false]){
        const tail=[...profile,...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=run(['-i',path,...tail,'-']);expect(expected.status).toBe(0);
        const out=`/${name}-${index}-${copy}.crc`,timed=await ffmpeg.exec(['-i',`/${name}.genh`,...tail,out]);expect(timed.exitCode,JSON.stringify(timed.diagnostics)).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${index}/${copy}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(40);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('decodes a short final GENH packet as native does and refuses its stream copy before any output',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-genh-tail-');let compared=0;
  try{
    for(const [channels,interleave,samples] of [[1,100,250],[2,100,1021],[5,4096,5000],[2,7,99]] as const){
      const name=`${channels}-${interleave}-${samples}`,path=join(root,`${name}.genh`);writeFileSync(path,genh({channels,interleave,rate:8000,payload:samples*channels,seed:samples}));
      // Native flags the short final packet KEY|CORRUPT, which copy framecrc prints; whole packets carry no flag column.
      const copy=run(['-i',path,'-c:a','copy','-bitexact','-f','framecrc','-']);expect(copy.status).toBe(0);const rows=copy.stdout.toString().trimEnd().split('\n');
      expect(rows.at(-1),name).toMatch(/, F=0x3$/);expect(rows.filter(row=>row.includes('F=0x')).length).toBe(1);
      for(const [suffix,tail] of [['crc',['-bitexact','-f','framecrc']],['s16',['-f','s16le']],['u8',['-f','u8']]] as const){
        const expected=run(['-i',path,...tail,'-']);expect(expected.status).toBe(0);
        const out=`/${name}.${suffix}`,result=await ffmpeg.exec(['-i',`/${name}.genh`,...tail,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${suffix}`).toBe(true);compared++;
      }
      for(const output of [['-f','framecrc','copy.crc'],['-f','u8','copy.u8'],['copy.wav']]){
        const file=`${name}-${output.at(-1)}`,result=await ffmpeg.exec(['-i',`/${name}.genh`,'-c:a','copy',...output.slice(0,-1),`/${file}`]);
        expect([result.exitCode,result.diagnostics.at(-1)?.code,result.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','GENH stream copy of a short final packet is not implemented']);expect(existsSync(join(root,file))).toBe(false);
      }
    }
    expect(compared).toBe(12);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses invalid GENH headers with native exit statuses before any output',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-genh-refuse-');
  try{
    const base={channels:2,interleave:100,rate:8000,payload:800};
    // [label, header, native status, Edge status, probe matches]: 183 AVERROR_INVALIDDATA, 176 AVERROR_PATCHWELCOME, EINVAL from the pcm_u8 decoder for rate 0.
    const cases:Array<[string,Genh,number,number,boolean]>=[
      ['channels0',{...base,channels:0},183,183,false],['channelsNegative',{...base,channels:0x80000000},183,183,false],
      ['interleave0',{...base,interleave:0},183,183,true],['interleaveNegative',{...base,interleave:0x80000000},183,183,true],['interleaveOverflow',{...base,channels:3,interleave:0x2aaaaaab},183,183,true],
      ['rateNegative',{...base,rate:0x80000000},183,183,true],['rate0',{...base,rate:0},nativeEinval,234,true],
      ['codec8',{...base,codec:8},176,176,true],['codec9999',{...base,codec:9999},176,176,true],['codecImaOverflow',{...base,channels:60000000,codec:1,interleave:0,fileStart:60},183,183,false],
      ['codecSdx2Overflow',{...base,channels:1,interleave:3000000,codec:6},183,183,true],
      ['headerSize',{...base,start:60,headerSize:61,fileStart:60},183,183,true],['headerSizeOrder',{...base,codec:4,start:60,headerSize:64,fileStart:60},183,183,true],['codec4interleave0',{...base,codec:4,interleave:0},183,183,true]
    ];
    for(const [label,header,status,edge,probed] of cases){
      writeFileSync(join(root,`${label}.genh`),genh(header));
      for(const declared of probed?[[],['-f','genh']]:[['-f','genh']])for(const copy of [[],['-c:a','copy']]){
        const expected=run([...declared,'-i',join(root,`${label}.genh`),...copy,'-f','u8','-']);expect(expected.status,`${label}/${declared.length}/${copy.length}`).toBe(status);
        const result=await ffmpeg.exec([...declared,'-i',`/${label}.genh`,...copy,'-f','u8',`/${label}.raw`]);expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(edge);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses GENH inputs native accepts but the port does not mirror before any output',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-genh-unported-');
  try{
    const base={channels:2,interleave:100,rate:8000,payload:800};
    // [label, header, native status for decode, native status for copy, input args, message]. Native decodes codec 4 as pcm_s16le_planar and copies ADPCM PSX
    // (its decoder needs a channel layout: AVERROR_INVALIDDATA); it skips past EOF without moving (data from byte 60) and accepts a partial frame.
    const cases:Array<[string,Genh,number,number,string[],RegExp]>=[
      ['codec4planar',{...base,codec:4},0,0,[],/codec 4 \(pcm_s16le_planar\)/],['codec3planar',{...base,codec:3},0,0,[],/codec 3 \(pcm_s16be_planar\)/],['codec5planar',{...base,codec:5},0,0,[],/codec 5 \(pcm_s8_planar\)/],
      ['codec0',{...base,codec:0},183,0,[],/codec 0 \(adpcm_psx\)/],['codec12',{...base,codec:12},0,0,['-f','genh'],/codec 12/],
      ['startBeyondEof',{...base,start:0,headerSize:0,fileStart:60},0,0,[],/without payload/],['partial',{...base,payload:801},0,0,[],/partial trailing/],['seek',base,0,0,['-ss','0.01'],/seeking/]
    ];
    for(const [label,header,decodeStatus,copyStatus,input,message] of cases){
      writeFileSync(join(root,`${label}.genh`),genh(header));
      for(const [copy,status] of [[[],decodeStatus],[['-c:a','copy'],copyStatus]] as const){
        if(label!=='codec12'){const expected=run([...input,'-i',join(root,`${label}.genh`),...copy,'-f','framecrc','-']);expect(expected.status,`${label}/${copy.length}`).toBe(status);}
        const result=await ffmpeg.exec([...input,'-i',`/${label}.genh`,...copy,'-f','framecrc',`/${label}.crc`]);expect(result.exitCode,label).not.toBe(0);
        expect(JSON.stringify(result.diagnostics),label).toMatch(message);expect(existsSync(join(root,`${label}.crc`))).toBe(false);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
