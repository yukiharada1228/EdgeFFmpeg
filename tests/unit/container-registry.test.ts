import {describe,expect,expectTypeOf,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,VirtualFileSystem} from '@edge-ffmpeg/core';
import type {PcmCodec} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerFormats,containerOutputListing,containerOutputOptions,containerProbes,defineContainer,detectAudioContainer,inputContainerFor,outputContainerFor,probeW64,rawPcmCodec,supportsAiffCodec,supportsAuCodec,supportsWavCodec} from '@edge-ffmpeg/containers';
import type {ContainerDescriptor,ContainerName,DetectableContainerName,RawPcmFormat} from '@edge-ffmpeg/containers';
import {assertContainerRegistration} from '../../packages/containers/src/registry-table.js';
import {pcmPacketSpan} from '../../packages/avformat/src/time-range.js';
import {collectingOutput} from '../helpers/output.js';

const codecs:readonly PcmCodec[]=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_alaw','pcm_mulaw','pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be','pcm_f32be','pcm_f64be','pcm_u16le','pcm_u16be','pcm_u24le','pcm_u24be','pcm_u32le','pcm_u32be'];
const raw=['s8','s16be','s24be','s32be','u16le','u16be','u24le','u24be','u32le','u32be','f32be','f64be','alaw','mulaw','u8','s16le','s24le','s32le','f32le','f64le'];
const formerNames=['aiff','au','framecrc','w64','wav',...raw].sort();
// Formats registered later are additions: the former predicates cover every other name, and no addition may change a former result.
const added=(name:string|null)=>name!==null&&containerFormat(name)!==undefined&&!formerNames.includes(name);
const names=[...formerNames,'aifc','afc','flac','mp4','mov','rawvideo','image2pipe','framemd5','constructor','__proto__','toString','hasOwnProperty','','WAV','S16LE','s16','pcm_s16le','raw'].filter(name=>!added(name));
const former=(format:ContainerDescriptor)=>formerNames.includes(format.name);
// The pre-registry routing predicates of packages/avformat/src/index.ts at 9fd9ae3, verbatim apart from extraction into functions.
const legacy={
  rawInput:(format:string)=>format==='wav'||format==='aiff'||format==='au'?null:rawPcmCodec(format),
  input:(format:string)=>format==='wav'||format==='aiff'||format==='au'||format==='w64'||legacy.rawInput(format)!==null,
  rawOutput:(format:string|null)=>format===null||format==='wav'||format==='au'?null:rawPcmCodec(format),
  output:(format:string|null)=>format==='wav'||format==='aiff'||format==='au'||format==='w64'||format==='framecrc'||legacy.rawOutput(format)!==null,
  extension(url:string){const path=url.toLowerCase();let outputFormat:string|null=null;if(path.endsWith('.au')||path.endsWith('.snd'))outputFormat='au';else if(path.endsWith('.wav'))outputFormat='wav';else if(path.endsWith('.w64'))outputFormat='w64';else if(['.aif','.aiff','.aifc'].some(extension=>path.endsWith(extension)))outputFormat='aiff';return outputFormat;},
  defaultCodec:(format:string)=>legacy.rawOutput(format)??(['aiff','au'].includes(format)?'pcm_s16be':'pcm_s16le'),
  refusal(format:string,codec:PcmCodec){
    if(format==='au'&&!supportsAuCodec(codec))return `AU muxer does not support ${codec}`;
    if(format==='aiff'&&!supportsAiffCodec(codec))return `AIFF muxer does not support ${codec}`;
    if(format==='wav'&&!supportsWavCodec(codec))return `WAV muxer does not support ${codec}`;
    if(format==='w64'&&!supportsWavCodec(codec))return `W64 muxer does not support ${codec}`;
    const rawCodec=legacy.rawOutput(format);return rawCodec&&rawCodec!==codec?'Raw PCM mux format must match the selected codec':null;
  },
  headerBytes:(format:string)=>legacy.rawInput(format)?0:128,
  scratchBytes:(format:string)=>format==='framecrc'?512:format==='w64'?168:['wav','aiff','au'].includes(format)?128:0,
  seekBeyondEnd:(format:string)=>['aiff','au'].includes(format),
  span:(format:string,info:{blockAlign:number;sampleRate:number})=>format==='aiff'?BigInt(Math.floor(4096/info.blockAlign)):pcmPacketSpan(info.sampleRate),
  async detect(input:ReadHandle,maxReadBytes:number){
    const bytes=new Uint8Array(4);let filled=0;
    while(filled<4){const data=await input.readAt(BigInt(filled),Math.min(4-filled,maxReadBytes));bytes.set(data,filled);filled+=data.length;}
    if(String.fromCharCode(...bytes)==='riff'&&await probeW64(input,maxReadBytes))return 'w64';
    const magic=String.fromCharCode(...bytes);if(magic==='.snd')return 'au';if(magic==='FORM')return 'aiff';if(['RIFF','RF64','BW64','RIFX'].includes(magic))return 'wav';throw new Error('Unsupported audio container signature');
  }
};
function memory(bytes:Uint8Array,requests?:{offset:bigint;length:number}[]):ReadHandle{return {size:BigInt(bytes.length),async readAt(offset,length){requests?.push({offset,length});return bytes.slice(Number(offset),Number(offset)+length);}};}
const ascii=(text:string)=>Uint8Array.from(text,character=>character.charCodeAt(0));
function w64Head(wave='wave'){const tail=[0xf3,0xac,0xd3,0x11,0x8c,0xd1,0x00,0xc0,0x4f,0x8e,0xdb,0x8a],bytes=new Uint8Array(64);bytes.set(ascii('riff'),0);bytes.set([0x2e,0x91,0xcf,0x11,0xa5,0xd6,0x28,0xdb,0x04,0xc1,0x00,0x00],4);bytes.set(ascii(wave),24);bytes.set(tail,28);return bytes;}

describe('container registry',()=>{
  it('registers the pre-registry formats under their -f names with one descriptor each',()=>{
    expect(containerFormats.filter(former).map(format=>format.name)).toEqual(formerNames);
    expect(containerFormats.map(format=>format.name)).toEqual([...containerFormats.map(format=>format.name)].sort());
    for(const format of containerFormats){expect(containerFormat(format.name)).toBe(format);expect([format,format.demux,format.demux?.probe,format.demux?.extensions,format.mux,format.mux?.extensions,format.mux?.options].every(part=>part===undefined||Object.isFrozen(part)),format.name).toBe(true);}
    expect(containerFormats.filter(format=>format.headerless).map(format=>format.name).sort()).toEqual([...raw].sort());
    expect(containerFormats.filter(format=>former(format)&&!format.demux).map(format=>format.name)).toEqual(['framecrc']);
    expect(containerFormats.filter(format=>former(format)&&!format.mux).map(format=>format.name)).toEqual([]);
    expect(containerOutputListing.startsWith('WAV, AIFF, AU, W64, framecrc')).toBe(true);
    expect(containerFormats.filter(format=>former(format)&&format.mux?.options).map(format=>format.name)).toEqual([]);
    // Native w64, framecrc and raw muxers write no input metadata; wav, aiff and au do, so tagged inputs are refused for them.
    expect(containerFormats.filter(format=>former(format)&&format.mux?.dropsMetadata).map(format=>format.name)).toEqual(['framecrc',...raw,'w64'].sort());
    expect([...containerOutputOptions].every(name=>containerFormats.some(format=>!former(format)&&format.mux?.options?.includes(name)))).toBe(true);
    expectTypeOf<'wav'|'aiff'|'au'|'w64'>().toMatchTypeOf<DetectableContainerName>();
    expectTypeOf<'wav'|'aiff'|'au'|'w64'|'framecrc'|RawPcmFormat>().toMatchTypeOf<ContainerName>();
  });
  it('reproduces every former input and output name predicate, default codec and memory size',()=>{
    for(const name of names){
      const format=containerFormat(name);
      expect(Boolean(format?.demux),name).toBe(name!==''&&legacy.input(name));
      expect(Boolean(format?.demux&&format.headerless),name).toBe(legacy.rawInput(name)!==null);
      expect(Boolean(format?.mux),name).toBe(legacy.output(name));
      if(format?.demux)expect([format.demux.headerBytes,Boolean(format.demux.seekBeyondEnd)],name).toEqual([legacy.headerBytes(name),legacy.seekBeyondEnd(name)]);
      if(format?.mux){
        expect([format.mux.defaultCodec,format.mux.scratchBytes],name).toEqual([legacy.defaultCodec(name),legacy.scratchBytes(name)]);
        for(const codec of codecs){const mux=format.mux,refused=mux.supports(codec)?null:(mux.refuse?.(codec)??new Error(`${mux.label} muxer does not support ${codec}`)).message;expect(refused,`${name} ${codec}`).toBe(legacy.refusal(name,codec));}
      }
    }
  });
  it('maps output extensions exactly as the former suffix chain, with no input extensions registered',()=>{
    const urls=['/a.wav','/A.WAV','/a.au','/a.snd','/a.SND','/a.w64','/a.W64','/a.aif','/a.aiff','/a.aifc','/a.AIFC','/a.afc','/a.wave','/a.flac','/a.mp4','/a.m4a','/a.raw','/a.s16le','/a','/a.wav.au','/a.au.wav','/dir.wav/a','/a.framecrc','/a.rso','/a.sox','/a.','/.wav','/a.wav ','/a.wav/'];
    for(const url of urls){
      const output=outputContainerFor(url)?.name??null,input=inputContainerFor(url)?.name??null;
      if(added(output))expect(legacy.extension(url),url).toBeNull();else expect(output,url).toBe(legacy.extension(url));
      expect(input===null||added(input),url).toBe(true);
    }
  });
  it('keeps the packet span of every demuxer, including AIFF 4096/blockAlign',()=>{
    // Pre-registry demuxers only: an addition's span may read its own info fields (sds packetSamples), which its own tests cover.
    for(const format of containerFormats.filter(former))if(format.demux)for(const info of [{sampleRate:8000,blockAlign:1},{sampleRate:44100,blockAlign:6},{sampleRate:96000,blockAlign:24},{sampleRate:1,blockAlign:4096},{sampleRate:2147483647,blockAlign:3}])
      expect(format.demux.packetSpan?.({...info,codec:'pcm_s16le',channels:1,channelMask:null,durationSamples:0n})??pcmPacketSpan(info.sampleRate),format.name).toBe(legacy.span(format.name,info));
  });
  it('probes in the former fixed order and reads past four bytes only for a riff head',async()=>{
    expect(containerProbes.filter(former).map(format=>[format.name,format.demux.probe!.precedence])).toEqual([['w64',10],['au',20],['aiff',30],['wav',40]]);
    const heads=[ascii('RIFF....WAVE'),ascii('RF64'),ascii('BW64'),ascii('RIFX'),ascii('.snd'),ascii('FORM'),ascii('fLaC'),ascii('riff'),ascii('abcd'),ascii('Riff'),w64Head(),w64Head('WAVE'),w64Head().subarray(0,40)];
    for(const [index,bytes] of heads.entries())for(const budget of [1,3,64]){
      const requests:{offset:bigint;length:number}[]=[],expected=await legacy.detect(memory(bytes),budget).catch((error:Error)=>error.message);
      const actual=await detectAudioContainer(memory(bytes,requests),budget,undefined,'/input.w64').catch((error:Error)=>error.message);
      // An addition may only claim a head the former probe refused.
      if(added(actual))expect(expected,`${index} ${budget}`).toBe('Unsupported audio container signature');else expect(actual,`${index} ${budget}`).toBe(expected);
      const claimed=containerProbes.some(format=>!former(format)&&format.demux.probe!.head(bytes.slice(0,4)));
      if(!claimed)expect(requests.some(request=>request.offset+BigInt(request.length)>4n),`${index} ${budget}`).toBe(String.fromCharCode(...bytes.subarray(0,4))==='riff'&&bytes.length>40);
    }
    await expect(detectAudioContainer(memory(ascii('RIF')),64)).rejects.toThrow(/^Invalid audio container probe$/);
  });
  it('refuses malformed registrations when the registry module loads',()=>{
    const write=async()=>{},open=async()=>{throw new Error('unused');};
    const ok=defineContainer({name:'okay',demux:{headerBytes:0,open,probe:{precedence:1,head:()=>false}},mux:{label:'Okay',defaultCodec:'pcm_s16le',supports:()=>true,scratchBytes:0,write,options:['-okay'],extensions:['.ok']}});
    expect(()=>assertContainerRegistration('okay',ok)).not.toThrow();
    const broken:[string,unknown][]=[
      ['other',ok],['Okay',{...ok,name:'Okay'}],['okay',{name:'okay'}],['okay',{...ok,headerless:true}],['okay',{...ok,demux:{...ok.demux,headerBytes:-1}}],
      ['okay',{...ok,demux:{...ok.demux,probe:{precedence:Number.NaN,head:()=>false}}}],['okay',{...ok,demux:{...ok.demux,extensions:['ok']}}],['okay',{...ok,demux:{...ok.demux,extensions:['.o.k']}}],
      ['okay',{...ok,mux:{...ok.mux,label:''}}],['okay',{...ok,mux:{...ok.mux,supports:()=>false}}],['okay',{...ok,mux:{...ok.mux,options:['hash']}}],['okay',{...ok,mux:{...ok.mux,scratchBytes:0.5}}],
      ['okay',{...ok,mux:{...ok.mux,extensions:[]}}],['okay',{...ok,mux:{...ok.mux,dropsMetadata:1}}],['okay',{...ok,mux:{...ok.mux,write:undefined}}],['okay',null]
    ];
    for(const [key,format] of broken)expect(()=>assertContainerRegistration(key,format as ContainerDescriptor),key).toThrow(new Error(`Invalid container registration: ${key}`));
  });
});

// Raw s16le mono samples 1..64 and their RIFF form.
const pcm=new Uint8Array(128);for(let index=0;index<64;index++)new DataView(pcm.buffer).setInt16(index*2,index+1,true);
async function run(args:readonly string[]){
  const sink=collectingOutput();let opens=0;
  const filesystem:VirtualFileSystem={async openRead(){return memory(pcm);},async openWrite(){opens++;return sink.output;}};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  return {result,opens,message:result.diagnostics.at(-1)?.message,bytes:sink.bytes()};
}
describe('registry-routed PCM CLI refusals',()=>{
  it('keeps every routing message and refuses before creating the output',async()=>{
    const raw=['-f','s16le','-ar','8000','-i','/in.raw'];
    for(const [args,message] of [
      [[...raw,'/out.flac'],`Output requires ${containerOutputListing} or an explicit raw PCM format`],
      [[...raw,'-f','aifc','/out.aifc'],`Output requires ${containerOutputListing} or an explicit raw PCM format`],
      [['-f','aifc','-i','/in.aifc','/out.wav'],'Unsupported input format: aifc'],
      [['-f','constructor','-i','/in.raw','/out.wav'],'Unsupported input format: constructor'],
      [['-f','framecrc','-i','/in.raw','/out.wav'],'Unsupported input format: framecrc'],
      [['-f','wav','-ar','8000','-i','/in.wav','/out.wav'],'Input rate/channel declarations currently require a raw PCM format'],
      [[...raw,'-c:a','pcm_s16be','/out.wav'],'WAV muxer does not support pcm_s16be'],
      [[...raw,'-c:a','pcm_u8','/out.aiff'],'AIFF muxer does not support pcm_u8'],
      [[...raw,'-c:a','pcm_s16le','/out.au'],'AU muxer does not support pcm_s16le'],
      [[...raw,'-c:a','pcm_s16be','/out.w64'],'W64 muxer does not support pcm_s16be'],
      [[...raw,'-c:a','pcm_s16be','-f','s16le','/out.raw'],'Raw PCM mux format must match the selected codec'],
      [['-f','s16le','-ac','4','-guess_layout_max','2','-i','/in.raw','-f','framecrc','/out.crc'],null]
    ] as const){
      const {result,opens,message:actual}=await run(args);
      if(message===null){expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);continue;}
      expect([result.exitCode,result.diagnostics.at(-1)?.code,actual,opens],args.join(' ')).toEqual([1,'unsupported-command',message,0]);
    }
  });
  it('refuses an option no registered format declares, in the backend as before',async()=>{
    // The CLI parser refuses unknown options first; a parsed command reaches the backend's per-format option check.
    // Once the parser knows -hash (hash muxers), the backend refuses it for framecrc instead; either way nothing is opened.
    const parsed=await run(['-f','s16le','-i','/in.raw','-hash','md5','-f','framecrc','/out.crc']);
    expect([parsed.result.exitCode,parsed.opens]).toEqual([1,0]);expect(['invalid-arguments Unsupported option: -hash','unsupported-command Unsupported output option: -hash']).toContain(`${parsed.result.diagnostics.at(-1)?.code} ${parsed.message}`);
    let opens=0;const filesystem:VirtualFileSystem={async openRead(){return memory(pcm);},async openWrite(){opens++;return collectingOutput().output;}};
    const command={global:[],inputs:[{url:'/in.raw',options:[{name:'-f',value:'s16le'}]}],outputs:[{url:'/out.crc',options:[{name:'-hash',value:'md5'},{name:'-f',value:'framecrc'}]}]};
    const error=await createMediaBackend().execute(command,{filesystem,signal:new AbortController().signal,budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:2}}).then(()=>null,(failure:unknown)=>failure);
    expect(error).toMatchObject({code:'unsupported-command',message:'Unsupported output option: -hash'});expect(opens).toBe(0);
  });
  it('routes defaults, extensions and headerless declarations through the descriptors',async()=>{
    const wav=await run(['-f','s16le','-ar','8000','-i','/in.raw','/out.WAV']);expect(wav.result.exitCode).toBe(0);expect(String.fromCharCode(...wav.bytes.subarray(0,4))).toBe('RIFF');
    const aiff=await run(['-f','s16le','-ar','8000','-i','/in.raw','/out.aifc']);expect(aiff.result.exitCode).toBe(0);expect(String.fromCharCode(...aiff.bytes.subarray(0,4))).toBe('FORM');
    // AIFF's default codec is big-endian: the payload is byte-swapped.
    expect(aiff.bytes.subarray(-128)).toEqual(Uint8Array.from(pcm,(_,index)=>pcm[index^1]!));
    const copied=await run(['-f','s16le','-ar','8000','-i','/in.raw','-c:a','copy','-f','s16le','/out.raw']);expect(copied.bytes).toEqual(pcm);
    const crc=await run(['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','-c:a','copy','-f','framecrc','/out.crc']);
    expect(new TextDecoder().decode(crc.bytes)).toMatch(/#channel_layout_name 0: stereo\n0, +0, +0, +32, +128, 0x[0-9a-f]{8}\n$/);
    const unguessed=await run(['-f','s16le','-ac','4','-guess_layout_max','2','-i','/in.raw','-f','framecrc','/out.crc']);expect(new TextDecoder().decode(unguessed.bytes)).toContain('#channel_layout_name 0: 4 channels\n');
  });
});
