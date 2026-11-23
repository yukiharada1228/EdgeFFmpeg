import { compileAudioFilterChain, reframeAudio, padAudio } from '@edge-ffmpeg/avfilter';
import { convertAudioFrame, remixAudioFrame, resampleAudio } from '@edge-ffmpeg/swresample';
import { decodePcm, encodePcm, decodeG711, encodeG711 } from '@edge-ffmpeg/avcodec';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { collectingOutput } from '../helpers/output.js';
import { openWav, muxWav, muxFrameCrc, openAiff, openAu } from '@edge-ffmpeg/containers';
import type { OperatorDescriptor } from '@edge-ffmpeg/core';
import { PacketQueue, FeatureRegistry, planGraph } from '@edge-ffmpeg/core';
import { createR2FileSystem, InputChangedError, R2CommitUncertainError, R2OutputCleanupError, recoverPublishedR2Output } from '@edge-ffmpeg/storage-r2';
import { createCloudflareRuntime } from '@edge-ffmpeg/runtime-cloudflare';
import { pixelLayout, rational, rescale } from '@edge-ffmpeg/avutil';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const fs = createR2FileSystem({ bucket: env.MEDIA_BUCKET, mounts: { '/input': 'source/' }, maxReadBytes: 8 });
    const runtime = createCloudflareRuntime({ filesystem: fs, signal: request.signal,
      budget: { maxResidentBytes: 16, maxBufferBytes: 8, maxCpuTimeMs: 1000, maxPendingPackets: 2 } });
    const route = new URL(request.url).pathname;
    if (route === '/framecrc-cli' || route === '/framecrc-cli-limit' || route === '/asetrate-cli') {
      const data = new Uint8Array(2050), sink = collectingOutput();
      let reads=0;
      for (let i=0;i<data.length;i++) data[i]=(i*37)&255;
      const ffmpeg = new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:8,maxCpuTimeMs:1000,maxPendingPackets:2}});
      const processing=route==='/asetrate-cli'?['-af','asetrate=20000','-ss','0.005','-frames:a','1']:['-ss','0.01','-c:a','copy',...(route.endsWith('-limit')?['-frames:a','1']:[])];
      const result=await ffmpeg.exec(['-guess_layout_max','0','-f','s16le','-ar','8000','-ac','1','-i','/in.raw',...processing,'-bitexact','-f','framecrc','/out.crc']);
      return Response.json({exitCode:result.exitCode,text:new TextDecoder().decode(sink.bytes()),maximum:Math.max(...sink.lengths),reads});
    }
    if (route === '/framecrc') {
      const sink = collectingOutput();
      async function* packets() {
        yield { streamIndex:0, data:new Uint8Array([255,255]), pts:9007199254740993n, dts:-1n, duration:1n, timeBase:{num:1n,den:10n}, flags:1 };
      }
      await muxFrameCrc(sink.output,{codec:'pcm_s16le',sampleRate:10,channelLayout:'mono'},packets(),{bitexact:true,maxWriteBytes:7,signal:request.signal});
      return Response.json({text:new TextDecoder().decode(sink.bytes()),committed:sink.committed,maximum:Math.max(...sink.lengths)});
    }
    if (route === '/asetnsamples-cli') {
      const data=new Uint8Array([0,128,255,130,127]),sink=collectingOutput();let reads=0;
      const ffmpeg=new FFmpeg({filesystem:{async openRead(){return {size:5n,async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxCpuTimeMs:1000,maxPendingPackets:2}});
      const result=await ffmpeg.exec(['-f','u8','-ar','8000','-ac','1','-i','/in.raw','-af','asetnsamples=3:p=1','-bitexact','-f','framecrc','/out.crc']);
      return Response.json({exitCode:result.exitCode,committed:sink.committed,text:new TextDecoder().decode(sink.bytes()),reads});
    }
    if(route==='/pcm-memory'){
      const results=[];
      for(const reframe of [false,true]){
        const sink=collectingOutput();let opens=0;const reads:number[]=[];
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:100n,async readAt(_offset,length){reads.push(length);return new Uint8Array(length).fill(128);}};},async openWrite(){opens++;return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:reframe?256:128,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','u8','-ar','8000','-ac','1','-i','/in.raw',...(reframe?['-af','asetnsamples=16,asetnsamples=16']:[]),'-f','s16le','/out.raw']);
        results.push({exitCode:result.exitCode,diagnostic:result.diagnostics[0]?.code??null,maxRead:Math.max(0,...reads),opens,bytes:sink.bytes().length});
      }
      return Response.json(results);
    }
    if(route==='/g711-domains'){
      const data=new Uint8Array(131072),view=new DataView(data.buffer),codes=Uint8Array.from({length:256},(_,i)=>i);
      for(let i=0;i<65536;i++)view.setInt16(i*2,i-32768,true);
      const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(value=>value.toString(16).padStart(2,'0')).join('');
      const result:Record<string,{decodedSha256:string;encodedSha256:string}>={};
      for(const codec of ['pcm_alaw','pcm_mulaw'] as const){
        const frame=decodeG711({streamIndex:0,data:codes,pts:null,dts:null,duration:256n,timeBase:{num:1n,den:8000n},flags:1},{codec,channels:1,sampleRate:8000},{maxFrameBytes:131072});
        const packet=encodeG711({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:65536,planes:[data],pts:null},codec,{maxFrameBytes:131072});
        result[codec]={decodedSha256:await digest(frame.planes[0]!),encodedSha256:await digest(packet.data)};
      }
      return Response.json(result);
    }
    if(route==='/pcm-endian'){
      const codes=new Uint8Array([0,0,0,128,0,0,255,255,255]);
      const frame=decodePcm({streamIndex:0,data:codes,pts:9007199254740993n,dts:9007199254740993n,duration:3n,timeBase:{num:1n,den:8000n},flags:1},{codec:'pcm_u24be',channels:1,sampleRate:8000},{maxFrameBytes:32});
      const view=new DataView(frame.planes[0]!.buffer);
      return Response.json({values:Array.from({length:3},(_,i)=>view.getInt32(i*4,true)),pts:String(frame.pts?.value),encoded:[...encodePcm(frame,'pcm_u24be',{maxFrameBytes:32}).data]});
    }
    if(route==='/pcm-endian-cli'){
      const input=new Uint8Array([0,0,128,0,255,255]),sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(offset,length){return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','u16be','-ar','8000','-ac','1','-i','/in.raw','-f','s16be','/out.raw']);
      return Response.json({exitCode:result.exitCode,bytes:[...sink.bytes()],committed:sink.committed});
    }
    if(route==='/g711'){
      const input={streamIndex:0,data:new Uint8Array([0,128,127,255,254,126]),pts:9007199254740993n,dts:9007199254740993n,duration:6n,timeBase:{num:1n,den:8000n},flags:1};
      const frame=decodeG711(input,{codec:'pcm_mulaw',channels:1,sampleRate:8000},{maxFrameBytes:32}),view=new DataView(frame.planes[0]!.buffer);
      return Response.json({samples:Array.from({length:6},(_,i)=>view.getInt16(i*2,true)),pts:String(frame.pts?.value),codes:[...encodeG711(frame,'pcm_mulaw',{maxFrameBytes:32}).data]});
    }
    if(route==='/g711-cli'){
      const data=new Uint8Array([0x55,0xd5,0x2a,0xaa]),sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:4n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','alaw','-ar','8000','-ac','1','-i','/in.alaw','-f','s16le','/out.raw']);
      const view=new DataView(sink.bytes().buffer);return Response.json({exitCode:result.exitCode,committed:sink.committed,samples:Array.from({length:4},(_,i)=>view.getInt16(i*2,true))});
    }
    if(route==='/aiff-r2'){
      const input=new Uint8Array([0,128,0,0,255,127]);await env.MEDIA_BUCKET.put('aiff-source/input.raw',input);
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'aiff-source/','/output':'aiff-result/'},maxReadBytes:8,output:{writableMounts:['/output'],stagingPrefix:'.aiff-stage',partBytes:5*1024*1024,maxWriteBytes:8,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const encoded=await frontend.exec(['-f','s16le','-ar','8000','-ac','1','-i','/input/input.raw','-c:a','pcm_f32be','/output/audio.aifc']);
      if(encoded.exitCode!==0)return Response.json({encoded:encoded.diagnostics},{status:500});
      const info=(await openAiff(await files.openRead('/output/audio.aifc'),{maxReadBytes:8})).info;
      const decoded=await frontend.exec(['-cpuflags','0','-i','/output/audio.aifc','-f','s16le','/output/decoded.raw']);
      const output=await env.MEDIA_BUCKET.get('aiff-result/decoded.raw');
      return Response.json({encoded:encoded.exitCode,decoded:decoded.exitCode,container:info.container,codec:info.codec,samples:String(info.durationSamples),rate:info.sampleRate,bytes:output?[...new Uint8Array(await output.arrayBuffer())]:null,staging:(await env.MEDIA_BUCKET.list({prefix:'.aiff-stage/'})).objects.length});
    }
    if(route==='/au-r2'){
      const input=new Uint8Array([0,128,0,0,255,127]);await env.MEDIA_BUCKET.put('au-source/input.raw',input);
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'au-source/','/output':'au-result/'},maxReadBytes:8,output:{writableMounts:['/output'],stagingPrefix:'.au-stage',partBytes:5*1024*1024,maxWriteBytes:8,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const encoded=await frontend.exec(['-f','s16le','-ar','8000','-ac','1','-i','/input/input.raw','/output/audio.au']);
      if(encoded.exitCode!==0)return Response.json({encoded:encoded.diagnostics},{status:500});
      const info=(await openAu(await files.openRead('/output/audio.au'),{maxReadBytes:8})).info;
      const decoded=await frontend.exec(['-i','/output/audio.au','-f','s16le','/output/decoded.raw']);
      const output=await env.MEDIA_BUCKET.get('au-result/decoded.raw');
      return Response.json({encoded:encoded.exitCode,decoded:decoded.exitCode,container:info.container,codec:info.codec,samples:String(info.durationSamples),bytes:output?[...new Uint8Array(await output.arrayBuffer())]:null,staging:(await env.MEDIA_BUCKET.list({prefix:'.au-stage/'})).objects.length});
    }
    if(route==='/resample-mixed'||route==='/aformat'||route==='/aformat-planar'){
      const filter=route==='/aformat-planar'?'aformat=sample_fmts=dblp,asetnsamples=7:p=1':route==='/aformat'?'aformat=sample_fmts=dbl,asetnsamples=7:p=1':'volume=0.5:precision=double,asetnsamples=7:p=1';
      const data=new Uint8Array(128);new DataView(data.buffer).setInt16(0,32767,true);const sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:128n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','s16le','-ar','8000','-ac','1','-i','/input.raw','-af',filter,'-ar','16001','-f','f64le','/output.raw']);
      const bytes=sink.bytes(),view=new DataView(bytes.buffer);return Response.json({exitCode:result.exitCode,committed:sink.committed,samples:bytes.length/8,first:Array.from({length:Math.min(5,bytes.length/8)},(_,i)=>view.getFloat64(i*8,true))});
    }
    if(route==='/raw-video-r2'||route==='/pixel-convert-r2'||route==='/pixel-color-r2'||route==='/chroma-r2'){
      const prefix=route==='/chroma-r2'?'chroma':route==='/pixel-color-r2'?'pixel-color':route==='/pixel-convert-r2'?'pixel-convert':'raw-video',inputPixel=route==='/pixel-color-r2'||route==='/chroma-r2'?'rgb24':'nv12',outputPixel=route==='/chroma-r2'?'nv12':route==='/pixel-color-r2'?'yuv444p':route==='/pixel-convert-r2'?'yuva420p':null;
      await env.MEDIA_BUCKET.put(`${prefix}-source/input.yuv`,Uint8Array.from({length:pixelLayout(inputPixel,5,3).bytes*3},(_,i)=>(i*37+13)&255));
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:64,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:64,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',inputPixel,'-framerate','ntsc','-i','/input/input.yuv','-frames:v','2',...(outputPixel?['-pix_fmt',outputPixel]:[]),'-f','rawvideo','/output/output.yuv']);
      const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.yuv`);return Response.json({exitCode:result.exitCode,bytes:output?[...new Uint8Array(await output.arrayBuffer())]:null,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
    }
    if(route==='/pixel-inverse-reject'){
      let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('unexpected');},async openWrite(){opens++;throw new Error('unexpected');}},backend:createWavBackend()});
      const result=await frontend.exec(['-f','rawvideo','-pix_fmt','nv12','-s','16x6','-i','/input.raw','-pix_fmt','rgba','-f','rawvideo','/output.raw']);return Response.json({exitCode:result.exitCode,diagnostic:result.diagnostics[0]?.code,opens});
    }
    if(route==='/pixel-resize-inverse-r2'||route==='/pixel-resize-inverse-linux-r2'){
      const arithmetic=route==='/pixel-resize-inverse-linux-r2'?'x86_64':'aarch64',results=[];
      for(const format of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'])for(const destination of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']){
        const [width,height]=['bgr24','bgra','rgba'].includes(destination)?[4,3] as const:[13,7] as const,prefix=`inverse-resize-${arithmetic}-${format}-${destination}`,input=Uint8Array.from({length:pixelLayout(format,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',format,'-framerate','25','-i','/input/input.raw','-ss','0.02','-t','0.05','-s',`${width}x${height}`,'-pix_fmt',destination,'-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({format,destination,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/pixel-resize-yuv-r2'){
      const results=[];
      for(const format of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21']){
        const prefix=`resize-${format}`,input=Uint8Array.from({length:pixelLayout(format,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',format,'-framerate','25','-i','/input/input.raw','-ss','0.02','-t','0.05','-s','13x7','-pix_fmt',format,'-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({format,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/pixel-resize-combined-r2'){
      const results=[];
      for(const [format,destination]of [['yuv420p','yuv444p'],['nv21','yuva420p'],['rgb24','nv12'],['rgba','gbrp'],['gbrp','gray'],['gray','bgra'],['gray','yuva420p'],['bgr24','rgb24']] as const){
        const prefix=`combined-${format}-${destination}`,input=Uint8Array.from({length:pixelLayout(format,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',format,'-framerate','25','-i','/input/input.raw','-ss','0.02','-t','0.05','-s','13x7','-pix_fmt',destination,'-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({format,destination,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/pixel-resize-rgb-r2'){
      const results=[];
      for(const format of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']){
        const prefix=`resize-${format}`,input=Uint8Array.from({length:pixelLayout(format,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',format,'-framerate','25','-i','/input/input.raw','-ss','0.02','-t','0.05','-s','13x7','-pix_fmt',format,'-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({format,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/pixel-resize-r2'){
      await env.MEDIA_BUCKET.put('pixel-resize-source/input.gray',Uint8Array.from({length:45},(_,i)=>(i*37+13)&255));
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'pixel-resize-source/','/output':'pixel-resize-result/'},maxReadBytes:256,output:{writableMounts:['/output'],stagingPrefix:'.pixel-resize-stage',partBytes:5*1024*1024,maxWriteBytes:256,maxOutputBytes:4096}});let reads=0;
      const filesystem={async openRead(path:string){const input=await files.openRead(path);return {size:input.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return input.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
      const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:8192,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','rawvideo','-video_size','5:3','-pixel_format','gray','-framerate','25','-i','/input/input.gray','-ss','0.02','-t','0.05','-s','13:7','-bitexact','-f','framecrc','/output/output.crc']);
      const output=await env.MEDIA_BUCKET.get('pixel-resize-result/output.crc');return Response.json({exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:'.pixel-resize-stage/'})).objects.length});
    }
    if(route==='/video-filter-format-r2'||route==='/video-filter-format-linux-r2'){
      const arithmetic=route==='/video-filter-format-linux-r2'?'x86_64':'aarch64',requests=[['nv21','bgra','null','4x3'],['yuva420p','bgra','scale=13:7,scale','4x3'],['rgba','nv12','scale=13:7,format=gray,scale','4x3'],['gray','argb','format=nv12,scale=13:7','4x3'],['yuv444p','gbrp','format=nv12,scale=13:7','13x7'],['bgr24','rgba','format=gray,format=rgba,scale=13:7','4x3'],['gbrp','gray','scale=13:7,scale','13x7'],['rgb24','yuv422p','format=gray','4x3']] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-format-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,'-pix_fmt',destination,'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-lists-r2'||route==='/video-filter-lists-linux-r2'){
      const arithmetic=route==='/video-filter-lists-linux-r2'?'x86_64':'aarch64',requests=[["rgba", "", "format=gray|rgba,format=gray|nv12", "4x3"], ["rgba", "", "format=rgba|nv12,format=yuva420p|nv12", "4x3"], ["nv21", "bgra", "scale=13:7,format=gray|gbrp,scale", "4x3"], ["gray", "rgba", "format=rgba|gray,scale=13:7,format=nv12|gray", "13x7"], ["yuv444p", "gbrp", "format=nv12|rgba,scale=13:7", "4x3"], ["bgr24", "", "format=gray|rgba,format=gbrp|yuv422p,scale=13:7", "4x3"], ["gbrp", "gray", "scale=13:7,format=rgba|bgra,scale", "13x7"], ["yuva420p", "rgba", "format=gray|rgba,scale=1:1,format=nv12|yuva420p,scale=13:7", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-lists-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-flip-r2'||route==='/video-filter-flip-linux-r2'){
      const arithmetic=route==='/video-filter-flip-linux-r2'?'x86_64':'aarch64',requests=[["nv21", "bgra", "hflip=", "4x3"], ["yuva420p", "rgba", "vflip=", "4x3"], ["rgba", "", "format=rgba|gray,hflip=,format=nv12|gray", "4x3"], ["gray", "argb", "hflip=,scale=13:7,vflip=", "4x3"], ["yuv444p", "gbrp", "format=nv12,hflip=,scale=13:7,format=rgba,vflip=", "13x7"], ["bgr24", "rgba", "scale=13:7,hflip=,scale=,vflip=", "4x3"], ["gbrp", "gray", "vflip=,format=rgba|bgra,scale=13:7,hflip=", "13x7"], ["rgb24", "nv12", "hflip=,vflip=", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-flip-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-numeric-r2'||route==='/video-filter-numeric-linux-r2'){
      const arithmetic=route==='/video-filter-numeric-linux-r2'?'x86_64':'aarch64',requests=[["nv21", "bgra", "format=0,hflip", "4x3"], ["yuva420p", "rgba", "format=0x1a|8,vflip", "4x3"], ["rgba", "", "format= |Y8,hflip,format=bgr32", "4x3"], ["gray", "argb", "format=pix_fmts=,scale=13:7,vflip", "4x3"], ["yuv444p", "gbrp", "format=-9223372036854775809,hflip,scale=13:7,format=26", "13x7"], ["bgr24", "rgba", "format = pix_fmts = rgb32,scale=13:7,vflip", "4x3"], ["gbrp", "gray", "format=71|4,scale=13:7,format=8,hflip", "13x7"], ["rgb24", "", "format=gray|,vflip,scale=13:7", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-numeric-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-quoted-r2'||route==='/video-filter-quoted-linux-r2'){
      const arithmetic=route==='/video-filter-quoted-linux-r2'?'x86_64':'aarch64',requests=[["nv21", "bgra", "'hflip'", "4x3"], ["yuva420p", "rgba", "format='rgba|gray',vflip", "4x3"], ["rgba", "", "format=\\'rgba|gray\\',scale='13:7',vflip", "4x3"], ["gray", "argb", "scale=w='13':h='7':flags='bicubic',vflip", "4x3"], ["yuv444p", "gbrp", "format=rgba:pix_fmts=0,scale=h=7,hflip", "13x7"], ["bgr24", "rgba", "scale='13,7',hflip,", "4x3"], ["gbrp", "gray", "scale=flags=bogus:flags=bicubic,format=8;", "13x7"], ["rgb24", "", "scale=w=bogus:h=7:w=13,format='26|8'", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-quoted-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-labelled-r2'||route==='/video-filter-labelled-linux-r2'){
      const arithmetic=route==='/video-filter-labelled-linux-r2'?'x86_64':'aarch64',requests=[["nv21", "bgra", "[in]hflip[out]", "4x3"], ["yuva420p", "rgba", "[x]vflip[out];[in]format=rgba|gray[x]", "4x3"], ["rgba", "", "[b]scale=13:7[out];[a]format=yuva420p|nv12[b];[in]format=rgba|nv12[a]", "4x3"], ["gray", "argb", "[in]hflip[x];[x]vflip[x]", "4x3"], ["yuv444p", "gbrp", "[x]scale=13:7[out];[in]format=nv12[x]", "13x7"], ["bgr24", "rgba", "format@fmt=0,scale@size=13:7,hflip@", "4x3"], ["gbrp", "gray", "[in]format=rgba|gray[x];[x]scale=h=7[out]", "13x7"], ["rgb24", "", "['middle x']scale=13:7['output x'];['input x']format=gray['middle x']", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`graph-labelled-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-transpose-r2'||route==='/video-transpose-linux-r2'){
      const arithmetic=route==='/video-transpose-linux-r2'?'x86_64':'aarch64',requests=[["nv21", "bgra", "transpose=clock,format=rgba|gray", "4x3"], ["yuva420p", "rgba", "transpose=cclock", "4x3"], ["rgba", "", "transpose=clock_flip", "4x3"], ["gray", "argb", "transpose=4", "4x3"], ["yuv422p", "gbrp", "transpose=clock", "13x7"], ["bgr24", "rgba", "transpose=clock:passthrough=portrait", "4x3"], ["gbrp", "gray", "transpose=clock,format=rgba|gray", "13x7"], ["rgb24", "", "[x]transpose=cclock[out];[in]format=nv12|gray[x]", "4x3"]] as const,results=[];
      for(const [index,[source,destination,description,size]]of requests.entries()){
        const id=String(index),prefix=`transpose-${arithmetic}-${id}`,input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put(`${prefix}-source/input.raw`,input);
        const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':`${prefix}-source/`,'/output':`${prefix}-result/`},maxReadBytes:512,output:{writableMounts:['/output'],stagingPrefix:`.${prefix}-stage`,partBytes:5*1024*1024,maxWriteBytes:512,maxOutputBytes:4096}});let reads=0;
        const filesystem={async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return source.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
        const frontend=new FFmpeg({filesystem,backend:createWavBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}}),result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-ss','0.02','-i','/input/input.raw','-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f','framecrc','/output/output.crc']);
        const output=await env.MEDIA_BUCKET.get(`${prefix}-result/output.crc`);results.push({id,exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:`.${prefix}-stage/`})).objects.length});
      }
      return Response.json(results);
    }
    if(route==='/video-filter-r2'){
      await env.MEDIA_BUCKET.put('video-filter-source/input.gray',Uint8Array.from({length:45},(_,i)=>(i*37+13)&255));
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'video-filter-source/','/output':'video-filter-result/'},maxReadBytes:256,output:{writableMounts:['/output'],stagingPrefix:'.video-filter-stage',partBytes:5*1024*1024,maxWriteBytes:256,maxOutputBytes:4096}});let reads=0;
      const filesystem={async openRead(path:string){const input=await files.openRead(path);return {size:input.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;return input.readAt(offset,Math.min(length,11),signal);}};},openWrite:files.openWrite.bind(files)};
      const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:8192,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','rawvideo','-video_size','5:3','-pixel_format','gray','-framerate','25','-i','/input/input.gray','-ss','0.02','-t','0.05','-vf','null,scale=13:7,null','-bitexact','-f','framecrc','/output/output.crc']);
      const output=await env.MEDIA_BUCKET.get('video-filter-result/output.crc');return Response.json({exitCode:result.exitCode,text:output?await output.text():null,reads,staging:(await env.MEDIA_BUCKET.list({prefix:'.video-filter-stage/'})).objects.length});
    }
    if(route==='/pixel-inverse-r2'){
      await env.MEDIA_BUCKET.put('pixel-inverse-source/input.yuv',Uint8Array.from({length:81},(_,i)=>(i*37+13)&255));
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'pixel-inverse-source/','/output':'pixel-inverse-result/'},maxReadBytes:128,output:{writableMounts:['/output'],stagingPrefix:'.pixel-inverse-stage',partBytes:5*1024*1024,maxWriteBytes:128,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:8192,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format','yuv420p','-framerate','ntsc','-i','/input/input.yuv','-frames:v','2','-pix_fmt','rgba','-f','rawvideo','/output/output.rgba']);
      const output=await env.MEDIA_BUCKET.get('pixel-inverse-result/output.rgba');return Response.json({exitCode:result.exitCode,bytes:output?[...new Uint8Array(await output.arrayBuffer())]:null,staging:(await env.MEDIA_BUCKET.list({prefix:'.pixel-inverse-stage/'})).objects.length});
    }
    if(route==='/pixel-inverse-linux'){
      const results=[];
      for(const [source,destination,width,height]of [['yuv420p','bgr24',16,7],['yuva420p','bgra',16,7],['yuv422p','bgra',16,7],['nv12','rgba',32,8],['nv21','bgra',16,6],['nv12','rgb24',5,3]] as const){
        const layout=pixelLayout(source,width,height);let seed=53,reads=0;
        const data=Uint8Array.from({length:layout.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}),sink=collectingOutput();
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend({pixelArithmetic:'x86_64'}),budget:{maxResidentBytes:16384,maxBufferBytes:2048,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size',`${width}x${height}`,'-pixel_format',source,'-i','/input.raw','-frames:v','1','-pix_fmt',destination,'-f','rawvideo','/output.raw']);
        const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',sink.bytes()));
        results.push({id:`${source}-${destination}-${width}x${height}`,exitCode:result.exitCode,committed:sink.committed,reads,sha256:Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('')});
      }
      return Response.json(results);
    }
    if(route==='/pixel-inverse'){
      const results=[];
      for(const [source,destination,width,height,scalar]of [['yuv420p','rgb24',16,2,false],['yuv420p','rgba',6,3,false],['yuva420p','bgra',5,7,false],['yuv422p','gbrp',5,3,false],['nv21','argb',16,6,true],['nv12','rgb24',5,3,false]] as const){
        const layout=pixelLayout(source,width,height),data=Uint8Array.from({length:layout.bytes*2},(_,i)=>(i*37+13)&255),sink=collectingOutput();let reads=0;
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec([...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-video_size',`${width}x${height}`,'-pixel_format',source,'-framerate','25','-i','/input.raw','-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f','framecrc','/output.crc']);
        results.push({source,destination,width,height,scalar,exitCode:result.exitCode,committed:sink.committed,reads,text:new TextDecoder().decode(sink.bytes())});
      }
      return Response.json(results);
    }
    if(route==='/chroma'){
      const results=[];
      for(const [source,destination,width]of [['yuv444p','nv21',5],['yuv420p','yuv444p',5],['rgb24','yuv420p',5],['bgr24','yuva420p',6],['rgba','yuva420p',5]] as const){
        const layout=pixelLayout(source,width,3),data=Uint8Array.from({length:layout.bytes*2},(_,i)=>(i*37+13)&255),sink=collectingOutput();let reads=0;
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size',`${width}x3`,'-pixel_format',source,'-framerate','25','-i','/input.raw','-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f','framecrc','/output.crc']);
        results.push({source,destination,width,exitCode:result.exitCode,committed:sink.committed,reads,text:new TextDecoder().decode(sink.bytes())});
      }
      return Response.json(results);
    }
    if(route==='/pixel-color'){
      const results=[];
      for(const [source,destination]of [['rgba','yuv444p'],['yuv444p','abgr'],['gbrp','gray'],['gray','nv21'],['nv12','gray']] as const){
        const layout=pixelLayout(source,5,3),data=Uint8Array.from({length:layout.bytes*2},(_,i)=>(i*37+13)&255),sink=collectingOutput();let reads=0;
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-framerate','25','-i','/input.raw','-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f','framecrc','/output.crc']);
        results.push({source,destination,exitCode:result.exitCode,committed:sink.committed,reads,text:new TextDecoder().decode(sink.bytes())});
      }
      return Response.json(results);
    }
    if(route==='/pixel-convert'){
      const results=[];
      for(const [source,destination]of [['rgba','gbrp'],['gbrp','abgr'],['nv21','yuva420p'],['yuva420p','nv12']] as const){
        const layout=pixelLayout(source,5,3),data=Uint8Array.from({length:layout.bytes*2},(_,i)=>(i*37+13)&255),sink=collectingOutput();let reads=0;
        const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format',source,'-framerate','25','-i','/input.raw','-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f','framecrc','/output.crc']);
        results.push({source,destination,exitCode:result.exitCode,committed:sink.committed,reads,text:new TextDecoder().decode(sink.bytes())});
      }
      return Response.json(results);
    }
    if(route==='/raw-video'||route==='/raw-video-time'){
      const data=Uint8Array.from({length:54},(_,i)=>i%27),sink=collectingOutput();let reads=0;
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:54n,async readAt(offset,length){reads++;return data.slice(Number(offset),Number(offset)+Math.min(length,3));}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','rawvideo','-video_size','5x3','-pixel_format','yuv420p','-framerate','30000/1001','-i','/input.raw',...(route==='/raw-video-time'?['-ss','0.02','-t','0.05']:[]),'-bitexact','-f','framecrc','/output.crc']);
      return Response.json({exitCode:result.exitCode,committed:sink.committed,reads,text:new TextDecoder().decode(sink.bytes())});
    }
    if(route==='/resample-framecrc'){
      const data=Uint8Array.from({length:64},(_,i)=>(i*37+13)&255),sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:64n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','u8','-ar','8000','-ac','1','-i','/input.raw','-ss','0.000125','-frames:a','2','-ar','16001','-c:a','pcm_s16le','-bitexact','-f','framecrc','/output.crc']);
      return Response.json({exitCode:result.exitCode,committed:sink.committed,text:new TextDecoder().decode(sink.bytes())});
    }
    if(route==='/apad-resample-before'||route==='/apad-resample-after'){
      const data=new Uint8Array([255,127]),sink=collectingOutput(),filter=route==='/apad-resample-before'?'apad=whole_len=70:packet_size=2':'aformat=dbl,apad=whole_len=5:packet_size=2';
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:2n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','s16le','-ar','8000','-ac','1','-i','/input.raw','-af',filter,'-ar','16000','-f','f64le','/output.raw']);
      const bytes=sink.bytes(),view=new DataView(bytes.buffer);return Response.json({exitCode:result.exitCode,committed:sink.committed,samples:bytes.length/8,first:Array.from({length:Math.min(5,bytes.length/8)},(_,i)=>view.getFloat64(i*8,true))});
    }
    if(route==='/apad-cli'||route==='/apad-whole-cli'||route==='/apad-duration-cli'||route==='/apad-trim-cli'||route==='/apad-frame-cli'){
      const filter=route==='/apad-frame-cli'?'apad=pad_len=10:packet_size=2':route==='/apad-trim-cli'?'apad=pad_len=10:packet_size=2':route==='/apad-duration-cli'?'apad=whole_dur=625us':route==='/apad-whole-cli'?'apad=whole_len=5':'apad=pad_len=2:packet_size=2';
      const data=new Uint8Array([0,128,0,0,255,127]),sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','s16le','-ar','8000','-ac','1','-i','/input.raw','-af',filter,...(route==='/apad-frame-cli'?['-ss','0.0005','-frames:a','2']:route==='/apad-trim-cli'?['-ss','0.0005','-t','0.000375']:[]),'-f','s16le','/output.raw']);return Response.json({exitCode:result.exitCode,committed:sink.committed,bytes:[...sink.bytes()]});
    }
    if(route==='/pad-audio'){
      async function* frames(){yield {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',samples:2,planes:[new Uint8Array([1,2]),new Uint8Array([9,8])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
      const result=[];for await(const frame of padAudio(frames(),{padSamples:5n,packetSamples:3,maxFrameBytes:6}))result.push({samples:frame.samples,pts:String(frame.pts?.value),planes:frame.planes.map(plane=>[...plane])});return Response.json(result);
    }
    if(route==='/planar-filters'){
      async function* frames(){yield {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:2,planes:[new Uint8Array([0,128,255,127]),new Uint8Array([255,255,1,0])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
      const chain=compileAudioFilterChain('anull,asetrate=11025,asetnsamples=3:p=1,volume=0.5:precision=fixed',{outputSampleFormat:'s16'}),result=[];
      for await(const frame of chain.process(frames(),{maxFrameBytes:12})){const plane=frame.planes[0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);result.push({format:frame.sampleFormat,rate:frame.sampleRate,pts:String(frame.pts?.value),values:Array.from({length:6},(_,i)=>view.getInt16(i*2,true))});}return Response.json(result);
    }
    if(route==='/planar-remix'){
      const input={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:3,planes:[new Uint8Array([253,255,3,0,0,128]),new Uint8Array([0,0,0,0,255,127])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};
      const mono=remixAudioFrame(input,1,'s16p',{maxFrameBytes:12}),stereo=remixAudioFrame(mono,2,'s16p',{maxFrameBytes:12});
      const values=(planes:Uint8Array[])=>planes.map(plane=>{const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:3},(_,i)=>view.getInt16(i*2,true));});return Response.json({mono:values(mono.planes),stereo:values(stereo.planes),pts:String(stereo.pts?.value),layout:stereo.channelLayout});
    }
    if(route==='/planar-resample'){
      async function* frames(){for(let index=0;index<64;index++){const a=new Uint8Array(8),b=new Uint8Array(8);if(index===0){new DataView(a.buffer).setFloat64(0,1,true);new DataView(b.buffer).setFloat64(0,-1,true);}yield {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'dblp',samples:1,planes:[a,b],pts:{value:BigInt(index),timeBase:{num:1n,den:8000n}}};}}
      const first:number[][]=[[],[]];let samples=0;
      for await(const frame of resampleAudio(frames(),16001,{maxFrameBytes:128,maxStateBytes:512*1024})){if(frame.sampleFormat!=='dblp'||frame.pts?.value!==BigInt(samples))throw new Error('Planar resample metadata mismatch');for(let channel=0;channel<2;channel++){const plane=frame.planes[channel]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);for(let i=0;i<frame.samples&&first[channel]!.length<5;i++)first[channel]!.push(view.getFloat64(i*8,true));}samples+=frame.samples;}
      return Response.json({samples,first});
    }
    if(route==='/planar-reframe'){
      async function* frames(){for(let index=0;index<2;index++)yield {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',samples:2,planes:[new Uint8Array([index*2+1,index*2+2]),new Uint8Array([9-index*2,8-index*2])],pts:{value:9007199254740993n+BigInt(index*2),timeBase:{num:1n,den:8000n}}};}
      const result=[];for await(const frame of reframeAudio(frames(),3,true,{maxFrameBytes:6}))result.push({samples:frame.samples,pts:String(frame.pts?.value),planes:frame.planes.map(plane=>[...plane])});return Response.json(result);
    }
    if(route==='/planar-g711'){
      const left=new Uint8Array([0,128,0,0,255,127]),right=new Uint8Array([255,127,0,0,1,128]);
      const frame={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:3,planes:[left,right],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};
      const packet=encodeG711(frame,'pcm_mulaw',{maxFrameBytes:6});return Response.json({bytes:[...packet.data],pts:String(packet.pts),duration:String(packet.duration),input:[...left,...right]});
    }
    if(route==='/planar'){
      const data=new Uint8Array([0,128,255,127,255,255,1,0,0,0,2,0]);
      const frame={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:3,planes:[data],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};
      const planar=convertAudioFrame(frame,'dblp',{maxFrameBytes:48}),packed=convertAudioFrame(planar,'s16',{maxFrameBytes:12}),packet=encodePcm(planar,'pcm_s16be',{maxFrameBytes:48});
      return Response.json({format:planar.sampleFormat,planes:planar.planes.map(plane=>{const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:3},(_,i)=>view.getFloat64(i*8,true));}),pts:String(planar.pts?.value),packed:[...packed.planes[0]!],encoded:[...packet.data],owned:planar.planes[0]!.buffer!==data.buffer});
    }
    if(route==='/resample-fixed'){
      async function* frames(){for(let index=0;index<64;index++){const data=new Uint8Array(2);if(index===0)new DataView(data.buffer).setInt16(0,32767,true);yield {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[data],pts:{value:BigInt(index),timeBase:{num:1n,den:8000n}}};}}
      const first:number[]=[];let samples=0;
      for await(const frame of resampleAudio(frames(),16001,{maxFrameBytes:16,maxStateBytes:128*1024})){const data=frame.planes[0]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength);if(frame.sampleFormat!=='s16'||frame.pts?.value!==BigInt(samples))throw new Error('Fixed resample format/timestamp mismatch');for(let i=0;i<frame.samples&&first.length<5;i++)first.push(view.getInt16(i*2,true));samples+=frame.samples;}
      return Response.json({samples,first});
    }
    if(route==='/resample-cli-fixed-r2'){
      const input=Uint8Array.from({length:64},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put('resample-fixed-source/input.raw',input);
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'resample-fixed-source/','/output':'resample-fixed-result/'},maxReadBytes:64,output:{writableMounts:['/output'],stagingPrefix:'.resample-fixed-stage',partBytes:5*1024*1024,maxWriteBytes:64,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','u8','-ar','8000','-ac','1','-i','/input/input.raw','-ar','16001','/output/audio.wav']);
      if(result.exitCode!==0)return Response.json({diagnostics:result.diagnostics},{status:500});
      const audio=await openWav(await files.openRead('/output/audio.wav'),{maxReadBytes:64}),first:number[]=[];
      for await(const packet of audio.packets()){const view=new DataView(packet.data.buffer,packet.data.byteOffset,packet.data.byteLength);for(let i=0;i<packet.data.length/2&&first.length<5;i++)first.push(view.getInt16(i*2,true));break;}
      return Response.json({exitCode:result.exitCode,rate:audio.info.sampleRate,samples:String(audio.info.durationSamples),codec:audio.info.codec,first,staging:(await env.MEDIA_BUCKET.list({prefix:'.resample-fixed-stage/'})).objects.length});
    }
    if(route==='/resample-cli-float-r2'){
      const input=Uint8Array.from({length:64},(_,i)=>(i*37+13)&255);await env.MEDIA_BUCKET.put('resample-float-source/input.raw',input);
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'resample-float-source/','/output':'resample-float-result/'},maxReadBytes:64,output:{writableMounts:['/output'],stagingPrefix:'.resample-float-stage',partBytes:5*1024*1024,maxWriteBytes:64,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','mulaw','-ar','8000','-ac','1','-i','/input/input.raw','-ar','16001','-c:a','pcm_f32be','/output/audio.au']);
      if(result.exitCode!==0)return Response.json({diagnostics:result.diagnostics},{status:500});
      const audio=await openAu(await files.openRead('/output/audio.au'),{maxReadBytes:64}),first:number[]=[];
      for await(const packet of audio.packets()){const view=new DataView(packet.data.buffer,packet.data.byteOffset,packet.data.byteLength);for(let i=0;i<packet.data.length/4&&first.length<5;i++)first.push(view.getFloat32(i*4,false));break;}
      return Response.json({exitCode:result.exitCode,rate:audio.info.sampleRate,samples:String(audio.info.durationSamples),codec:audio.info.codec,first,staging:(await env.MEDIA_BUCKET.list({prefix:'.resample-float-stage/'})).objects.length});
    }
    if(route==='/resample-float'){
      async function* frames(){for(let index=0;index<64;index++){const data=new Uint8Array(4);if(index===0)new DataView(data.buffer).setFloat32(0,1,true);yield {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'flt',samples:1,planes:[data],pts:{value:BigInt(index),timeBase:{num:1n,den:8000n}}};}}
      const first:number[]=[];let samples=0;
      for await(const frame of resampleAudio(frames(),16001,{maxFrameBytes:32,maxStateBytes:256*1024})){const data=frame.planes[0]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength);if(frame.sampleFormat!=='flt'||frame.pts?.value!==BigInt(samples))throw new Error('Float resample format/timestamp mismatch');for(let i=0;i<frame.samples&&first.length<5;i++)first.push(view.getFloat32(i*4,true));samples+=frame.samples;}
      return Response.json({samples,first});
    }
    if(route==='/resample-cli-r2'){
      const input=new Uint8Array(64*8);new DataView(input.buffer).setFloat64(0,1,true);await env.MEDIA_BUCKET.put('resample-source/input.raw',input);
      const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'resample-source/','/output':'resample-result/'},maxReadBytes:64,output:{writableMounts:['/output'],stagingPrefix:'.resample-stage',partBytes:5*1024*1024,maxWriteBytes:64,maxOutputBytes:4096}});
      const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-cpuflags','0','-f','f64le','-ar','8000','-ac','1','-i','/input/input.raw','-ar','16000','-c:a','pcm_f64le','/output/audio.wav']);
      if(result.exitCode!==0)return Response.json({diagnostics:result.diagnostics},{status:500});
      const audio=await openWav(await files.openRead('/output/audio.wav'),{maxReadBytes:64}),first:number[]=[];
      for await(const packet of audio.packets()){const view=new DataView(packet.data.buffer,packet.data.byteOffset,packet.data.byteLength);for(let i=0;i<packet.data.length/8&&first.length<5;i++)first.push(view.getFloat64(i*8,true));break;}
      return Response.json({exitCode:result.exitCode,rate:audio.info.sampleRate,samples:String(audio.info.durationSamples),first,staging:(await env.MEDIA_BUCKET.list({prefix:'.resample-stage/'})).objects.length});
    }
    if(route==='/resample'||route==='/resample-fallback'){
      const outputRate=route==='/resample'?16000:16001;
      async function* frames(){for(let index=0;index<64;index++){const data=new Uint8Array(8);if(index===0)new DataView(data.buffer).setFloat64(0,1,true);yield {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples:1,planes:[data],pts:{value:BigInt(index),timeBase:{num:1n,den:8000n}}};}}
      const first:number[]=[];let samples=0,framesOut=0;
      for await(const frame of resampleAudio(frames(),outputRate,{maxFrameBytes:64,maxStateBytes:512*1024})){const data=frame.planes[0]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength);for(let i=0;i<frame.samples&&first.length<5;i++)first.push(view.getFloat64(i*8,true));if(frame.pts?.value!==BigInt(samples))throw new Error('Resample timestamp mismatch');samples+=frame.samples;framesOut++;}
      return Response.json({samples,frames:framesOut,first});
    }
    if(route==='/remix'){
      const input=new Uint8Array(8),view=new DataView(input.buffer);view.setFloat32(0,0.734375,true);view.setFloat32(4,-0.9765625,true);
      const frame={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'flt',samples:1,planes:[input],pts:null};
      const separate=remixAudioFrame(frame,1,'flt',{maxFrameBytes:64,arithmetic:'separate'}),fused=remixAudioFrame(frame,1,'flt',{maxFrameBytes:64,arithmetic:'fused'});
      const data=new Uint8Array([253,255,0,0,3,0,0,0,0,128,255,127]),sink=collectingOutput();
      const frontend=new FFmpeg({filesystem:{async openRead(){return {size:12n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const result=await frontend.exec(['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','-ac','1','-f','s16le','/out.raw']);
      return Response.json({separate:new DataView(separate.planes[0]!.buffer).getFloat32(0,true),fused:new DataView(fused.planes[0]!.buffer).getFloat32(0,true),exitCode:result.exitCode,bytes:[...sink.bytes()]});
    }
    if (route === '/fixed-volume') {
      const data=new Uint8Array(24),view=new DataView(data.buffer);
      [-2147483648,-3,-1,1,3,2147483647].forEach((value,i)=>view.setInt32(i*4,value,true));
      const filter=compileAudioFilterChain('volume=0.5:precision=fixed',{outputSampleFormat:'s32'});
      const frame=filter.apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s32',samples:6,planes:[data],pts:null},{maxFrameBytes:64});
      const output=new DataView(frame.planes[0]!.buffer);
      return Response.json({values:Array.from({length:6},(_,i)=>output.getInt32(i*4,true)),scalarRequired:filter.requiresScalarRounding('s32')});
    }
    if (route === '/sample-formats') {
      const values = [-1,-1.5/32768,-0.5/32768,0.5/32768,1.5/32768,1];
      const data = new Uint8Array(values.length * 8), view = new DataView(data.buffer);
      values.forEach((value,i)=>view.setFloat64(i*8,value,true));
      const output = convertAudioFrame({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples:values.length,planes:[data],pts:null},'s16',{maxFrameBytes:1024});
      const result = new DataView(output.planes[0]!.buffer);
      return Response.json({values:Array.from({length:values.length},(_,i)=>result.getInt16(i*2,true))});
    }
    if (route === '/pcm-codecs') {
      const examples = [
        ['pcm_u8', [0,128,255]], ['pcm_s16le', [0,128,0,0,255,127]],
        ['pcm_s24le', [0,0,128,0,0,0,255,255,127]], ['pcm_s32le', [0,0,0,128,0,0,0,0,255,255,255,127]],
        ['pcm_f32le', [0x34,0x12,0xc0,0x7f]], ['pcm_f64le', [1,0,0,0,0,0,0xf8,0x7f]]
      ] as const;
      const result: Record<string, { same: number[]; unsigned?: number[] }> = {};
      for (const [codec, data] of examples) {
        const frame = decodePcm({ streamIndex: 0, data: new Uint8Array(data), pts: 0n, dts: 0n, duration: null, timeBase: { num: 1n, den: 8000n }, flags: 1 }, { codec, channels: 1, sampleRate: 8000 }, { maxFrameBytes: 1024 });
        result[codec] = { same: [...encodePcm(frame, codec, { maxFrameBytes: 1024 }).data] };
        if (codec !== 'pcm_f32le' && codec !== 'pcm_f64le') result[codec]!.unsigned = [...encodePcm(frame, 'pcm_u8', { maxFrameBytes: 1024 }).data];
      }
      return Response.json(result);
    }
    if (route.startsWith('/r2-output/')) {
      const stagingPrefix = '.edgeffmpeg-staging';
      const bucket = (route.endsWith('/uncertain') || route.endsWith('/staging-failure') || route.endsWith('/cleanup-failure')) ? new Proxy(env.MEDIA_BUCKET, {
        get(target, property) {
          if (property === 'delete' && route.endsWith('/cleanup-failure')) return async () => { throw new Error('Simulated staging cleanup failure'); };
          if (property === 'createMultipartUpload' && route.endsWith('/staging-failure')) return async (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
            const upload = await target.createMultipartUpload(...args);
            return { key: upload.key, uploadId: upload.uploadId, uploadPart: upload.uploadPart.bind(upload), abort: upload.abort.bind(upload), async complete(parts: R2UploadedPart[]) { await upload.complete(parts); throw new Error('Simulated lost staging completion acknowledgement'); } };
          };
          if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
            const result = await target.put(...args);
            if (args[0] === 'result/uncertain') throw new Error('Simulated lost publication acknowledgement');
            return result;
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }) : env.MEDIA_BUCKET;
      const files = createR2FileSystem({ bucket, mounts: { '/input': 'source', '/output': 'result' }, maxReadBytes: 8,
        output: { writableMounts: ['/output'], stagingPrefix, partBytes: 5 * 1024 * 1024, maxWriteBytes: 65536, maxOutputBytes: 12 * 1024 * 1024 } });
      if (route.endsWith('/cleanup-failure')) {
        const output = await files.openWrite('/output/cleanup-failure'); await output.write(new Uint8Array([1]));
        try { await output.commit(); }
        catch (error) {
          if (!(error instanceof R2OutputCleanupError)) throw error;
          await output.abort();
          const recovered = await recoverPublishedR2Output(env.MEDIA_BUCKET, error);
          return Response.json({ published: error.published, recovered, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
        }
        return new Response('Expected cleanup failure', { status: 500 });
      }
      if (route.endsWith('/staging-failure')) {
        const output = await files.openWrite('/output/staging-failure'); await output.write(new Uint8Array([1]));
        let failed = false;
        try { await output.commit(); } catch { failed = true; await output.abort(); }
        return Response.json({ failed, visible: (await env.MEDIA_BUCKET.head('result/staging-failure')) !== null, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/limits')) {
        const limited = createR2FileSystem({ bucket, mounts: { '/output': 'result' }, maxReadBytes: 8, output: { writableMounts: ['/output'], stagingPrefix, partBytes: 5 * 1024 * 1024, maxWriteBytes: 8, maxOutputBytes: 8 } });
        let protectedInput = false;
        try { await files.openWrite('/input/protected'); } catch { protectedInput = true; }
        let rejected = 0;
        for (const chunks of [[9], [5, 4]]) {
          const output = await limited.openWrite('/output/limited');
          try { for (const size of chunks) await output.write(new Uint8Array(size)); }
          catch (error) { if (error instanceof RangeError) rejected++; else throw error; }
          await output.abort();
        }
        let invalid = 0;
        for (const output of [
          { writableMounts: ['/output'], stagingPrefix: 'result/stage', partBytes: 5 * 1024 * 1024, maxWriteBytes: 8, maxOutputBytes: 8 },
          { writableMounts: ['/output'], stagingPrefix, partBytes: 1, maxWriteBytes: 8, maxOutputBytes: 8 }
        ]) { try { createR2FileSystem({ bucket, mounts: { '/output': 'result' }, maxReadBytes: 8, output }); } catch { invalid++; } }
        return Response.json({ rejected, invalid, protectedInput, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/raw')) {
        const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-n','-f','s16le','-ar','8000','-ac','1','-i','/input/audio.raw','-af','volume=0.5','-f','f32le','/output/audio.raw']);
        return Response.json({exitCode:result.exitCode,diagnostics:result.diagnostics,remaining:(await env.MEDIA_BUCKET.list({prefix:stagingPrefix})).objects.length});
      }
      if (route.endsWith('/volume')) {
        const frontend=new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const result=await frontend.exec(['-cpuflags','0','-n','-i','/input/audio.wav','-af','anull,volume=0.5,anull','-c:a','pcm_s16le','/output/volume.wav']);
        return Response.json({exitCode:result.exitCode,diagnostics:result.diagnostics,remaining:(await env.MEDIA_BUCKET.list({prefix:stagingPrefix})).objects.length});
      }
      if (route.endsWith('/time')) {
        const frontend = new FFmpeg({filesystem:files,backend:createWavBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
        const codes=[];
        for(const codec of ['copy','pcm_s16le']) codes.push((await frontend.exec(['-n','-i','/input/audio.wav','-ss','0.15','-t','0.35','-c:a',codec,`/output/time-${codec}.wav`])).exitCode);
        return Response.json({codes,remaining:(await env.MEDIA_BUCKET.list({prefix:stagingPrefix})).objects.length});
      }
      if (route.endsWith('/pcm') || route.endsWith('/pcm-float')) {
        const frontend = new FFmpeg({ filesystem: files, backend: createWavBackend(), budget: { maxResidentBytes: 16 * 1024 * 1024, maxBufferBytes: 8, maxPendingPackets: 2, maxCpuTimeMs: 1000 } });
        const result = await frontend.exec(['-n', '-i', '/input/audio.wav', '-c:a', route.endsWith('/pcm-float') ? 'pcm_f32le' : 'pcm_u8', route.endsWith('/pcm-float') ? '/output/float.wav' : '/output/converted.wav']);
        return Response.json({ exitCode: result.exitCode, diagnostics: result.diagnostics, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/wav')) {
        const result = await new FFmpeg({ filesystem: files, backend: createWavBackend(), budget: { maxResidentBytes: 16 * 1024 * 1024, maxBufferBytes: 8, maxPendingPackets: 2, maxCpuTimeMs: 1000 } }).exec(['-n', '-i', '/input/audio.wav', '-c', 'copy', '/output/actual.wav']);
        return Response.json({ exitCode: result.exitCode, diagnostics: result.diagnostics, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/large')) {
        const output = await files.openWrite('/output/large');
        for (let i = 0; i < 128; i++) await output.write(new Uint8Array(65536).fill(i));
        const visibleBefore = await env.MEDIA_BUCKET.head('result/large');
        await output.commit(); await output.commit();
        return Response.json({ visibleBefore: visibleBefore !== null, size: (await env.MEDIA_BUCKET.head('result/large'))?.size, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/uncertain')) {
        const output = await files.openWrite('/output/uncertain'); await output.write(new Uint8Array([1,2]));
        try { await output.commit(); }
        catch (error) {
          if (!(error instanceof R2CommitUncertainError)) throw error;
          await output.abort();
          const unresolved = await recoverPublishedR2Output(env.MEDIA_BUCKET, { key: 'result/missing', stagingKey: error.stagingKey, transactionId: error.transactionId });
          const retained = (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length;
          const recovered = await recoverPublishedR2Output(env.MEDIA_BUCKET, error);
          return Response.json({ retained, unresolved, recovered, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
        }
        return new Response('Expected uncertain commit', { status: 500 });
      }
      if (route.endsWith('/collision')) {
        const a = await files.openWrite('/output/collision'), b = await files.openWrite('/output/collision');
        await a.write(new Uint8Array([1])); await b.write(new Uint8Array([2]));
        await a.commit(); let rejected = false;
        try { await b.commit(); } catch { rejected = true; await b.abort(); }
        const replace = await files.openWrite('/output/collision', { overwrite: true }); await replace.write(new Uint8Array([3])); await replace.commit();
        return Response.json({ rejected, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/abort')) {
        const output = await files.openWrite('/output/aborted'); await output.write(new Uint8Array([1,2]));
        await output.abort(); await output.abort();
        return Response.json({ visible: (await env.MEDIA_BUCKET.head('result/aborted')) !== null, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
      if (route.endsWith('/empty')) {
        const output = await files.openWrite('/output/empty'); await output.commit();
        return Response.json({ size: (await env.MEDIA_BUCKET.head('result/empty'))?.size, remaining: (await env.MEDIA_BUCKET.list({ prefix: stagingPrefix })).objects.length });
      }
    }
    if (route === '/exec') {
      const sink = collectingOutput();
      const frontend = new FFmpeg({ filesystem: { openRead: path => fs.openRead(path), async openWrite() { return sink.output; } }, backend: createWavBackend(), budget: { maxResidentBytes: 1024, maxBufferBytes: 8, maxPendingPackets: 2, maxCpuTimeMs: 1000 } });
      const result = await frontend.exec(['-i', '/input/audio.wav', '-c:a', 'copy', '/output/audio.wav'], { signal: runtime.signal });
      return Response.json({ result, committed: sink.committed, bytes: [...sink.bytes()] });
    }
    if (route === '/wav-remux') {
      const wav = await openWav(await fs.openRead('/input/audio.wav'), { maxReadBytes: 8, signal: runtime.signal });
      if (wav.info.codec !== 'pcm_s16le') throw new Error('Fixture expects PCM s16le');
      // Small-fixture sink only. The production mux accepts a transactional streaming WriteHandle.
      const sink = collectingOutput();
      await muxWav(sink.output, { codec: 'pcm_s16le', sampleRate: wav.info.sampleRate, channels: wav.info.channels }, wav.packets(), { sampleCount: wav.info.durationSamples, maxWriteBytes: 3, signal: runtime.signal });
      return Response.json({ committed: sink.committed, bounded: sink.lengths.every(length => length <= 3), bytes: [...sink.bytes()] });
    }
    if (route === '/wav') {
      const input = await fs.openRead('/input/audio.wav');
      const wav = await openWav(input, { maxReadBytes: runtime.resources.budget.maxBufferBytes, signal: runtime.signal });
      const packets = [];
      for await (const packet of wav.packets()) packets.push({ pts: packet.pts?.toString(), duration: packet.duration?.toString(), bytes: [...packet.data] });
      return Response.json({ codec: wav.info.codec, duration: wav.info.durationSamples.toString(), packets });
    }
    if (route === '/plan') {
      const registry = new FeatureRegistry<OperatorDescriptor>();
      const traits = { state: 'stateless', access: 'sequential', checkpointable: false, temporal: false, deterministic: true, minimumMemoryBytes: 2, estimatedCpuTimeMs: null } as const;
      registry.register({ id: 'fixture.source', status: 'partial', runtimes: ['cloudflare'], testCases: [], kind: 'source', inputs: [], outputs: [{ name: 'out', type: 'packet' }], traits });
      registry.register({ id: 'fixture.sink', status: 'partial', runtimes: ['cloudflare'], testCases: [], kind: 'sink', inputs: [{ name: 'in', type: 'packet' }], outputs: [], traits });
      const plan = planGraph({ nodes: [{ id: 'b', featureId: 'fixture.sink' }, { id: 'a', featureId: 'fixture.source' }], edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' }, queueCapacity: 2 }] }, registry, 'cloudflare', runtime.resources.budget);
      return Response.json({ order: plan.nodes.map(node => node.id), memory: plan.minimumMemoryBytes, slots: plan.reservedPacketSlots, immutable: Object.isFrozen(plan.nodes[0]?.operator.traits) });
    }
    if (route === '/queue') {
      const queue = new PacketQueue<number>(runtime.resources.budget.maxPendingPackets, () => {}, request.signal);
      let maximum = 0;
      const producer = async () => {
        for (let i = 0; i < 12; i++) {
          const slot = await queue.reserve();
          maximum = Math.max(maximum, queue.pendingPackets);
          slot.publish(i);
        }
        queue.close();
      };
      const consumer = async () => {
        const values: number[] = [];
        for await (const value of queue) values.push(value);
        return values;
      };
      const [, values] = await Promise.all([producer(), consumer()]);
      return Response.json({ values, maximum, pending: queue.pendingPackets });
    }
    if (route === '/read') {
      const input = await fs.openRead('/input/example');
      const data = await input.readAt(2n, 8);
      await runtime.checkpoint();
      return Response.json({ size: input.size.toString(), data: [...data], pts: rescale(3n, rational(1001n, 30000n), rational(1n, 1000n)).toString() });
    }
    if (route === '/mutation' || route === '/same-bytes') {
      const input = await fs.openRead('/input/example');
      await env.MEDIA_BUCKET.put('source/example', route === '/same-bytes' ? '0123456789' : 'different!');
      try { await input.readAt(0n, 2); }
      catch (error) { if (error instanceof InputChangedError) return new Response('detected'); throw error; }
      return new Response('missed', { status: 500 });
    }
    if (route === '/bounds') {
      const input = await fs.openRead('/input/example');
      let rejected = 0;
      for (const [offset, length] of [[-1n, 1], [0n, 9], [0n, -1]] as const) {
        try { await input.readAt(offset, length); } catch (error) { if (error instanceof RangeError) rejected++; else throw error; }
      }
      for (const path of ['/input/../secret', '/input2/example', '/input/./example']) {
        try { await fs.openRead(path); } catch { rejected++; }
      }
      const empty = await input.readAt(input.size, 1);
      const tail = await input.readAt(9n, 8);
      const abort = new AbortController(); abort.abort();
      try { await input.readAt(0n, 1, abort.signal); } catch { rejected++; }
      return Response.json({ rejected, empty: empty.length, tail: [...tail] });
    }
    if (route === '/budget') {
      const first = runtime.resources.allocate(8);
      runtime.resources.allocate(8);
      let rejected = false;
      try { runtime.resources.allocate(1); } catch (error) { if (error instanceof RangeError) rejected = true; else throw error; }
      first.release(); first.release();
      return Response.json({ rejected, allocated: runtime.resources.allocatedBytes });
    }
    return new Response('Unknown test', { status: 404 });
  }
} satisfies ExportedHandler<Env>;
