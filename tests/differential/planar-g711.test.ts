import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {encodeG711} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
it('encodes planar signed16 full-domain and asymmetric multichannel G711 exactly against native',()=>{
  for(const channels of [1,2,6]){
    const samples=65536,data=new Uint8Array(samples*channels*2),view=new DataView(data.buffer);for(let sample=0;sample<samples;sample++)for(let channel=0;channel<channels;channel++)view.setInt16((sample*channels+channel)*2,((sample+channel*3137)&65535)-32768,true);
    const frame:AudioFrameData={sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:'s16',samples,planes:[data],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}},planar=convertAudioFrame(frame,'s16p',{maxFrameBytes:data.length});
    for(const codec of ['pcm_alaw','pcm_mulaw'] as const){
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f','s16le','-ar','8000','-ac',String(channels),'-i','pipe:0','-af','aformat=sample_fmts=s16p','-c:a',codec,'-f',codec.slice(4),'-'],{input:data,maxBuffer:2*1024*1024});
      const output=encodeG711(planar,codec,{maxFrameBytes:samples*channels});expect(Buffer.from(output.data)).toEqual(expected);expect(output.pts).toBe(9007199254740993n);expect(output.duration).toBe(BigInt(samples));
    }
  }
},60000);
