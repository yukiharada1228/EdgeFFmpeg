import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {convertAudioFrame,createAudioResampleState,deserializeAudioResampleCheckpoint,resampleAudio,serializeAudioResampleCheckpoint} from '@edge-ffmpeg/swresample';
import type {AudioResampleOptions,AudioSampleFormat,ResampleSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const native=resolve('.build/reference/ffmpeg'),raw={s16:'s16le',flt:'f32le',dbl:'f64le'} as const,widths={s16:2,flt:4,dbl:8} as const,partition=[37,1,64,2,63,64,64,64,64,41];
const samples=partition.reduce((sum,count)=>sum+count,0);
type Case={readonly inputRate:number;readonly outputRate:number;readonly channels:number;readonly format:ResampleSampleFormat;readonly internal:ResampleSampleFormat;readonly planar?:boolean};
function fixture(format:ResampleSampleFormat,channels:number):Buffer{
 const bytes=Buffer.alloc(samples*channels*widths[format]);
 for(let i=0;i<samples*channels;i++){const value=.6*(Math.sin(i*.123)+.3*Math.cos(i*.49));if(format==='s16')bytes.writeInt16LE((i*3137)%65536-32768,i*2);else if(format==='flt')bytes.writeFloatLE(value,i*4);else bytes.writeDoubleLE(value,i*8);}
 return bytes;
}
function reference(c:Case,input:Buffer,tsf:string){return execFileSync(native,['-v','error','-cpuflags','0','-f',raw[c.format],'-ar',String(c.inputRate),'-ac',String(c.channels),'-i','pipe:0','-af',`aresample=${c.outputRate}${tsf}`,'-f',raw[c.format],'-'],{input,maxBuffer:1<<24});}
/** Library frames in the FIR precision, packed or planar, at sample origin zero. */
function frames(c:Case,input:Buffer):AudioFrameData[]{
 const align=c.channels*widths[c.format],limit={maxFrameBytes:1<<20};let start=0;
 return partition.map(count=>{const frame:AudioFrameData={sampleRate:c.inputRate,channels:c.channels,channelLayout:c.channels===1?'mono':'stereo',sampleFormat:c.format,samples:count,planes:[new Uint8Array(input.subarray(start*align,(start+count)*align))],pts:{value:BigInt(start),timeBase:{num:1n,den:BigInt(c.inputRate)}}};start+=count;return convertAudioFrame(frame,`${c.internal}${c.planar?'p':''}` as AudioSampleFormat,limit);});
}
const options=(c:Case):AudioResampleOptions=>({maxFrameBytes:64*c.channels*widths[c.internal],maxStateBytes:1<<20});
/** Executes input frames then one-frame EOF tail steps, moving serialized state into a fresh object at each selected step. */
function split(c:Case,input:AudioFrameData[],at:(step:number)=>boolean){
 const limits=options(c);let state=createAudioResampleState(c.outputRate,limits),step=0;const output:AudioFrameData[]=[];
 const handoff=()=>{if(at(step)){const bytes=serializeAudioResampleCheckpoint(state.checkpoint(),limits);state.dispose();state=createAudioResampleState(c.outputRate,limits,deserializeAudioResampleCheckpoint(bytes,limits));}step++;};
 handoff();for(const frame of input){output.push(...state.push(frame));handoff();}
 while(!state.finished){output.push(...state.finish(1));handoff();}state.dispose();return {output,steps:step};
}
async function uninterrupted(c:Case,input:AudioFrameData[]){async function* source(){yield*input;}const output:AudioFrameData[]=[];for await(const frame of resampleAudio(source(),c.outputRate,options(c)))output.push(frame);return output;}
const encoded=(c:Case,output:AudioFrameData[])=>Buffer.concat(output.map(frame=>Buffer.from(convertAudioFrame(frame,c.format,{maxFrameBytes:1<<20}).planes[0]!)));
const timing=(output:AudioFrameData[])=>output.map(frame=>[frame.samples,frame.pts?.value,frame.pts?.timeBase.den]);
/** Every single-boundary handoff and one fully chained run; returns the common encoded stream after checking frame sizes and PTS. */
async function handoffs(c:Case,input:AudioFrameData[]){
 const reference=await uninterrupted(c,input),bytes=encoded(c,reference),{steps}=split(c,input,()=>false);let position=0n;
 for(const frame of reference){expect(frame.pts).toEqual({value:position,timeBase:{num:1n,den:BigInt(c.outputRate)}});position+=BigInt(frame.samples);}
 expect(steps).toBeGreaterThan(partition.length+1);
 for(let boundary=-1;boundary<steps;boundary++){const {output}=split(c,input,boundary<0?()=>true:step=>step===boundary);expect(timing(output),`${c.inputRate}->${c.outputRate}/${boundary}`).toEqual(timing(reference));expect(encoded(c,output).equals(bytes),`${c.inputRate}->${c.outputRate}/${boundary}`).toBe(true);}
 return bytes;
}
it('matches forced native signed16 aresample byte for byte after serialized handoff at every input and tail boundary',async()=>{
 for(const [inputRate,outputRate]of [[8000,44100],[44100,48000],[48000,8000],[44100,22050],[44100,48001],[48001,44100]] as const)for(const channels of [1,2])for(const planar of [false,true]){
  const c:Case={inputRate,outputRate,channels,format:'s16',internal:'s16',planar},input=fixture('s16',channels),expected=reference(c,input,':tsf=s16p');
  expect((await handoffs(c,frames(c,input))).equals(expected),`${inputRate}->${outputRate}/${channels}/${planar}`).toBe(true);
 }
},120000);
it('matches default native aresample byte for byte across handoffs for the recorded exact float-path fixtures',async()=>{
 // Default s16-to-s16 resampling runs the float FIR; these fixtures are byte-identical, not a general float bit-exactness claim.
 const exact:Case[]=[[8000,44100],[44100,48000],[48000,8000],[8000,16000]].flatMap(([inputRate,outputRate])=>[1,2].map(channels=>({inputRate:inputRate!,outputRate:outputRate!,channels,format:'flt' as const,internal:'flt' as const})));
 exact.push(...[[8000,44100],[44100,48000],[48000,8000],[44100,22050],[48001,44100]].flatMap(([inputRate,outputRate])=>[1,2].map(channels=>({inputRate:inputRate!,outputRate:outputRate!,channels,format:'s16' as const,internal:'flt' as const,planar:true}))));
 for(const c of exact){const input=fixture(c.format,c.channels);expect((await handoffs(c,frames(c,input))).equals(reference(c,input,'')),`${c.format}/${c.inputRate}->${c.outputRate}/${c.channels}`).toBe(true);}
},120000);
it('keeps double and interpolating float handoffs identical to uninterrupted runs and within the recorded native tolerance',async()=>{
 const cases:Case[]=[...[[8000,44100],[44100,48000],[48000,8000],[44100,22050],[44100,48001]].map(([inputRate,outputRate])=>({inputRate:inputRate!,outputRate:outputRate!,channels:2,format:'dbl' as const,internal:'dbl' as const})),...[[44100,48001],[48001,44100]].map(([inputRate,outputRate])=>({inputRate:inputRate!,outputRate:outputRate!,channels:2,format:'flt' as const,internal:'flt' as const,planar:true}))];
 for(const c of cases){
  const input=fixture(c.format,c.channels),expected=reference(c,input,''),actual=await handoffs(c,frames(c,input)),width=widths[c.format],tolerance=c.format==='dbl'?2e-12:1e-6;expect(actual.length).toBe(expected.length);
  for(let i=0;i<actual.length;i+=width)expect(Math.abs((width===8?actual.readDoubleLE(i)-expected.readDoubleLE(i):actual.readFloatLE(i)-expected.readFloatLE(i))),`${c.format}/${c.inputRate}->${c.outputRate}/${i/width}`).toBeLessThanOrEqual(tolerance);
 }
},120000);
