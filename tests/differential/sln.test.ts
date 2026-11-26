import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:20000};
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+sln\s/);expect(execFileSync(native,['-v','error','-muxers'],{encoding:'utf8'})).not.toMatch(/E\s+sln\s/);
}
/** A slow two-tone s16le pattern with a ramp: no other native probe scores it above the .sln extension (checked per case from the framecrc header). */
function pattern(count:number,seed:number):Uint8Array{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,((i*977+seed*131)%2000)-1000+((i>>3)%7)*3,true);return bytes;}
const header=/#tb 0: 1\/8000\n#media_type 0: audio\n#codec_id 0: pcm_s16le\n#sample_rate 0: 8000\n#channel_layout_name 0: mono\n/;
const outputs=[['copy.crc',['-c:a','copy','-f','framecrc']],['decode.crc',['-c:a','pcm_s16le','-f','framecrc']],['out.wav',['-f','wav']],['out.raw',['-f','s16le']],['out.aiff',['-f','aiff']]] as const;
const profiles=[[],['-ss','0.02'],['-t','0.05'],['-frames:a','2'],['-ss','0.0125','-t','0.2']] as const;
it('matches native SLN demux for -f sln and undeclared .sln inputs of six lengths through framecrc copy and decode WAV raw AIFF and output -ss -t -frames:a',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sln-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});let compared=0,headers=0;
    for(const count of [0,1,511,512,513,3000]){
      const bytes=pattern(count,count);writeFileSync(join(root,`in-${count}.sln`),bytes);writeFileSync(join(root,`in-${count}.dat`),bytes);
      for(const [mode,declared,file] of [['declared',['-f','sln'],`in-${count}.dat`],['undeclared',[],`in-${count}.sln`]] as const){
        if(mode==='undeclared'&&count<2)continue;
        for(const [index,profile] of profiles.entries()){
          const tag=`${mode}-${count}-${index}`,nativeArgs=['-v','error','-y','-bitexact',...declared,'-i',join(root,file)];
          for(const [suffix,tail] of outputs)nativeArgs.push(...profile,...tail,'-bitexact',join(root,`native-${tag}-${suffix}`));
          execFileSync(native,nativeArgs,{timeout:30000});
          for(const [suffix,tail] of outputs){
            const out=`${tag}-${suffix}`,expected=readFileSync(join(root,`native-${out}`));
            if(suffix.endsWith('.crc')){expect(expected.toString('latin1'),out).toMatch(header);headers++;}
            const result=await ffmpeg.exec(['-bitexact',...declared,'-i',`/${file}`,...profile,...tail,'-bitexact',`/${out}`]);expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
            expect(readFileSync(join(root,out)).equals(expected),out).toBe(true);compared++;
          }
        }
      }
    }
    expect(compared).toBe(250);expect(headers).toBe(100);
    const rows=readFileSync(join(root,'native-declared-3000-0-copy.crc'),'latin1').split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').map(field=>field.trim()));
    expect(rows.map(row=>row[3])).toEqual(['512','512','512','512','512','440']);expect(rows.map(row=>row[1])).toEqual(['0','512','1024','1536','2048','2560']);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses SLN inputs that native accepts: -ar -ac input -ss partial trailing samples and undeclared inputs under four bytes with no output created',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sln-refuse-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    writeFileSync(join(root,'in.sln'),pattern(3000,7));writeFileSync(join(root,'odd.sln'),pattern(3000,7).subarray(0,5999));writeFileSync(join(root,'one.sln'),pattern(1,1));writeFileSync(join(root,'empty.sln'),new Uint8Array(0));
    const rate=execFileSync(native,['-v','error','-f','sln','-ar','16000','-i',join(root,'in.sln'),'-c:a','copy','-f','framecrc','-'],{encoding:'latin1'});
    expect(rate).toMatch(/#sample_rate 0: 16000/);expect(rate.split('\n').filter(line=>/^0,/.test(line))[0]).toMatch(/^0,\s+0,\s+0,\s+1024,\s+2048,/);
    const cases:[string,string[],string][]=[['ar',['-f','sln','-ar','16000','-i','in.sln'],'Input rate/channel'],['ac',['-f','sln','-ac','2','-i','in.sln'],'Input rate/channel'],['ar-undeclared',['-ar','8000','-i','in.sln'],'Input rate/channel'],
      ['ss',['-ss','0.1','-f','sln','-i','in.sln'],'SLN input seek is not implemented'],['ss-undeclared',['-ss','0.0125','-i','in.sln'],'SLN input seek is not implemented'],['odd',['-i','odd.sln'],'SLN partial trailing sample is not implemented'],
      ['one',['-i','one.sln'],'Invalid audio container probe'],['empty',['-i','empty.sln'],'Invalid audio container probe']];
    const statuses:Record<string,number|null>={};
    for(const [name,input,message] of cases){
      statuses[name]=spawnSync(native,['-v','error','-y',...input.map(arg=>arg.endsWith('.sln')?join(root,arg):arg),'-f','s16le',join(root,`native-${name}.raw`)]).status;
      const result=await ffmpeg.exec([...input.map(arg=>arg.endsWith('.sln')?`/${arg}`:arg),'-f','s16le',`/${name}.raw`]);expect(result.exitCode,name).not.toBe(0);
      expect(JSON.stringify(result.diagnostics),name).toContain(message);expect(existsSync(join(root,`${name}.raw`)),name).toBe(false);
    }
    expect(Object.values(statuses).every(status=>status===0),JSON.stringify(statuses)).toBe(true);
    for(const [args,out] of [[['-f','sln','-sample_rate','16000','-i','/in.sln'],'/a.raw'],[['-f','sln','-ch_layout','stereo','-i','/in.sln'],'/b.raw']] as const){
      expect(spawnSync(native,['-v','error','-y',...args.map(arg=>arg==='/in.sln'?join(root,'in.sln'):arg),'-f','s16le',join(root,`native${out.slice(1)}`)]).status).toBe(0);
      const result=await ffmpeg.exec([...args,'-f','s16le',out]);expect(result.exitCode).not.toBe(0);expect(existsSync(join(root,out.slice(1)))).toBe(false);
    }
    expect(spawnSync(native,['-v','error','-y','-i',join(root,'in.sln'),'-f','sln',join(root,'native-out.sln')]).status).not.toBe(0);
    const refused=await ffmpeg.exec(['-i','/in.sln','-f','sln','/out.sln']);expect(refused.exitCode).not.toBe(0);expect(existsSync(join(root,'out.sln'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
