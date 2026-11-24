import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {referenceRemixArithmetic} from '../helpers/remix-profile.js';
const native=resolve('.build/reference/ffmpeg'),module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm')),remixArithmetic=referenceRemixArithmetic();
/** Deterministic FLAC input from the pinned build: every byte pattern of s16 or 24-bit-in-s32 PCM. Native warns that FLAC cannot store the three-channel layout. */
function flac(channels:number,bits:16|24,samples:number):Uint8Array {
  const width=bits===16?2:4,data=new Uint8Array(samples*channels*width);
  for(let i=0;i<data.length;i++)data[i]=width===4&&i%4===0?0:(i*73+37)&255;
  return execFileSync(native,['-v','error','-f',bits===16?'s16le':'s32le','-ar','8000','-ac',String(channels),'-i','-','-c:a','flac','-sample_fmt',bits===16?'s16':'s32','-bits_per_raw_sample',String(bits),'-f','flac','-'],{input:data,stdio:['pipe','pipe','ignore']});
}
async function run(input:Uint8Array,args:readonly string[],resident=1<<26,buffer=65536){
  const chunks:Uint8Array[]=[];let opens=0,commits=0,aborts=0;
  const frontend=new FFmpeg({backend:createMediaBackend({remixArithmetic,flac:{module}}),budget:{maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:8,maxCpuTimeMs:30000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
  const result=await frontend.exec(['-cpuflags','0','-i','/in.flac',...args]);
  return {result,bytes:Buffer.concat(chunks),opens,commits,aborts};
}
it('matches native untimed FLAC adelay output across channel counts, bit depths, chains and output formats',async()=>{
  const chains=['adelay=10S|300S','adelay=700S|1300S|3S','adelay=2100S|30S:all=1','adelay=delays=2|0.5:all=true','adelay=0S|0S','asetnsamples=500,adelay=9S|602S','adelay=9S|2S,apad=pad_len=2500','volume=0.5:precision=fixed,adelay=4S|1S','aformat=s32p,adelay=3S|700S,volume=0.25'];
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-flac-adelay-'));let checked=0;
  try{
    for(const channels of [1,2,3])for(const bits of [16,24] as const){
      const input=flac(channels,bits,2600);writeFileSync(join(root,'in.flac'),input);
      // Three-channel framecrc is left out: its layout name differs from native even without filters (2.1 versus 3 channels (FL+FR+LFE)).
      for(const chain of chains)for(const output of [['-c:a','pcm_s16le','-f','s16le'],['-c:a','pcm_s32le','-f','s32le'],['-c:a','pcm_s24le','-bitexact','-f','wav'],...(channels<3?[['-c:a','pcm_s16le','-bitexact','-f','framecrc']]:[])]){
        const reference=join(root,`${checked}.out`);execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(root,'in.flac'),'-af',chain,...output,reference]);
        const actual=await run(input,['-af',chain,...output,'/out']),id=JSON.stringify({channels,bits,chain,output,diagnostics:actual.result.diagnostics});
        expect(actual.result.exitCode,id).toBe(0);expect({opens:actual.opens,commits:actual.commits,aborts:actual.aborts},id).toEqual({opens:1,commits:1,aborts:0});
        expect(createHash('sha256').update(actual.bytes).digest('hex'),id).toBe(createHash('sha256').update(readFileSync(reference)).digest('hex'));
        checked++;
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(checked).toBe(198);
},600000);
it('matches native untimed FLAC adelay output with mono/stereo channel conversion',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-flac-adelay-ac-'));let checked=0;
  try{
    for(const [channels,target] of [[1,2],[2,1]] as const)for(const bits of [16,24] as const){
      const input=flac(channels,bits,2600);writeFileSync(join(root,'in.flac'),input);
      for(const chain of ['adelay=10S|300S','adelay=2100S|30S:all=1','asetnsamples=500,adelay=9S|602S','volume=0.5,adelay=4S'])for(const output of [['-c:a','pcm_s16le','-f','s16le'],['-c:a','pcm_f32le','-f','f32le']]){
        const args=['-af',chain,'-ac',String(target),...output],reference=join(root,`${checked}.out`);execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(root,'in.flac'),...args,reference]);
        const actual=await run(input,[...args,'/out']),id=JSON.stringify({channels,target,bits,chain,output,diagnostics:actual.result.diagnostics});
        expect(actual.result.exitCode,id).toBe(0);expect(actual.commits,id).toBe(1);
        expect(createHash('sha256').update(actual.bytes).digest('hex'),id).toBe(createHash('sha256').update(readFileSync(reference)).digest('hex'));
        checked++;
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(checked).toBe(32);
},300000);
it('reserves exactly one adelay output frame plus its delay rings on the untimed FLAC CLI path',async()=>{
  // The smallest resident budget that completes, found by bisection: decoder, encoder and writer costs cancel in the differences.
  const input=flac(2,16,2600),args=(chain:string)=>['-af',chain,'-c:a','pcm_s16le','-f','s16le','/out'];
  const minimum=async(chain:string,buffer:number)=>{let low=1,high=1<<26;while(low<high){const middle=Math.floor((low+high)/2);if((await run(input,args(chain),middle,buffer)).result.exitCode===0)high=middle;else low=middle+1;}return low;};
  for(const buffer of [65536,16384]){
    const frame=await minimum('volume=0.5',buffer),silent=await minimum('adelay=0S|0S',buffer);
    // An adelay with equal delays holds one output frame and no ring, exactly like one allocating stateless step.
    expect(silent,`${buffer}`).toBe(frame);
    for(const [chain,ring] of [['adelay=0S|2000S',4000],['adelay=7S|1007S',2000],['adelay=300S|0S',600]] as const)expect(await minimum(chain,buffer)-silent,`${buffer} ${chain}`).toBe(ring);
    // One byte short of the reservation fails explicitly and publishes nothing.
    const short=await run(input,args('adelay=0S|2000S'),silent+3999,buffer);
    expect(short.result.exitCode).not.toBe(0);expect(short.result.diagnostics[0],JSON.stringify(short.result.diagnostics)).toMatchObject({code:'execution-failed',message:'Memory budget exceeded'});expect({commits:short.commits,bytes:short.bytes.length}).toEqual({commits:0,bytes:0});
  }
},300000);
