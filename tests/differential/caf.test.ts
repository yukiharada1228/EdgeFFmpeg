import {expect,it} from 'vitest';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),run=promisify(execFile);
/** Native at test time: any local build of the pinned commit without x86 assembly; the binary itself is never pinned. */
function assertReference(){
  const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
const codecs=['pcm_s8','pcm_s16le','pcm_s16be','pcm_s24le','pcm_s24be','pcm_s32le','pcm_s32be','pcm_f32le','pcm_f32be','pcm_f64le','pcm_f64be','pcm_alaw','pcm_mulaw'];
const raw:Record<string,[string,number]>={pcm_s8:['s8',1],pcm_s16le:['s16le',2],pcm_s16be:['s16be',2],pcm_s24le:['s24le',3],pcm_s24be:['s24be',3],pcm_s32le:['s32le',4],pcm_s32be:['s32be',4],
  pcm_f32le:['f32le',4],pcm_f32be:['f32be',4],pcm_f64le:['f64le',8],pcm_f64be:['f64be',8],pcm_alaw:['alaw',1],pcm_mulaw:['mulaw',1]};
/** The PCM path's 12 named masks plus masks it carries unnamed (bitmap fallback, or mov_channel_layout rows without a PCM-path name). */
const masks:Array<[string,number]>=[['mono',0x4],['stereo',0x3],['2.1',0xb],['3.0',0x7],['4.0',0x107],['quad',0x33],['5.0',0x37],['5.1',0x3f],['5.0(side)',0x607],['5.1(side)',0x60f],['6.1',0x70f],['7.1',0x63f],
  ['2_1',0x103],['2_2',0x603],['7.1(wide)',0x6cf],['dvd5',0x10b],['dvd6',0x3b],['3.1',0xf],['4.1',0x10f],['fl+fr+bl',0x13],['fc+lfe',0xc]];
const popcount=(value:number)=>value.toString(2).replaceAll('0','').length;
function samples(bytes:number,width:number,codec:string){
  const data=new Uint8Array(bytes),view=new DataView(data.buffer);for(let i=0;i<bytes;i++)data[i]=(i*151+(i>>3)*17)&255;
  // Finite float payloads: copy never decodes them, but keep inputs ordinary.
  if(codec.startsWith('pcm_f'))for(let i=0;i+width<=bytes;i+=width){const value=Math.sin(i*0.37)*0.9;if(width===4)view.setFloat32(i,value,codec.endsWith('le'));else view.setFloat64(i,value,codec.endsWith('le'));}
  return data;
}
/** WAVE_FORMAT_EXTENSIBLE s16le with an explicit dwChannelMask. */
function wav(channels:number,rate:number,mask:number,payload:Uint8Array){
  const bytes=new Uint8Array(68+payload.length),view=new DataView(bytes.buffer),tag=(offset:number,text:string)=>{for(let i=0;i<4;i++)bytes[offset+i]=text.charCodeAt(i);};
  tag(0,'RIFF');view.setUint32(4,60+payload.length,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,40,true);
  view.setUint16(20,0xfffe,true);view.setUint16(22,channels,true);view.setUint32(24,rate,true);view.setUint32(28,rate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);
  view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,mask,true);bytes.set([1,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],44);
  tag(60,'data');view.setUint32(64,payload.length,true);bytes.set(payload,68);return bytes;
}
async function harness(prefix:string){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:20000}});
  return {root,ffmpeg};
}
/** Runs native for every case (4 at a time), then EdgeFFmpeg sequentially, and compares the files byte for byte. */
async function compare(root:string,ffmpeg:FFmpeg,cases:Array<{name:string;before:string[];input:string;after:string[]}>){
  for(let index=0;index<cases.length;index+=4)await Promise.all(cases.slice(index,index+4).map(({name,before,input,after})=>run(native,['-v','error','-nostdin','-y',...before,'-i',join(root,input),...after,join(root,`${name}-native.caf`)])));
  for(const {name,before,input,after}of cases){
    const result=await ffmpeg.exec([...before,'-i',`/${input}`,...after,`/${name}.caf`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
    expect(readFileSync(join(root,`${name}.caf`)).equals(readFileSync(join(root,`${name}-native.caf`))),name).toBe(true);
  }
  return cases.length;
}
it('matches native CAF bytes for 13 codecs x 1-8 guessed channels x 3 rates, with and without -bitexact',async()=>{
  assertReference();const {root,ffmpeg}=await harness('edgeffmpeg-caf-encode-');
  try{
    const cases=[];
    for(const channels of [1,2,3,4,5,6,7,8]){
      writeFileSync(join(root,`in-${channels}.raw`),samples(channels*2*1037,2,'pcm_s16le'));
      for(const rate of [8000,44100,96000])for(const codec of codecs)for(const bitexact of [true,false])
        cases.push({name:`${codec}-${channels}-${rate}-${bitexact}`,before:['-cpuflags','0','-f','s16le','-ar',String(rate),'-ac',String(channels)],input:`in-${channels}.raw`,after:['-c:a',codec,...(bitexact?['-bitexact']:[])]});
    }
    expect(await compare(root,ffmpeg,cases)).toBe(13*8*3*2);
    // Spot checks of the native header itself: guessed 5.1 is tag 121, the encoder tag only without -bitexact.
    const head=readFileSync(join(root,'pcm_s16be-6-44100-false-native.caf'));
    expect(head.subarray(52,56).toString('latin1')).toBe('chan');expect(head.readUInt32BE(64)).toBe(0x00790006);expect(head.subarray(76,80).toString('latin1')).toBe('info');expect(head.subarray(92,113).toString('latin1')).toBe('encoder\0Lavf63.1.102\0');
    expect(readFileSync(join(root,'pcm_s16be-6-44100-true-native.caf')).subarray(76,80).toString('latin1')).toBe('data');
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native CAF stream copy for 13 raw codecs x 1, 2, 3, 6 and 8 channels x 3 rates, and unknown layouts without a chan chunk',async()=>{
  assertReference();const {root,ffmpeg}=await harness('edgeffmpeg-caf-copy-');
  try{
    const cases=[];
    for(const codec of codecs){
      const [format,width]=raw[codec]!;
      for(const channels of [1,2,3,6,8]){
        writeFileSync(join(root,`${codec}-${channels}.raw`),samples(width*channels*613,width,codec));
        for(const rate of [8000,44100,96000])cases.push({name:`copy-${codec}-${channels}-${rate}`,before:['-f',format,'-ar',String(rate),'-ac',String(channels)],input:`${codec}-${channels}.raw`,after:['-c:a','copy','-bitexact']});
        for(const reencode of [false,true])cases.push({name:`unknown-${codec}-${channels}-${reencode}`,before:['-cpuflags','0','-f',format,'-ar','8000','-ac',String(channels),'-guess_layout_max','0'],input:`${codec}-${channels}.raw`,after:['-c:a',reencode?'pcm_s24le':'copy',...(reencode?[]:['-bitexact'])]});
      }
    }
    expect(await compare(root,ffmpeg,cases)).toBe(13*5*5);
    const unknown=readFileSync(join(root,'unknown-pcm_s16le-2-false-native.caf'));expect(unknown.subarray(52,56).toString('latin1')).toBe('data');
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native CAF chan chunks for WAV channel masks: the 12 PCM-path layouts, other mov_channel_layout rows and the bitmap fallback, and guessed layouts up to 24 channels',async()=>{
  assertReference();const {root,ffmpeg}=await harness('edgeffmpeg-caf-layout-');
  try{
    const cases=[];
    for(const [name,mask]of masks){
      const channels=popcount(mask);writeFileSync(join(root,`${name}.wav`),wav(channels,44100,mask,samples(channels*2*700,2,'pcm_s16le')));
      for(const codec of ['copy','pcm_s16be','pcm_f32le','pcm_mulaw'])cases.push({name:`${name}-${codec}`,before:['-cpuflags','0'],input:`${name}.wav`,after:['-c:a',codec,'-bitexact']});
      cases.push({name:`${name}-default`,before:[],input:`${name}.wav`,after:[]});
    }
    // Guessed defaults beyond 8 channels: 9 has no default layout (no chan), 10/12/14 use the bitmap, 16 and 24 truncate a mask above 32 bits.
    for(const channels of [9,10,12,14,16,24]){
      writeFileSync(join(root,`wide-${channels}.raw`),samples(channels*2*300,2,'pcm_s16le'));
      for(const codec of ['copy','pcm_s32be'])cases.push({name:`wide-${channels}-${codec}`,before:['-f','s16le','-ar','48000','-ac',String(channels)],input:`wide-${channels}.raw`,after:['-c:a',codec,'-bitexact']});
    }
    expect(await compare(root,ffmpeg,cases)).toBe(masks.length*5+12);
    expect(readFileSync(join(root,'wide-9-copy-native.caf')).subarray(52,56).toString('latin1')).toBe('data');
    expect(readFileSync(join(root,'wide-16-copy-native.caf')).readUInt32BE(68)).toBe(Number(206158616319n&0xffffffffn));
    const tags:Record<string,number>={mono:0x00640001,stereo:0x00650002,'2.1':0x00850003,'5.1':0x00790006,'6.1':0x10000,'fl+fr+bl':0x10000};
    for(const [name,tag]of Object.entries(tags)){const bytes=readFileSync(join(root,`${name}-copy-native.caf`));expect(bytes.subarray(52,56).toString('latin1'),name).toBe('chan');expect(bytes.readUInt32BE(64),name).toBe(tag);}
    expect(readFileSync(join(root,'fl+fr+bl-copy-native.caf')).readUInt32BE(68)).toBe(0x13);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses unsigned PCM codecs for CAF with native status 183 before any output exists',async()=>{
  assertReference();const {root,ffmpeg}=await harness('edgeffmpeg-caf-refusal-');
  try{
    writeFileSync(join(root,'input.raw'),samples(64,2,'pcm_s16le'));
    for(const codec of ['pcm_u8','pcm_u16le','pcm_u24le','pcm_u32be']){
      const args=['-f','s16le','-ar','8000','-ac','1','-i'],tail=['-c:a',codec];
      const expected=spawnSync(native,['-v','error','-nostdin','-y',...args,join(root,'input.raw'),...tail,join(root,`${codec}-native.caf`)]),result=await ffmpeg.exec([...args,'/input.raw',...tail,`/${codec}.caf`]);
      expect(expected.status,codec).toBe(183);expect(expected.stderr.toString()).toContain('unsupported codec');
      expect(result.exitCode,codec).toBe(183);expect(result.diagnostics.at(-1)?.message).toBe(`CAF muxer does not support ${codec}`);expect(existsSync(join(root,`${codec}.caf`))).toBe(false);
    }
    // The same refusal for a stream copy of unsigned raw input.
    writeFileSync(join(root,'u8.raw'),samples(64,1,'pcm_u8'));
    const expected=spawnSync(native,['-v','error','-nostdin','-y','-f','u8','-i',join(root,'u8.raw'),'-c:a','copy',join(root,'u8-native.caf')]),result=await ffmpeg.exec(['-f','u8','-i','/u8.raw','-c:a','copy','/u8.caf']);
    expect(expected.status).toBe(183);expect(result.exitCode).toBe(183);expect(existsSync(join(root,'u8.caf'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
