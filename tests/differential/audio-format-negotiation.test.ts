import {expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AudioFilterError,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';

/** The native FILTER_SAMPLEFMTS / query_formats list of each probed filter (upstream/ffmpeg/libavfilter), in source order. */
const lists=vi.hoisted(()=>({aecho:['s16p','s32p','fltp','dblp'],aderivative:['s16p','fltp','s32p','dblp'],aintegral:['fltp','dblp'],crystalizer:['flt','fltp','dbl','dblp'],afade:['s16','s16p','s32','s32p','flt','fltp','dbl','dblp'],asoftclip:['fltp','dblp'],channelmap:['u8p','s16p','s32p','fltp','dblp','s64p'],dcshift:['s32p'],adynamicsmooth:['dblp'],haas:['dbl'],extrastereo:['flt']} as Record<string,readonly string[]>));
// Negotiation-only stand-ins registered exactly as a new filter is: one descriptor each, listed only in the registry module, declaring the native list.
vi.mock('../../packages/avfilter/src/audio/registry.js',async importOriginal=>{
 const {AudioFilterError:Refusal,defineAudioFilter,frameReservation}=await import('../../packages/avfilter/src/audio/descriptor.js');
 const {convertAudioFrame}=await import('@edge-ffmpeg/swresample');
 const standIns=Object.entries(lists).map(([native,formats])=>[`n${native}`,defineAudioFilter({name:`n${native}`,examples:[`n${native}`],
  parse(text){if(text!==`n${native}`)throw new Refusal(`Unsupported audio filter: ${text}`);return Object.freeze({name:`n${native}`});},
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>formats as never,apply:(_step,frame,target,options)=>convertAudioFrame(frame,target,options),reserve:()=>frameReservation})]);
 return {...await importOriginal<Record<string,unknown>>(),...Object.fromEntries(standIns)};
});

const native=resolve('.build/reference/ffmpeg');
/** Native token for each stand-in; neighbours are the pre-registry filters, spelled identically on both sides. */
const tokens:Record<string,string>={aecho:'aecho',aderivative:'aderivative',aintegral:'aintegral',crystalizer:'crystalizer',afade:'afade',asoftclip:'asoftclip',channelmap:'channelmap=0|1',dcshift:'dcshift=0.1',adynamicsmooth:'adynamicsmooth',haas:'haas',extrastereo:'extrastereo'};
const neighbours=['anull','asetnsamples=7','apad=pad_len=3','volume=0.5','volume=0.5:precision=fixed','volume=0.5:precision=double','adelay=2S','aformat=f=fltp','aformat=f=s32','aformat=f=dbl'];
const filters=Object.keys(tokens),pairs=['aecho','aintegral','crystalizer','afade','channelmap','dcshift'];
/** Each chain as [ours, native] step lists. */
const chains:[string[],string[]][]=[
 ...filters.map(name=>[[`n${name}`],[tokens[name]!]] as [string[],string[]]),
 ...filters.flatMap(name=>neighbours.flatMap(other=>[[[other,`n${name}`],[other,tokens[name]!]],[[`n${name}`,other],[tokens[name]!,other]]] as [string[],string[]][])),
 ...pairs.flatMap(first=>pairs.map(second=>[[`n${first}`,`n${second}`],[tokens[first]!,tokens[second]!]] as [string[],string[]])),
 [['volume=0.5:precision=fixed','naecho','volume=0.5'],['volume=0.5:precision=fixed','aecho','volume=0.5']],
 [['anull','ncrystalizer','asetnsamples=7','nafade'],['anull','crystalizer','asetnsamples=7','afade']],
 [['adelay=2S','naderivative','aformat=f=s16'],['adelay=2S','aderivative','aformat=f=s16']],
 [['nafade','volume=0.5:precision=fixed','nchannelmap'],['afade','volume=0.5:precision=fixed','channelmap=0|1']]
];
const inputs=[['u8','u8'],['s16le','s16'],['s32le','s32'],['f32le','flt'],['f64le','dbl']] as const;
/** Encoder outputs; -ac 1 adds a channel conversion after the chain, which the PCM path compiles with outputConversion. */
const outputs=[...(['u8','s16le','s32le','f32le','f64le'] as const).map(format=>({format,remix:false})),{format:'s16le',remix:true},{format:'f64le',remix:true}] as const;
const encoders:Record<string,AudioSampleFormat>={u8:'u8',s16le:'s16',s32le:'s32',f32le:'flt',f64le:'dbl'};
const base=(format:string)=>format.endsWith('p')?format.slice(0,-1):format;

it('reproduces native sample-format negotiation for native format lists, or refuses explicitly',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-audio-negotiation-'));
 const tally={accepted:0,refused:0,exact:0},refusals=new Map<string,number>(),singles:string[]=[];
 try{
  writeFileSync(join(root,'in.raw'),Uint8Array.from({length:512},(_,index)=>(index*73+37)&255));
  const cases=chains.flatMap((chain,index)=>outputs.map((output,slot)=>({chain,output,label:`c${index}o${slot}`})));
  for(const [raw,input]of inputs)for(const trim of [false,true])for(let start=0;start<cases.length;start+=100){
   // One complex graph runs in one filter thread, so log lines never interleave; each case reads its own input, so no format list is shared between cases.
   // Labelled ashowinfo instances report the format each step works in; ashowinfo accepts every format, so it never changes the merges.
   const batch=cases.slice(start,start+100),args=['-hide_banner','-nostats','-v','info'],graph:string[]=[],maps:string[]=[];
   for(const [index,{chain:[,steps],output,label}]of batch.entries()){
    args.push('-f',raw,'-ar','8000','-ch_layout','stereo',...(trim?['-t','1']:[]),'-i',join(root,'in.raw'));
    graph.push(`[${index}:a]${[`ashowinfo@${label}s0`,...steps.flatMap((step,position)=>[step,`ashowinfo@${label}s${position+1}`])].join(',')}[${label}]`);
    maps.push('-map',`[${label}]`,...(output.remix?['-ac','1']:[]),'-f',output.format,'-y','/dev/null');
   }
   const run=spawnSync(native,[...args,'-filter_complex',graph.join(';'),...maps],{encoding:'utf8',maxBuffer:1<<28});
   expect(run.status,run.stderr.slice(-2000)).toBe(0);
   const seen=new Map<string,string>();
   for(const match of run.stderr.matchAll(/\[ashowinfo@(\S+) @ [^\]]+\] n:\d+ .*? fmt:(\w+) /g))if(!seen.has(match[1]!))seen.set(match[1]!,match[2]!);
   for(const {chain:[steps],output,label}of batch){
    const expected=steps.map((_,index)=>seen.get(`${label}s${index+1}`));
    expect(expected.every(format=>format!==undefined),`${label} ${steps.join(',')}`).toBe(true);
    let ours:readonly AudioSampleFormat[];
    const chain=compileAudioFilterChain(steps.join(','),{outputSampleFormat:output.remix?'flt':encoders[output.format]!,outputConversion:output.remix});
    try{ours=chain.negotiatedSampleFormats(input);}
    catch(error){
     expect(error,`${raw} ${steps.join(',')} ${output.format}`).toBeInstanceOf(AudioFilterError);
     const message=(error as Error).message.replace(/^n/,'').replace(/ with \w+ input/,' with <input>');
     refusals.set(message,(refusals.get(message)??0)+1);if(!trim&&!output.remix&&steps.length===1)singles.push(`${steps[0]} ${input}`);tally.refused++;continue;
    }
    // Transparent steps ('all' sets and adelay, which only copies samples) may sit on either side of a converter; every other step must work in the native sample type.
    const description=`${raw} trim=${trim} ${steps.join(',')} -> ${output.format}${output.remix?' -ac 1':''}`;
    steps.forEach((step,index)=>{if(!['anull','asetnsamples=7','apad=pad_len=3','adelay=2S'].includes(step))expect(base(ours[index]!),`${description} step ${index}: ${ours.join(',')} vs ${expected.join(',')}`).toBe(base(expected[index]!));});
    tally.accepted++;if(steps.every((step,index)=>!step.startsWith('n')||ours[index]===expected[index]))tally.exact++;
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(tally.accepted+tally.refused).toBe(chains.length*outputs.length*inputs.length*2);
 // Pinned build: 18,038 cases match native in every non-transparent step (17,855 also in planarity); the rest refuse before any output.
 expect(tally).toEqual({accepted:18038,refused:932,exact:17855});
 expect([...refusals.keys()].every(message=>/^\w+ with <input> (requires unimplemented format negotiation|negotiates s64p, which is not implemented)$/.test(message))).toBe(true);
 expect(refusals.get('channelmap with <input> negotiates s64p, which is not implemented')).toBe(308);
 // Alone, every list negotiates natively except channelmap on double input, where native picks s64p.
 expect(singles).toEqual(Array(5).fill('nchannelmap dbl'));
},600000);
