import {describe,expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {nsp,openNsp,probeNsp} from '../../packages/containers/src/nsp.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
// Layout from libavformat/nspdec.c: 'FORM','DS16', 4 skipped bytes, then {RB32 id, RL32 size} chunks; audio runs from the first SDA_/SD_A/SD_2..8/SDAB header to EOF.
const text=(value:string)=>[...value].map(c=>c.charCodeAt(0));
const le32=(value:number)=>[value&255,(value>>>8)&255,(value>>>16)&255,(value>>>24)&255];
const chunk=(id:string,size:number,body:readonly number[]=[])=>[...text(id),...le32(size),...body];
const hedr=(rate:number,size=32,id='HEDR')=>chunk(id,size,[...new Array(20).fill(0x55),...le32(rate),...new Array(Math.max(0,size-24)).fill(0x66)]);
const file=(...parts:ReadonlyArray<readonly number[]>)=>Uint8Array.from([...text('FORMDS16'),1,2,3,4,...parts.flat()]);
const pcm=Uint8Array.from({length:40},(_,index)=>(index*37+5)&255);
async function collect(input:Awaited<ReturnType<typeof openNsp>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function run(input:Uint8Array,args:readonly string[]){
  const sink=collectingOutput();let opens=0;
  const filesystem:VirtualFileSystem={async openRead(){return memoryInput(input);},async openWrite(){opens++;return sink.output;}};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}
const status=(promise:Promise<unknown>)=>promise.then(()=>null,(error:Error&{code?:string;exitCode?:number})=>[error.code,error.exitCode,error.message]);
describe('nsp demuxer',()=>{
  it('walks HEDR/HDR8, mono and stereo audio chunks with bounded reads and never reads the payload while opening',async()=>{
    for(const [id,channels,rate,hdr] of [['SDA_',1,8000,'HEDR'],['SD_A',1,16000,'HDR8'],['SDAB',2,44100,'HEDR'],['SD_5',1,22050,'HDR8']] as const){
      const requests:Array<{offset:bigint;length:number}>=[],bytes=file(hedr(rate,40,hdr),chunk(id,999),[...pcm]),input=await openNsp(memoryInput(bytes,requests),{maxReadBytes:4});
      expect(input.info).toMatchObject({container:'nsp',codec:'pcm_s16le',channels,sampleRate:rate,channelMask:null,blockAlign:2*channels,dataOffset:68n,dataBytes:40n,durationSamples:BigInt(20/channels),metadata:false,warnings:id==='SD_5'?['Unsupported chunk!']:[]});
      expect(input.info.copyRefusal).toMatch(/^NSP stream copy is not implemented/);
      expect(requests.every(request=>request.length<=4&&request.offset+BigInt(request.length)<=68n)).toBe(true);
      // Two chunk headers and the rate word: 8 + 4 + 8 bytes.
      expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(20);
      const packets=await collect(input,1n,2*channels);expect(packets.map(packet=>packet.pts)).toEqual(Array.from({length:20/channels-1},(_,index)=>BigInt(index+1)));
    }
    // The last header before the audio chunk wins; the audio chunk size is ignored and data runs to EOF.
    expect((await openNsp(memoryInput(file(hedr(8000),hedr(11025,33),chunk('SDAB',0),[...pcm])),{maxReadBytes:64})).info).toMatchObject({sampleRate:11025,channels:2,dataOffset:101n,durationSamples:10n});
  });
  it('does not skip unknown chunks and re-parses bytes after the first NUL of a NOTE',async()=>{
    // An unknown id is followed by the next chunk header 8 bytes later, whatever its size.
    const unknown=await openNsp(memoryInput(file(chunk('ABCD',0x7fffffff),hedr(8000),chunk('JUNK',12),chunk('SDA_',1),[...pcm])),{maxReadBytes:64});
    expect(unknown.info).toMatchObject({dataOffset:76n,durationSamples:20n,metadata:false});
    // NOTE size 9 holds 'hi\0X' then 'SDA_\0': avio_get_str stops after the NUL (3 bytes), size&1 skips 'X', and the next header is read inside the note.
    const quirk=await openNsp(memoryInput(file(hedr(8000),chunk('NOTE',9,[...text('hi'),0,...text('X')]),chunk('SDA_',0),[...pcm])),{maxReadBytes:2});
    expect(quirk.info).toMatchObject({metadata:true,dataOffset:72n,durationSamples:20n});
    // A NOTE without NUL consumes its size; an even size skips nothing; an empty note still sets the comment.
    const whole=await openNsp(memoryInput(file(chunk('NOTE',4,text('abcd')),hedr(8000),chunk('NOTE',0),chunk('SDAB',0),[...pcm])),{maxReadBytes:4});
    expect(whole.info).toMatchObject({metadata:true,channels:2,dataOffset:80n});
    // A long note is scanned in windows of at most 1024 bytes and maxReadBytes.
    const requests:Array<{offset:bigint;length:number}>=[],long=file(hedr(8000),chunk('NOTE',5000,new Array(5000).fill(65)),chunk('SDA_',0),[...pcm]);
    expect((await openNsp(memoryInput(long,requests),{maxReadBytes:4096})).info).toMatchObject({metadata:true,dataOffset:BigInt(12+40+8+5000+8)});
    expect(Math.max(...requests.map(request=>request.length))).toBe(1024);
  });
  it('mirrors nsp_probe after aiff-overlapping heads, with a 12-byte confirm',async()=>{
    expect(probeNsp(file())).toBe(true);expect(probeNsp(file().subarray(0,7))).toBe(false);expect(probeNsp(Uint8Array.from(text('FORMDS17')))).toBe(false);
    const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(file(hedr(8000),chunk('SDA_',0)),requests),64)).toBe('nsp');
    expect(requests).toEqual([{offset:0n,length:4},{offset:0n,length:12}]);
    // A form type at byte 8 that another native probe scores 100 ties with nsp_probe: native detects nothing, so the confirm resolves false.
    for(const form of ['AIFF','AIFC','8SVX','16SV','MAUD','PBM ','ACBM','DEEP','ILBM','RGB8','ANIM','RGBN','WVQA','RLV2','RLV3','MOVE']){const bytes=file();bytes.set(text(form),8);expect(probeNsp(bytes),form).toBe(false);expect(await nsp.demux.probe!.confirm!(memoryInput(bytes),5,undefined),form).toBe(false);}
    for(const form of ['AIFX','MAUX','EVOM','\0\0\0\0']){const bytes=file();bytes.set(text(form),8);expect(await nsp.demux.probe!.confirm!(memoryInput(bytes),5,undefined),form).toBe(true);}
    expect(await nsp.demux.probe!.confirm!(memoryInput(Uint8Array.from(text('FORMDS16MA'))),64,undefined)).toBe(true);
    expect(await detectAudioContainer(memoryInput(file()),3)).toBe('nsp');
    // AIFF and AIFC carry a size at byte 4, so the confirm resolves false and aiff (30) decides; a bare 4-byte FORM or a short FORM confirms false too.
    const aiff=(form:string)=>Uint8Array.from([...text('FORM'),0,0,0,30,...text(form),...new Array(30).fill(0)]);
    for(const form of ['AIFF','AIFC']){const bytes=aiff(form);expect(await nsp.demux.probe!.confirm!(memoryInput(bytes),64,undefined)).toBe(false);}
    expect(await detectAudioContainer(memoryInput(aiff('AIFF')),64)).toBe('aiff');
    for(const bytes of [Uint8Array.from(text('FORM')),Uint8Array.from(text('FORMDS1')),Uint8Array.from([...text('FORM'),...text('MAUD')])])expect(await nsp.demux.probe!.confirm!(memoryInput(bytes),64,undefined)).toBe(false);
    // The pre-registry aiff head accepts any FORM, so a bare FORM falls through nsp to aiff.
    expect(await detectAudioContainer(memoryInput(Uint8Array.from(text('FORM'))),64)).toBe('aiff');
    const ordered=containerProbes.map(descriptor=>descriptor.name);expect(ordered.indexOf('nsp')).toBeLessThan(ordered.indexOf('aiff'));
  });
  it('refuses a walk without audio, invalid rates and header sizes with native statuses, and partial frames explicitly',async()=>{
    const open=(bytes:Uint8Array,seek?:bigint)=>status(openNsp(memoryInput(bytes),{maxReadBytes:4096,...(seek===undefined?{}:{seek})}));
    for(const bytes of [file(),file(hedr(8000)),file(hedr(8000),chunk('ABCD',0)),file(hedr(8000),[1,2,3]),file(hedr(8000,64)),file(chunk('NOTE',20,text('abc'))),file(chunk('HEDR',32,[1,2,3])),Uint8Array.from(text('FORMDS16'))])
      expect(await open(bytes)).toEqual(['unsupported-command',234,'NSP input ends before a data chunk']);
    expect(await open(file(chunk('SDA_',0),[...pcm]))).toEqual(['unsupported-command',234,'Invalid NSP sample rate: 0']);
    expect(await open(file(hedr(0x80000000),chunk('SDA_',0),[...pcm]))).toEqual(['unsupported-command',234,'Invalid NSP sample rate: -2147483648']);
    expect(await open(file(hedr(8000,31),chunk('SDA_',0),[...pcm]))).toEqual(['unsupported-command',183,'Invalid NSP header chunk size']);
    expect(await open(file(hedr(8000),chunk('SDA_',0),[...pcm.subarray(0,39)]))).toEqual(['unsupported',undefined,'Partial trailing NSP sample frame is not implemented']);
    expect(await open(file(hedr(8000),chunk('SDAB',0),[...pcm.subarray(0,38)]))).toEqual(['unsupported',undefined,'Partial trailing NSP sample frame is not implemented']);
    expect(await open(file(hedr(8000),chunk('SDA_',0)))).toEqual(['unsupported',undefined,'Empty NSP audio data is not implemented']);
    expect(await open(file(hedr(8000),[...text('SDA_'),0,0]))).toEqual(['unsupported',undefined,'Truncated NSP data chunk header is not implemented']);
    expect(await open(file(hedr(8000),chunk('NOTE',0x80000000)))).toEqual(['unsupported',undefined,'NSP note larger than 2 GiB is not implemented']);
    expect(await open(file(hedr(8000),chunk('SDA_',0),[...pcm]),1n)).toEqual(['unsupported',undefined,'NSP input seek is not implemented']);
    expect(await open(file(hedr(8000),chunk('SDA_',0),[...pcm]),0n)).toBeNull();
    await expect(openNsp(memoryInput(file()),{maxReadBytes:0})).rejects.toThrow('Invalid NSP read budget');
  });
  it('honours abort before and between bounded header reads',async()=>{
    const aborted=new AbortController();aborted.abort(new Error('stop'));
    await expect(openNsp(memoryInput(file(hedr(8000),chunk('SDA_',0))),{maxReadBytes:4,signal:aborted.signal})).rejects.toThrow('stop');
    const controller=new AbortController(),bytes=file(hedr(8000),chunk('SDA_',0),[...pcm]);let reads=0;
    const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){if(++reads===2)controller.abort(new Error('mid'));return bytes.slice(Number(offset),Number(offset)+length);}};
    await expect(openNsp(input,{maxReadBytes:4,signal:controller.signal})).rejects.toThrow('mid');expect(reads).toBe(2);
  });
  it('registers a demux-only descriptor with precedence 24',()=>{
    const descriptor=containerFormat('nsp')!;expect(descriptor).toBe(nsp);expect(descriptor.mux).toBeUndefined();expect(descriptor.headerless).toBeUndefined();
    expect(descriptor.demux).toMatchObject({headerBytes:1024,probe:{precedence:24}});expect(descriptor.demux?.packetSpan).toBeUndefined();expect(descriptor.demux?.seekBeyondEnd).toBeUndefined();expect(descriptor.demux?.extensions).toBeUndefined();
    const head=(value:string)=>nsp.demux.probe!.head(Uint8Array.from(text(value)));
    expect([head('FORM'),head('form'),head('RIFF'),head('DS16')]).toEqual([true,false,false,false]);
  });
  it('decodes through the media backend, refuses copy and tagged inputs for tag-writing muxers before any output exists',async()=>{
    const bytes=file(hedr(8000),chunk('SDAB',0),[...pcm]);
    const reference=await run(pcm,['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','/out.wav']);
    const detected=await run(bytes,['-i','/in.nsp','/out.wav']);expect(detected.result.exitCode,JSON.stringify(detected.result.diagnostics)).toBe(0);expect(detected.bytes).toEqual(reference.bytes);
    const declared=await run(bytes,['-f','nsp','-i','/in.nsp','-f','s16le','/out.raw']);expect(declared.bytes).toEqual(pcm);
    for(const output of [['-f','framecrc','/out.crc'],['-f','s16le','/out.raw'],['/out.wav']]){
      const copy=await run(bytes,['-i','/in.nsp','-c:a','copy',...output]);expect([copy.result.exitCode,copy.last?.code,copy.opens]).toEqual([1,'unsupported-command',0]);expect(copy.last?.message).toMatch(/^NSP stream copy/);
    }
    const tagged=file(hedr(8000),chunk('NOTE',2,[...text('a'),0]),chunk('SDA_',0),[...pcm]);
    for(const output of ['/out.wav','/out.aiff','/out.au']){const refused=await run(tagged,['-i','/in.nsp',output]);expect([refused.last?.message,refused.opens],output).toEqual([expect.stringMatching(/^Input metadata for the .* muxer is not implemented$/),0]);}
    for(const output of [['-f','s16le','/out.raw'],['-f','framecrc','/out.crc'],['/out.w64']]){const accepted=await run(tagged,['-i','/in.nsp',...output]);expect(accepted.result.exitCode,output.join(' ')).toBe(0);}
    const seek=await run(bytes,['-ss','0.001','-i','/in.nsp','/out.wav']);expect([seek.last?.message,seek.opens]).toEqual(['NSP input seek is not implemented',0]);
    const empty=await run(file(hedr(8000)),['-i','/in.nsp','/out.wav']);expect([empty.result.exitCode,empty.opens]).toEqual([234,0]);
    const ar=await run(bytes,['-f','nsp','-ar','8000','-i','/in.nsp','/out.wav']);expect([ar.last?.message,ar.opens]).toEqual(['Input rate/channel declarations currently require a raw PCM format',0]);
    const output=await run(pcm,['-f','s16le','-i','/in.raw','-f','nsp','/out.nsp']);expect(output.opens).toBe(0);expect(output.result.exitCode).not.toBe(0);
  });
});
