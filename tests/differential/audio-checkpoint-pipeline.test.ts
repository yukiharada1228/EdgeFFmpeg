import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {audioCheckpointPipelinePatches,createAudioCheckpointPipeline,deserializeAudioCheckpointPipeline} from '@edge-ffmpeg/avformat';
import type {AudioCheckpointPipelineConfig,AudioCheckpointPipelinePosition,AudioCheckpointPipelineSnapshot,AudioCheckpointPipelineStage} from '@edge-ffmpeg/avformat';
import type {ResampleSampleFormat} from '@edge-ffmpeg/swresample';
import {memoryInput} from '../helpers/wav.js';
type Codec='pcm_s16le'|'pcm_f32le'|'pcm_f64le';
type Profile=readonly [Codec,ResampleSampleFormat,Codec];
type Case={readonly inputRate:number;readonly outputRate:number;readonly channels:number;readonly input:Codec;readonly precision:ResampleSampleFormat;readonly codec:Codec;readonly stage:AudioCheckpointPipelineStage;readonly samples:number;readonly unitSamples:number;readonly tight:boolean;readonly bitexact:boolean};
const native=resolve('.build/reference/ffmpeg'),raw={pcm_s16le:'s16le',pcm_f32le:'f32le',pcm_f64le:'f64le'} as const,widths={pcm_s16le:2,pcm_f32le:4,pcm_f64le:8} as const,precisionWidths={s16:2,flt:4,dbl:8} as const;
const rates=[[8000,11025],[44100,48000],[48000,8000],[22050,44100],[44100,48001],[48001,44100],[8000,8000],[44100,44100]] as const;
// Packet sizes only chunk the silence; native's apad packets differ, and neither changes WAV bytes. Every packet fits a tight frame.
const stages:readonly AudioCheckpointPipelineStage[]=[{filter:'asetnsamples',samples:7,pad:true},{filter:'asetnsamples',samples:5,pad:false},{filter:'apad',mode:'pad_len',limit:'37',packetSamples:64,packetsPerUnit:1},{filter:'apad',mode:'whole_len',limit:'900',packetSamples:16,packetsPerUnit:2},{filter:'apad',mode:'pad_dur',limit:'4000',packetSamples:8,packetsPerUnit:3},{filter:'apad',mode:'whole_dur',limit:'10000',packetSamples:12,packetsPerUnit:4}];
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,interpolates=(c:Case)=>c.inputRate!==c.outputRate&&c.outputRate/gcd(c.inputRate,c.outputRate)>1024;
const filter=(stage:AudioCheckpointPipelineStage)=>stage.filter==='asetnsamples'?`asetnsamples=n=${stage.samples}:p=${Number(stage.pad)}`:`apad=${stage.mode}=${stage.mode.endsWith('_dur')?String(Number(stage.limit)/1e6):stage.limit}`;
// 4096-byte frames keep a short input's whole resampled output pending until EOF; tight frames (at least 40 samples, one unit)
// move samples through the resampler, FIFO, apad and mux every few units, so restores land on states that hold samples.
const widest=(c:Case)=>Math.max(widths[c.input],precisionWidths[c.precision],widths[c.codec]);
const configOf=(c:Case):AudioCheckpointPipelineConfig=>({outputRate:c.outputRate,precision:c.precision,codec:c.codec,bitexact:c.bitexact,stage:c.stage,unitSamples:c.unitSamples,limits:{maxFrameBytes:c.tight?c.channels*widest(c)*Math.max(c.unitSamples,40):4096,maxStateBytes:1<<20,maxReadBytes:4096,maxUnitBytes:65536,maxUnits:256}});
const label=(c:Case)=>`${c.input}/${c.precision}/${c.codec} ${c.inputRate}->${c.outputRate} ch=${c.channels} n=${c.samples} unit=${c.unitSamples}${c.tight?' tight':''} ${filter(c.stage)}${c.bitexact?' bitexact':''}`;
function samples(c:Case):Buffer{
 const bytes=Buffer.alloc(c.samples*c.channels*widths[c.input]);
 for(let i=0;i<c.samples;i++)for(let k=0;k<c.channels;k++){const at=i*c.channels+k,value=.6*Math.sin(i*.0731*(k+1))+.3*Math.cos(i*.53+k);if(c.input==='pcm_s16le')bytes.writeInt16LE(((at*3137+k*911)%65536)-32768,at*2);else if(c.input==='pcm_f32le')bytes.writeFloatLE(value,at*4);else bytes.writeDoubleLE(value,at*8);}
 return bytes;
}
/** Native-written input WAV (`written` are its extra muxer options), then the pinned native command the pipeline continues: aresample
 * (tsf when it differs from native's default internal format, and always without a rate change, where native ignores it), the stage, the WAV codec. */
function reference(directory:string,c:Case,written:readonly string[]=['-bitexact']):{input:Buffer;output:Buffer}{
 writeFileSync(join(directory,'in.raw'),samples(c));execFileSync(native,['-v','error','-y','-f',raw[c.input],'-ar',String(c.inputRate),'-ac',String(c.channels),'-i',join(directory,'in.raw'),'-c:a',c.input,...written,join(directory,'in.wav')]);
 const tsf=c.inputRate===c.outputRate||c.precision!==(c.input==='pcm_f64le'?'dbl':'flt')?`:tsf=${c.precision}p`:'';
 execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(directory,'in.wav'),'-af',`aresample=${c.outputRate}${tsf},${filter(c.stage)}`,'-c:a',c.codec,...(c.bitexact?['-bitexact']:[]),join(directory,'out.wav')],{timeout:15000,stdio:'pipe'});
 return {input:readFileSync(join(directory,'in.wav')),output:readFileSync(join(directory,'out.wav'))};
}
/** Drives units as the runner does; `restore(k)` moves the serialized state into a fresh component (a fresh Worker) after unit k. */
async function run(c:Case,file:Buffer,restore:(unit:number)=>boolean){
 const config=configOf(c),make=()=>createAudioCheckpointPipeline(config,memoryInput(new Uint8Array(file)));let component=make(),state=await component.create(),position:AudioCheckpointPipelinePosition={revision:0,inputPosition:'0',outputPosition:'0'},saved:Uint8Array|null=null;const chunks:Uint8Array[]=[],states:AudioCheckpointPipelineSnapshot[]=[];
 for(let unit=0;;unit++){
  const result=await component.process(state,position,undefined);if(result.output)chunks.push(result.output);
  position={revision:position.revision+1,inputPosition:result.inputPosition,outputPosition:String(BigInt(position.outputPosition)+BigInt(result.output?.length??0))};
  if(!component.verify(state,position))throw Error('Pipeline counters disagree with the journal position');saved=component.serialize(state);states.push(deserializeAudioCheckpointPipeline(saved,config));
  if(restore(unit)){component.dispose(state);component=make();state=await component.restore(saved,position);if(!component.verify(state,position))throw Error('Restored pipeline disagrees with the journal position');}
  if(result.finished)break;
 }
 component.dispose(state);const output=Buffer.concat(chunks);for(const patch of audioCheckpointPipelinePatches(saved!,BigInt(output.length),config))output.set(patch.bytes,Number(patch.offset));
 return {output,units:position.revision,states,header:states.at(-1)!.mux.layout.headerBytes};
}
/** Sample count and unit size rotate on periods 7 and 5 (coprime with the six stages); frame size and -bitexact alternate per block
 * of 6 and 12 cases, so every stage meets every sample count, unit size, frame size and -bitexact. */
function* matrix(profiles:(bypass:boolean)=>readonly Profile[],keep:(c:Case)=>boolean):Generator<Case>{
 let index=0;
 for(const [inputRate,outputRate]of rates)for(const channels of [1,2,3])for(const [input,precision,codec]of profiles(inputRate===outputRate))for(const stage of stages){
  index++;const c:Case={inputRate,outputRate,channels,input,precision,codec,stage,samples:[301,1,33,120,2,173,250][index%7]!,unitSamples:[13,29,64,4,7][index%5]!,tight:Math.floor(index/6)%2===1,bitexact:Math.floor(index/12)%2===0};
  if(keep(c))yield c;
 }
}
const stageKey=(stage:AudioCheckpointPipelineStage)=>filter(stage).split('=')[0]+(stage.filter==='apad'?stage.mode:String(stage.pad));
/** Every stage met all 7 sample counts, all 5 unit sizes, both frame sizes and both -bitexact settings. */
function coverage(cases:readonly Case[]):void{
 for(const stage of stages){const mine=cases.filter(c=>c.stage===stage);expect([new Set(mine.map(c=>c.samples)).size,new Set(mine.map(c=>c.unitSamples)).size,new Set(mine.map(c=>c.tight)).size,new Set(mine.map(c=>c.bitexact)).size],stageKey(stage)).toEqual([7,5,2,2]);}
}
it('matches pinned native aresample/asetnsamples/apad into WAV byte for byte after a serialized restore at every unit boundary, for the s16 FIR, the recorded non-interpolating float s16 and f32 fixtures, and every format pair without a rate change',async()=>{
 expect(createHash('sha256').update(readFileSync(native)).digest('hex')).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const directory=mkdtempSync(join(tmpdir(),'edge-audio-checkpoint-pipeline-')),checked:Case[]=[],seen=new Set<string>();let held=0;
 const fir:Profile[]=[['pcm_s16le','s16','pcm_s16le'],['pcm_f32le','s16','pcm_s16le'],['pcm_s16le','flt','pcm_s16le'],['pcm_f32le','flt','pcm_f32le']];
 // Without a rate change native's full_convert ignores tsf: all nine input/output pairs, mostly with a precision narrower than one of them.
 const bypass:Profile[]=[['pcm_s16le','dbl','pcm_s16le'],['pcm_s16le','s16','pcm_f32le'],['pcm_s16le','flt','pcm_f64le'],['pcm_f32le','dbl','pcm_s16le'],['pcm_f32le','s16','pcm_f32le'],['pcm_f32le','s16','pcm_f64le'],['pcm_f64le','flt','pcm_s16le'],['pcm_f64le','s16','pcm_f32le'],['pcm_f64le','flt','pcm_f64le'],['pcm_f64le','s16','pcm_f64le']];
 try{
  for(const c of matrix(equal=>equal?bypass:fir,c=>c.inputRate===c.outputRate||c.precision==='s16'||!interpolates(c))){
   const {input,output}=reference(directory,c),whole=await run(c,input,()=>false),chained=await run(c,input,()=>true);
   expect(chained.output.equals(whole.output),label(c)).toBe(true);expect(whole.output.equals(output),label(c)).toBe(true);expect(whole.units).toBe(chained.units);
   if(whole.states.some(state=>!state.mux.finished&&BigInt(state.mux.samples)>0n))held++;
   checked.push(c);seen.add(`${c.inputRate}->${c.outputRate}`).add('ch'+c.channels).add(c.input+'/'+c.precision+'/'+c.codec).add(stageKey(c.stage));
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
 // s16 FIR on 6 rate-changing pairs, float on the 4 non-interpolating ones, 10 format profiles on 2 equal-rate pairs.
 expect(checked.length).toBe(6*3*6*2+4*3*6*2+2*3*6*10);expect(seen.size).toBe(8+3+4+10+6);coverage(checked);expect(held).toBeGreaterThan(checked.length/4);
},600000);
it('resumes at every single unit boundary and once fully chained with output identical to pinned native, with samples held in the resampler, the stage and the mux at those boundaries',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-audio-checkpoint-pipeline-'));
 try{
  const cases:Case[]=[
   {inputRate:44100,outputRate:48000,channels:2,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'asetnsamples',samples:33,pad:true},samples:700,unitSamples:29,tight:true,bitexact:false},
   {inputRate:48000,outputRate:8000,channels:1,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'apad',mode:'pad_len',limit:'77',packetSamples:10,packetsPerUnit:2},samples:500,unitSamples:37,tight:true,bitexact:true},
   {inputRate:8000,outputRate:11025,channels:3,input:'pcm_f32le',precision:'flt',codec:'pcm_f32le',stage:{filter:'asetnsamples',samples:7,pad:false},samples:211,unitSamples:16,tight:true,bitexact:false},
  ];
  for(const c of cases){
   const {input,output}=reference(directory,c),whole=await run(c,input,()=>false);expect(whole.output.equals(output),label(c)).toBe(true);expect(whole.units).toBeGreaterThan(12);
   // Mid-stream boundaries hold a pending resampler frame, samples already in the mux and, for the FIFO, a partial frame.
   const open=whole.states.filter(state=>!state.mux.finished);
   expect(open.some(state=>state.resample.pending.length>0),label(c)).toBe(true);expect(open.some(state=>BigInt(state.mux.samples)>0n&&!state.resample.eof),label(c)).toBe(true);
   expect(open.some(state=>state.stage.filter==='asetnsamples'?state.stage.checkpoint.filled>0:BigInt(state.stage.checkpoint.received)>0n&&!state.stage.checkpoint.eof),label(c)).toBe(true);
   for(let boundary=0;boundary<whole.units;boundary++)expect((await run(c,input,unit=>unit===boundary)).output.equals(output),label(c)+' boundary '+boundary).toBe(true);
   expect((await run(c,input,()=>true)).output.equals(output),label(c)+' chained').toBe(true);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
},300000);
it('keeps double, interpolating float and s16-to-f32 float continuations identical to uninterrupted runs and within the recorded native tolerance',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-audio-checkpoint-pipeline-')),checked:Case[]=[];let exact=0;
 try{
  const profiles:Profile[]=[['pcm_f64le','dbl','pcm_f64le'],['pcm_f32le','flt','pcm_f32le'],['pcm_s16le','flt','pcm_s16le'],['pcm_s16le','flt','pcm_f32le']];
  for(const c of matrix(equal=>equal?[]:profiles,c=>c.precision==='dbl'||c.codec!==c.input||interpolates(c))){
   const {input,output}=reference(directory,c),whole=await run(c,input,()=>false),chained=await run(c,input,()=>true);
   expect(chained.output.equals(whole.output),label(c)).toBe(true);expect(whole.output.length).toBe(output.length);expect(whole.output.subarray(0,whole.header).equals(output.subarray(0,whole.header)),label(c)).toBe(true);
   const width=widths[c.codec],tolerance=c.codec==='pcm_f64le'?2e-12:c.codec==='pcm_f32le'?1e-6:1;
   for(let at=whole.header;at+width<=output.length;at+=width){const a=width===8?whole.output.readDoubleLE(at):width===4?whole.output.readFloatLE(at):whole.output.readInt16LE(at),b=width===8?output.readDoubleLE(at):width===4?output.readFloatLE(at):output.readInt16LE(at);expect(Math.abs(a-b),label(c)+' byte '+at).toBeLessThanOrEqual(tolerance);}
   checked.push(c);if(whole.output.equals(output))exact++;
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
 // Double and s16-to-f32 float run on the six rate-changing pairs, interpolating float on two; byte identity there is not claimed.
 expect(checked.length).toBe(6*3*6*2+2*3*2*6);coverage(checked);expect(exact).toBeLessThan(checked.length);
},600000);
it('rejects input WAV tags native copies into the output and matches native for inputs whose only tag is the encoder',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-audio-checkpoint-pipeline-'));
 try{
  const base:Case={inputRate:44100,outputRate:48000,channels:2,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'asetnsamples',samples:64,pad:true},samples:301,unitSamples:29,tight:false,bitexact:true};
  // Native's own non-bitexact WAV carries LIST/INFO ISFT=Lavf...; the muxer replaces or drops `encoder`, so the output is unchanged.
  for(const bitexact of [true,false]){
   const c={...base,bitexact},{input,output}=reference(directory,c,[]);expect(input.includes('ISFT')).toBe(true);
   expect((await run(c,input,()=>true)).output.equals(output),label(c)+' ISFT input').toBe(true);
  }
  // LIST/INFO and bext tags reach native's output INFO list, so the pipeline refuses those inputs instead of dropping them.
  for(const [written,tag,error]of [[['-metadata','title=Hello','-metadata','artist=Someone','-bitexact'],'INAM',/metadata "I[A-Z]{3}" is not implemented/],[['-write_bext','1','-metadata','description=Desc','-bitexact'],'ICMT',/"bext" chunk is not implemented/]] as const){
   for(const bitexact of [true,false]){
    const c={...base,bitexact},{input,output}=reference(directory,c,written);expect(output.includes(tag),label(c)+' '+tag).toBe(true);
    await expect(createAudioCheckpointPipeline(configOf(c),memoryInput(new Uint8Array(input))).create(),label(c)).rejects.toThrow(error);
   }
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
},120000);
