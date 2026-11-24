import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
/** Every float intermediate is rounded as in the unfused Linux x64 build; macOS arm64 contracts m*(l-avg)+avg into an FMA (scout: 7562/10000 unfused matches there). */
const unfused=process.platform==='linux'&&process.arch==='x64';
/** Deterministic stereo PCM: leading zero, negative-zero, opposite-sign and equal pairs, then every byte pattern (integers) or finite values in [-1.5,1.5] (floats). */
function pcm(width:number,floating:boolean,frames:number):Uint8Array {
  const data=new Uint8Array(frames*2*width),view=new DataView(data.buffer);
  const fixed=[[0,0],[-0,-0],[0,-0],[0.5,-0.5],[-0.25,0.25],[1,-1],[-1,1],[0.75,0.75],[-1,-1],[1,1],[0.3,-0.1],[1.5,-1.5],[1e-30,-1e-30],[0.999,-0.998]];
  const write=(index:number,value:number)=>{
    if(width===4&&floating)view.setFloat32(index*4,value,true);else if(width===8)view.setFloat64(index*8,value,true);
    else{const scale=width===1?128:width===2?32768:2147483648,clamped=Math.max(-scale,Math.min(scale-1,Math.round(Math.max(-1,Math.min(1,value))*scale)));if(width===1)view.setUint8(index,clamped+128);else if(width===2)view.setInt16(index*2,clamped,true);else view.setInt32(index*4,clamped,true);}
  };
  for(let frame=0;frame<frames;frame++){
    const pair=fixed[frame];
    if(pair){write(frame*2,pair[0]!);write(frame*2+1,pair[1]!);continue;}
    for(let channel=0;channel<2;channel++){const index=frame*2+channel;if(!floating)for(let b=0;b<width;b++)view.setUint8(index*width+b,(index*73+b*151+37)&255);else write(index,Math.sin(index*0.731)*1.5*((index%13)/12)*(frame%5===0&&channel===1?-1:1));}
  }
  return data;
}
async function harness(prefix:string,budget=65536){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}})};
}
it.skipIf(!unfused)('matches native extrastereo bytes for stereo sources, every m and clip setting, raw, WAV and framecrc outputs (Linux x64 unfused float)',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-extrastereo-');
  // Raw f32le and s16le, WAV pcm_f32le/pcm_s16le and framecrc; float-to-integer conversion runs the scalar path (-cpuflags 0) on both sides.
  const outputs=[['-f','f32le'],['-f','s16le'],['-c:a','pcm_f32le','-f','wav'],['-c:a','pcm_s16le','-f','wav'],['-c:a','pcm_f32le','-f','framecrc'],['-c:a','pcm_s16le','-f','framecrc']];
  let compared=0;
  try{
    let index=0;
    for(const [raw,width]of formats){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1500));
      for(const m of ['-10','-1','0','1','2.5','10'])for(const c of ['0','1'])for(const output of outputs){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],after=['-af',`extrastereo=m=${m}:c=${c}`,...output,'-bitexact'];
        // Native writes a seekable file, so WAV sizes are patched in its header as in ours.
        const reference=join(root,'native.out');execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-y',reference]);const expected=readFileSync(reference);
        const out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${raw} m=${m} c=${c} ${output.join(' ')}`;
        expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);compared++;
      }
    }
    expect(compared).toBe(360);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it.skipIf(!unfused)('matches native extrastereo framecrc in composed chains, frame splits, defaults and output time selection (Linux x64 unfused float)',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-extrastereo-chain-');
  const chains=['extrastereo','extrastereo=0.5','extrastereo=-3.3:false','asetnsamples=7,extrastereo=2','extrastereo,asetnsamples=n=100:p=0','asetnsamples=1,extrastereo=m=9.99:c=0','extrastereo=m=1.5,extrastereo=m=-0.7:c=0','apad=pad_len=9,extrastereo=c=0','anull,extrastereo=m=4:c=true,anull','asetrate=16000,extrastereo'];
  const selections=[[],['-ss','0.01'],['-t','0.05'],['-frames:a','3'],['-ss','0.02','-t','0.03']];
  let compared=0;
  try{
    let index=0;
    for(const [raw,width]of [formats[1],formats[3]] as const){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1100));
      for(const chain of chains)for(const selection of selections)for(const codec of ['pcm_f32le','pcm_s16le']){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],after=['-af',chain,...selection,'-c:a',codec,'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']);
        const out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${raw} ${chain} ${selection.join(' ')} ${codec}`;
        expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).toString(),label).toBe(expected.toString());compared++;
      }
    }
    expect(compared).toBe(200);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses layouts native would remix and unimplemented options before output, recording native status',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-extrastereo-errors-');
  try{
    let index=0;
    const run=async(channels:number,filter:string)=>{
      writeFileSync(join(root,`in${channels}.raw`),pcm(2,false,64*channels).slice(0,64*channels*2));
      const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac',String(channels)],after=['-af',filter,'-c:a','pcm_s16le','-f','framecrc'],out=`/${index++}.crc`;
      const result=await frontend.exec([...before,'-i',`/in${channels}.raw`,...after,out]);
      return {result,written:existsSync(join(root,out.slice(1))),nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,`in${channels}.raw`),...after,'-']).status};
    };
    // Native remixes mono and three-channel input to stereo implicitly; the chain refuses instead of approximating the remix.
    for(const channels of [1,3]){
      const {result,written,nativeStatus}=await run(channels,'extrastereo');
      expect(nativeStatus,String(channels)).toBe(0);expect(result.exitCode).not.toBe(0);expect(written).toBe(false);
      expect(result.diagnostics.at(-1)?.message).toBe(`extrastereo requires stereo input; ${channels===1?'mono':'unspecified'} would be remixed implicitly`);
    }
    // Native rejects out-of-range values, unknown options, a non-boolean c, extra positional values and positional values after named ones.
    for(const [filter,message]of [['extrastereo=m=10.5','extrastereo m must be within [-10,10]'],['extrastereo=-11','extrastereo m must be within [-10,10]'],['extrastereo=c=2','Only 0, 1, true or false extrastereo c values are implemented'],['extrastereo=mult=1','Unsupported extrastereo option: mult=1'],['extrastereo=1:1:1','Unsupported extrastereo option: 1'],['extrastereo=m=1:0','Unsupported extrastereo option: 0']] as const){
      const {result,written,nativeStatus}=await run(2,filter);
      expect(nativeStatus,filter).not.toBe(0);expect(result.exitCode,filter).not.toBe(0);expect(written,filter).toBe(false);expect(result.diagnostics.at(-1)?.message,filter).toBe(message);
    }
    // Native accepts these; timeline enable, expressions, constants and other boolean spellings remain unimplemented and must not be approximated.
    for(const [filter,message]of [['extrastereo=enable=gt(t\\,0.001)','extrastereo timeline enable is not implemented'],['extrastereo=m=1+1','Only decimal extrastereo m values are implemented'],['extrastereo=m=max','Only decimal extrastereo m values are implemented'],['extrastereo=c=yes','Only 0, 1, true or false extrastereo c values are implemented'],['extrastereo=c=off','Only 0, 1, true or false extrastereo c values are implemented']] as const){
      const {result,written,nativeStatus}=await run(2,filter);
      expect(nativeStatus,filter).toBe(0);expect(result.exitCode,filter).not.toBe(0);expect(written,filter).toBe(false);expect(result.diagnostics.at(-1)?.message,filter).toBe(message);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
