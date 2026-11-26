import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** The reference is built at test time from the pinned commit; its binary digest is never pinned. */
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
/** AVERROR(ENOSYS) exits with (-ENOSYS) & 255: 218 on Linux, 178 on macOS. EdgeFFmpeg always uses the Linux value. */
const hostEnosys=(256-constants.errno.ENOSYS)&255,linuxEnosys=218,linuxStatus=(status:number|null)=>status===hostEnosys?linuxEnosys:status;
const codecs=['pcm_u8','pcm_s16le','pcm_alaw','pcm_mulaw'] as const;
const raw:Record<string,string>={pcm_u8:'u8',pcm_s16le:'s16le',pcm_alaw:'alaw',pcm_mulaw:'mulaw'},width:Record<string,number>={pcm_u8:1,pcm_s16le:2,pcm_alaw:1,pcm_mulaw:1};
const tags:Record<string,number>={pcm_u8:0,pcm_s16le:4,pcm_alaw:6,pcm_mulaw:7};
function checkReference(){expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');}
function source(samples:number,channels:number){const data=new Uint8Array(samples*channels*2),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,((i*3137+(i>>5)*911)%65536)-32768,true);return data;}
function payload(bytes:number,seed=0){const data=new Uint8Array(bytes);for(let i=0;i<bytes;i++)data[i]=(i*151+(i>>3)*17+seed)&255;return data;}
const header=(version=0x0114,check=(~version+0x1234)&0xffff,size=26)=>{const b=new Uint8Array(26),v=new DataView(b.buffer);b.set(new TextEncoder().encode('Creative Voice File\x1a'));v.setUint16(20,size,true);v.setUint16(22,version,true);v.setUint16(24,check,true);return b;};
const block=(type:number,body:Uint8Array)=>{const b=new Uint8Array(4+body.length);b[0]=type;b[1]=body.length&255;b[2]=body.length>>8&255;b[3]=body.length>>16;b.set(body,4);return b;};
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const type1=(tc:number,tag:number,data:Uint8Array)=>block(1,concat(Uint8Array.of(tc,tag),data));
const type9=(rate:number,bits:number,channels:number,tag:number,data:Uint8Array)=>{const h=new Uint8Array(12),v=new DataView(h.buffer);v.setUint32(0,rate,true);h[4]=bits;h[5]=channels;v.setUint16(6,tag,true);return block(9,concat(h,data));};
const type8=(rate:number,tag:number,channels:number)=>block(8,Uint8Array.of(rate&255,rate>>8,tag,channels-1));
async function harness(prefix:string){
  checkReference();
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536});
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:20000}});
  return {root,ffmpeg};
}
/** Runs one command on both sides: native writes to <name>-native.<ext>, Edge to <name>.<ext>; the files must be identical. */
async function same(root:string,ffmpeg:FFmpeg,before:string[],input:string,after:string[],name:string){
  execFileSync(native,['-v','error','-y',...before,'-i',join(root,input),...after,join(root,name.replace(/(\.[a-z0-9]+)$/,'-native$1'))]);
  const result=await ffmpeg.exec([...before,'-i',`/${input}`,...after,`/${name}`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
  const actual=readFileSync(join(root,name)),expected=readFileSync(join(root,name.replace(/(\.[a-z0-9]+)$/,'-native$1')));
  expect(actual.equals(expected),name).toBe(true);return expected;
}
it('matches native VOC mux bytes from WAV and raw input for 4 codecs x 2 layouts with copy, re-encode, packet regrouping and output time limits',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-voc-mux-');let compared=0;
  try{
    for(const channels of [1,2])for(const samples of [1,777,5000]){
      writeFileSync(join(root,'in.raw'),source(samples,channels));const declared=['-f','s16le','-ar','8000','-ac',String(channels)];
      execFileSync(native,['-v','error','-y',...declared,'-i',join(root,'in.raw'),'-bitexact',join(root,'in.wav')]);
      for(const codec of codecs){
        const tag=`${codec}-${channels}-${samples}`,wav=`${tag}.wav`;
        execFileSync(native,['-v','error','-y','-i',join(root,'in.wav'),'-c:a',codec,'-bitexact',join(root,wav)]);
        await same(root,ffmpeg,[],wav,['-c:a','copy'],`${tag}-copy.voc`);
        const encoded=await same(root,ffmpeg,[],'in.wav',['-c:a',codec],`${tag}-enc.voc`);
        await same(root,ffmpeg,declared,'in.raw',['-c:a',codec,'-f','voc'],`${tag}-raw.voc`);
        compared+=3;
        if(samples!==5000)continue;
        // asetnsamples regroups packets, so the voc block sizes (and bytes) follow the filter's frames.
        const regrouped=await same(root,ffmpeg,[],'in.wav',['-af','asetnsamples=n=700:p=0','-c:a',codec],`${tag}-n700.voc`);
        expect(regrouped.equals(encoded)).toBe(false);expect(regrouped[26+(codec==='pcm_u8'?(channels>1?8:0):0)]).toBe(codec==='pcm_u8'?1:9);
        await same(root,ffmpeg,[],'in.wav',['-af','apad=pad_len=333','-c:a',codec],`${tag}-apad.voc`);
        await same(root,ffmpeg,[],'in.wav',['-af','asetnsamples=n=300:p=0,apad=whole_len=6100','-c:a',codec],`${tag}-chain.voc`);
        await same(root,ffmpeg,[],'in.wav',['-ss','0.05','-t','0.3','-c:a',codec],`${tag}-sst.voc`);
        await same(root,ffmpeg,[],wav,['-frames:a','2','-c:a','copy'],`${tag}-frames.voc`);
        await same(root,ffmpeg,[],wav,['-t','0.2','-c:a','copy'],`${tag}-t.voc`);
        compared+=6;
      }
    }
    // Rates where the u8 time constant and the type-8 rate word round or wrap.
    for(const rate of [3000,11025,22050,44100,48000])for(const channels of [1,2,3]){
      writeFileSync(join(root,'r.raw'),source(300,channels));
      for(const codec of codecs){await same(root,ffmpeg,['-f','s16le','-ar',String(rate),'-ac',String(channels)],'r.raw',['-c:a',codec],`rate-${rate}-${channels}-${codec}.voc`);compared++;}
    }
    expect(compared).toBe(2*3*4*3+2*4*6+5*3*4);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native VOC demux of native-muxed and hand-built files through copy and decoded framecrc, WAV and raw',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-voc-demux-');let compared=0;
  try{
    const files:Array<[string,Uint8Array,string]>=[];
    for(const channels of [1,2])for(const codec of codecs){
      writeFileSync(join(root,'in.raw'),source(3001,channels));
      execFileSync(native,['-v','error','-y','-f','s16le','-ar','11025','-ac',String(channels),'-i',join(root,'in.raw'),'-c:a',codec,join(root,`native-${codec}-${channels}.voc`)]);
      files.push([`native-${codec}-${channels}.voc`,readFileSync(join(root,`native-${codec}-${channels}.voc`)),codec]);
      // From WAV, native writes 4096-byte blocks that demux as 2048-byte packets.
      execFileSync(native,['-v','error','-y','-f','s16le','-ar','44100','-ac',String(channels),'-i',join(root,'in.raw'),'-c:a',codec,'-bitexact',join(root,'src.wav')]);
      execFileSync(native,['-v','error','-y','-i',join(root,'src.wav'),'-c:a','copy',join(root,`wav-${codec}-${channels}.voc`)]);
      files.push([`wav-${codec}-${channels}.voc`,readFileSync(join(root,`wav-${codec}-${channels}.voc`)),codec]);
    }
    for(const codec of codecs)for(const channels of [1,2,3]){
      const align=width[codec]!*channels,data=(blocks:number[])=>blocks.map((bytes,index)=>payload(bytes*align,index));
      const [first,...rest]=data([300,300,300,200]);
      files.push([`t9-${codec}-${channels}.voc`,concat(header(),type9(16000,width[codec]!*8,channels,tags[codec]!,first!),...rest.map(part=>block(2,part)),Uint8Array.of(0)),codec]);
      const [big,...tail]=[4096,4096,5000].map((bytes,index)=>payload(bytes,index));
      if(2048%align===0)files.push([`t9big-${codec}-${channels}.voc`,concat(header(),type9(22050,width[codec]!*8,channels,tags[codec]!,big!),...tail.map(part=>block(2,part))),codec]);
      if(channels===1)files.push([`t1-${codec}.voc`,concat(header(),type1(0x83,tags[codec]!,payload(2500))),codec]);
      if(channels===2)files.push([`t8-${codec}.voc`,concat(header(),type8(65536-Math.floor(256000000/(2*11025)),0,2),type1(0xa5,tags[codec]!,payload(500*align)),block(2,payload(500*align,3)),block(2,payload(10*align,5)),Uint8Array.of(0,9,9,9)),codec]);
    }
    // A failed version check still demuxes with -f voc; a type-8 rate word of 0 gives 256000000/(2*65536) Hz.
    files.push(['version.voc',concat(header(0x0114,0),type1(0x9c,0,payload(900))),'pcm_u8'],['t8zero.voc',concat(header(),type8(0,0,2),type1(0x9c,0,payload(900))),'pcm_u8'],['t9u8.voc',concat(header(),type9(9000,8,1,0,payload(5000))),'pcm_u8']);
    for(const [name,bytes,codec]of files){
      writeFileSync(join(root,name),bytes);const force=name==='version.voc'?['-f','voc']:[];
      // A type-1 block leaves bits_per_coded_sample 0, which a VOC muxer would copy into a type-9 header: copy is refused for non-u8 type-1 input.
      const copyable=!/^t[18]-pcm_(s16le|alaw|mulaw)/.test(name);
      if(copyable){
        await same(root,ffmpeg,force,name,['-c:a','copy','-f','framecrc'],`${name}.copy.crc`);
        await same(root,ffmpeg,force,name,['-c:a','copy','-f',raw[codec]!],`${name}.raw`);
        await same(root,ffmpeg,force,name,['-c:a','copy'],`${name}.copy.voc`);
        compared+=3;
      }else{
        const result=await ffmpeg.exec([...force,'-i',`/${name}`,'-c:a','copy','-f','framecrc',`/${name}.copy.crc`]);expect(result.exitCode,name).not.toBe(0);expect(existsSync(join(root,`${name}.copy.crc`))).toBe(false);
      }
      await same(root,ffmpeg,force,name,['-c:a','pcm_s16le','-f','framecrc'],`${name}.dec.crc`);
      await same(root,ffmpeg,force,name,['-bitexact'],`${name}.wav`);
      await same(root,ffmpeg,force,name,['-af','asetnsamples=n=500:p=0','-c:a','pcm_s16le','-t','0.1','-f','framecrc'],`${name}.cut.crc`);
      compared+=3;
    }
    expect(compared).toBe(264);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses VOC inputs and outputs with the native exit status before any output exists',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-voc-refusal-');
  try{
    for(const size of [0,22,25,27,0x1a00]){
      const name=`size-${size}.voc`;writeFileSync(join(root,name),concat(header(0x0114,undefined,size),type1(0x83,0,payload(100))));
      const expected=spawnSync(native,['-v','error','-f','voc','-i',join(root,name),'-f','framecrc','-']),result=await ffmpeg.exec(['-f','voc','-i',`/${name}`,'-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).toBe(hostEnosys);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(linuxStatus(expected.status));expect(existsSync(join(root,`${name}.crc`))).toBe(false);
    }
    // Native accepts these; Edge refuses them before any output: input -ss (voc_read_seek index) and undeclared score-10 files.
    writeFileSync(join(root,'seek.voc'),concat(header(),type1(0x83,0,payload(4000))));writeFileSync(join(root,'score10.voc'),concat(header(0x0114,0),type1(0x83,0,payload(4000))));
    expect(spawnSync(native,['-v','error','-ss','0.1','-i',join(root,'seek.voc'),'-f','framecrc','-']).status).toBe(0);expect(spawnSync(native,['-v','error','-i',join(root,'score10.voc'),'-f','framecrc','-']).status).toBe(0);
    for(const args of [['-ss','0.1','-i','/seek.voc'],['-i','/score10.voc']]){const result=await ffmpeg.exec([...args,'-f','framecrc','/edge-only.crc']);expect(result.exitCode,args.join(' ')).toBe(1);expect(existsSync(join(root,'edge-only.crc'))).toBe(false);}
    writeFileSync(join(root,'in.raw'),source(100,1));
    for(const codec of ['pcm_s24le','pcm_s8','pcm_s16be','pcm_f32le','pcm_u16le']){
      const args=['-f','s16le','-ar','8000','-ac','1','-i'],tail=['-c:a',codec,'-f','voc'];
      const expected=spawnSync(native,['-v','error','-y',...args,join(root,'in.raw'),...tail,join(root,`${codec}-native.voc`)]),result=await ffmpeg.exec([...args,'/in.raw',...tail,`/${codec}.voc`]);
      expect(expected.status,codec).toBe(234);expect(result.exitCode,codec).toBe(234);expect(result.diagnostics.at(-1)?.message).toBe('unsupported codec');expect(existsSync(join(root,`${codec}.voc`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
