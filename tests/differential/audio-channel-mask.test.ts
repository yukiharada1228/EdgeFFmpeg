import {expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {channelLayoutName,defaultChannelLayout} from '@edge-ffmpeg/avutil';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';

// Layout-constraint stand-ins registered exactly as a new filter is: one descriptor each, listed only in the registry module.
vi.mock('../../packages/avfilter/src/audio/registry.js',async importOriginal=>{
 const {AudioFilterError,defineAudioFilter,frameReservation}=await import('../../packages/avfilter/src/audio/descriptor.js');
 const only=(name:string)=>(text:string)=>{if(text!==name)throw new AudioFilterError(`Unsupported audio filter: ${text}`);return Object.freeze({name});};
 const capabilities=()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false});
 return {...await importOriginal<Record<string,unknown>>(),
  // A stereo-only filter (earwax, extrastereo, haas, stereowiden) as scoped: a pinned format and a 'stereo' layout constraint, with a copying apply.
  nstereo:defineAudioFilter({name:'nstereo',examples:['nstereo'],parse:only('nstereo'),capabilities,formats:()=>['flt'],
   constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError('nstereo requires a stereo layout');},
   apply:(_step,frame)=>({...frame,planes:frame.planes.map(plane=>plane.slice())}),reserve:()=>frameReservation}),
  // channelmap's scoped refusal in its own descriptor: any layout other than the CLI's unmasked names comes from a non-default container mask.
  nremap:defineAudioFilter({name:'nremap',examples:['nremap'],parse:only('nremap'),capabilities,formats:()=>['u8p','s16p','s32p','fltp','dblp','s64p'],transparent:true,
   constraint:()=>format=>{if(format.channelLayout!==(format.channels===1?'mono':format.channels===2?'stereo':'unspecified'))throw new AudioFilterError('nremap requires the default channel layout');},
   apply:(_step,frame)=>({...frame,planes:frame.planes.map(plane=>plane.slice())}),reserve:()=>frameReservation})
 };
});

const native=resolve('.build/reference/ffmpeg');
/** s16 44100 Hz WAV of 64 samples: WAVEFORMATEXTENSIBLE carrying `mask`, or plain WAVEFORMATEX for null. */
function wav(channels:number,mask:number|null):Uint8Array {
 const fmt=mask===null?16:40,data=64*channels*2,bytes=new Uint8Array(28+fmt+data),view=new DataView(bytes.buffer),text=(at:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[at+index]=value.charCodeAt(index);};
 text(0,'RIFF');view.setUint32(4,20+fmt+data,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,fmt,true);
 view.setUint16(20,mask===null?1:0xfffe,true);view.setUint16(22,channels,true);view.setUint32(24,44100,true);view.setUint32(28,44100*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);
 if(mask!==null){view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,mask>>>0,true);bytes.set([1,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],44);}
 text(20+fmt,'data');view.setUint32(24+fmt,data,true);for(let index=0;index<64*channels;index++)view.setInt16(28+fmt+index*2,(index*977)%20000-10000,true);
 return bytes;
}
const bits=(mask:number)=>mask.toString(2).replaceAll('0','').length;
/** The layout native reports for a WAV input, from ashowinfo. */
function nativeLayout(path:string):string {
 const run=spawnSync(native,['-hide_banner','-i',path,'-af','ashowinfo','-f','null','-'],{encoding:'utf8'});
 expect(run.status,run.stderr.slice(-1000)).toBe(0);
 return /chlayout:(.*?) rate:/.exec(run.stderr)![1]!;
}

it('names every WAV mask bit and standard layout as native describes it',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-mask-names-'));
 try{
  const listing=spawnSync(native,['-hide_banner','-layouts'],{encoding:'utf8'}).stdout,[channelPart,layoutPart]=listing.split('Standard channel layouts:') as [string,string];
  const rows=(part:string)=>part.split('\n').slice(2).map(line=>line.trim().split(/\s+/)).filter(row=>row.length>=2&&row[0]!=='NAME');
  // Our channel ids in enum order name exactly native's individual channels; every standard row names the mask of its decomposition.
  const ids=new Map<string,number>();
  for(let id=0;id<63;id++){const name=/^1 channels \((.*)\)$/.exec(channelLayoutName(1n<<BigInt(id)))?.[1]??(id===2?'FC':undefined);if(name&&!name.startsWith('USR'))ids.set(name,id);}
  expect([...ids.keys()]).toEqual(rows(channelPart).map(row=>row[0]));
  const standard=rows(layoutPart).map(([name,decomposition])=>[name!,decomposition!.split('+').reduce((mask,channel)=>mask|1n<<BigInt(ids.get(channel)!),0n)] as const);
  expect(standard).toHaveLength(40);
  for(const [name,mask]of standard)expect(channelLayoutName(mask),name).toBe(name);
  // WAV carries 32-bit masks: every single bit and every standard layout that fits is read back by native under our name.
  const masks=[...Array.from({length:32},(_,bit)=>2**bit),...standard.filter(([,mask])=>mask<1n<<32n).map(([,mask])=>Number(mask))];
  let compared=0;
  for(const mask of masks){
   const path=join(root,`${mask}.wav`);writeFileSync(path,wav(bits(mask),mask));
   expect(nativeLayout(path),`0x${mask.toString(16)}`).toBe(channelLayoutName(BigInt(mask)));compared++;
  }
  expect(compared).toBe(67);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);

it('refuses a non-default WAV mask in layout constraints before output, and runs the default mask byte for byte as native',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-mask-constraint-')),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<16,maxWriteBytes:1<<16});
 const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:1<<16,maxPendingPackets:2,maxCpuTimeMs:10000}});
 // [channels, mask, native status of aformat=cl and of earwax/extrastereo]: 234 where swresample has no matrix for the layout, 0 where it remixes or treats it as mono/stereo.
 const cases:[number,number|null,number][]=[[2,null,0],[2,0x3,0],[2,0x5,234],[2,0x6,234],[2,0x30,234],[2,0x600,234],[2,0x40001,234],[2,0x80000001,234],[2,0x104,0],[2,0x60000000,0],[1,null,0],[1,0x4,0],[1,0x1,0],[1,0x8,0],[3,null,0],[3,0xb,0],[3,0x7,0],[3,0x700,0]];
 const tally={matched:0,refused:0,nativeFailed:0,nativeRan:0};
 try{
  for(const [channels,mask,status]of cases){
   const name=`m${channels}_${mask??'none'}`,path=join(root,`${name}.wav`),masked=mask!==null&&BigInt(mask)!==defaultChannelLayout(channels)!.mask,layout=channels===1?'mono':'stereo';
   writeFileSync(path,wav(channels,mask));
   // Each of our constraints beside its native counterparts; channelmap accepts any mask natively, so nremap's refusal is the scoped one.
   const pairs:[string,string[],number][]=[...(channels<3?[[`aformat=cl=${layout}`,[`aformat=cl=${layout}`],status] as [string,string[],number]]:[]),...(channels===2?[['nstereo',['earwax','extrastereo'],status] as [string,string[],number]]:[]),['nremap',[`channelmap=${channels===1?'0':channels===2?'1|0':'2|0|1'}`],0]];
   for(const [filter,counterparts,expected]of pairs){
    for(const counterpart of counterparts){
     const run=spawnSync(native,['-hide_banner','-v','error','-cpuflags','0','-i',path,'-af',counterpart,'-f','s16le','-y',join(root,`${name}.native.raw`)],{encoding:'utf8'});
     expect(run.status,`${name} ${counterpart} ${run.stderr}`).toBe(expected);
    }
    const out=`${name}.${filter.replace('=','_')}.raw`,result=await frontend.exec(['-cpuflags','0','-i',`/${name}.wav`,'-af',filter,'-f','s16le',`/${out}`]);
    if(!masked){
     expect(result.exitCode,`${name} ${filter} ${JSON.stringify(result.diagnostics)}`).toBe(0);
     if(filter.startsWith('aformat'))expect(readFileSync(join(root,out)),`${name} ${filter}`).toEqual(readFileSync(join(root,`${name}.native.raw`)));
     tally.matched++;continue;
    }
    // Whether native fails or converts, ours refuses with nothing written.
    expect(result.exitCode,`${name} ${filter}`).not.toBe(0);expect(existsSync(join(root,out)),`${name} ${filter}`).toBe(false);
    expect(result.diagnostics[0]?.message,`${name} ${filter}`).toBe(filter==='nremap'?'nremap requires the default channel layout':filter==='nstereo'?'nstereo requires a stereo layout':'aformat channel layout constraint requires an implicit conversion');
    tally.refused++;if(expected)tally.nativeFailed++;else tally.nativeRan++;
   }
  }
  expect(tally).toEqual({matched:12,refused:30,nativeFailed:12,nativeRan:18});
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
