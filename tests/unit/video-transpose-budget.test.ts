import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
it('preflights transpose graph intermediate expansion before opening media handles',async()=>{
 for(const seek of [[],['-ss','0.02']]){
 let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected input');},async openWrite(){opens++;throw new Error('Unexpected output');}},backend:createMediaBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:32,maxPendingPackets:2,maxCpuTimeMs:10000}}),result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3',...seek,'-i','/in','-vf','[input]transpose=clock[x];[x]format=rgba,format=gray[output]','-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
 }
});
