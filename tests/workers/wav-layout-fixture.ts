import {FFmpeg} from '@edge-ffmpeg/core';
import {createWavBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
export default {async fetch(request:Request):Promise<Response>{
 const job=await request.json() as {input:number[];guess:boolean},input=Uint8Array.from(job.input),sink=collectingOutput(),reads:number[]=[];
 const result=await new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){reads.push(length);return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return sink.output;}},backend:createWavBackend(),budget:{maxResidentBytes:1048576,maxBufferBytes:64,maxPendingPackets:4,maxCpuTimeMs:10000}}).exec(['-y',...(job.guess?[]:['-guess_layout_max','0']),'-i','/input.wav','-c:a','copy','-bitexact','/output.wav']);
 return Response.json({exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,data:Array.from(sink.bytes()),committed:sink.committed,aborted:sink.aborted,maximumRead:Math.max(0,...reads),maximumWrite:Math.max(0,...sink.lengths)});
}};
