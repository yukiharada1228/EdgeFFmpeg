import {executeFlacDecode} from './flac-decode.js';
import type {FlacBackendConfiguration} from './flac-decode.js';
import {probeFlacInput,executeFlacCopy} from './flac-copy.js';
import {executeFlacRemux} from './flac-wave-remux.js';
import {defaultChannelLayout} from '@edge-ffmpeg/avutil';
import {executeSimpleMultiVideo} from './simple-multi-video.js';
import {probeRawRead} from './raw-read-probe.js';
import {assertOutputPolicy} from './output-policy.js';
import {createMp4H264Backend,wantsMp4H264Decode} from './mp4-h264.js';
import type {H264BackendConfiguration} from './mp4-h264.js';
import {createBmpBackend} from './bmp-stream.js';
import {wantsMp4Copy,executeMp4Copy,preflightMp4Copy} from './mp4-copy.js';
import {executeComplexVideo} from './complex-video.js';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {executeRawVideo} from './raw-video.js';
import {filteredPacketSchedule,slicePacketSchedule} from './packet-schedule.js';
import {clipPacketSections,packetSectionSamplesForFrames} from './packet-sections.js';
import {remixAudioFrame,remixInternalFormat,convertAudioFrame,resampleAudio,resampleInternalFormat,resampledSampleCount,planAudioResample} from '@edge-ffmpeg/swresample';
import type {RemixArithmetic} from '@edge-ffmpeg/swresample';
import { planPcmMemory } from './memory-plan.js';
import type { AudioFrameData, PcmCodec } from '@edge-ffmpeg/avutil';
import { parseFrameLimit } from '@edge-ffmpeg/cli';
import { compileAudioFilterChain } from '@edge-ffmpeg/avfilter';
import type { AudioFilterChain } from '@edge-ffmpeg/avfilter';
import { timeOptions, setTimeOption, resolveDuration, pcmTimeRange, pcmPacketSpan } from './time-range.js';
import type { MediaPacket } from '@edge-ffmpeg/core';
import { decodePcm, encodePcm, isIntegerPcm, getPcmFormat, isPcmCodec as isPcm } from '@edge-ffmpeg/avcodec';
import { ExecutionError } from '@edge-ffmpeg/core';
import type { ReadHandle, ExecutionBackend } from '@edge-ffmpeg/core';
import { openWav, muxWav, openRawPcm, muxRawPcm, rawPcmCodec, muxFrameCrc, supportsWavCodec, openAiff, muxAiff, supportsAiffCodec, validateAiffOutput, detectAudioContainer, openAu, muxAu, supportsAuCodec, validateAuOutput } from '@edge-ffmpeg/containers';
function requirePcm(codec: string | null): PcmCodec {
  if (codec === null || !isPcm(codec)) throw new ExecutionError('unsupported-command', `Unsupported PCM codec: ${codec}`);
  return codec;
}
function positiveInteger(value: string | null, name: string): number {
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2147483647) throw new ExecutionError('invalid-arguments', `Invalid ${name}`);
  return Number(value);
}
/** Finite audio and declared rawvideo backend. No native execution fallback. */
export interface MediaBackendOptions {readonly remixArithmetic?:RemixArithmetic;readonly pixelArithmetic?:PixelArithmetic;readonly h264?:H264BackendConfiguration;readonly flac?:FlacBackendConfiguration}
export function createMediaBackend(options:MediaBackendOptions={}): ExecutionBackend {
  const remixArithmetic=options.remixArithmetic??'separate',pixelArithmetic=options.pixelArithmetic??'aarch64';
  if(!['aarch64','scalar','x86_64'].includes(pixelArithmetic))throw new ExecutionError('unsupported-command','Invalid pixel arithmetic profile');
  const flac=options.flac?Object.freeze({...options.flac,remixArithmetic:options.flac.remixArithmetic??remixArithmetic}):null;
  const h264=options.h264?createMp4H264Backend(options.h264,pixelArithmetic):null;
  if(remixArithmetic!=='separate'&&remixArithmetic!=='fused')throw new ExecutionError('unsupported-command','Invalid remix arithmetic profile');
  return {
    async execute(command, context) {
      // Provider callbacks must not change the request or VFS capabilities after probing.
      command={global:command.global.map(option=>({...option})),inputs:command.inputs.map(file=>({url:file.url,options:file.options.map(option=>({...option}))})),outputs:command.outputs.map(file=>({url:file.url,options:file.options.map(option=>({...option}))}))};
      const filesystem=context.filesystem;
      context={...context,budget:Object.freeze({...context.budget}),filesystem:Object.freeze({openRead:filesystem.openRead.bind(filesystem),openWrite:filesystem.openWrite.bind(filesystem),...(filesystem.outputExists?{outputExists:filesystem.outputExists.bind(filesystem)}:{})}),...(context.reportDiagnostic?{reportDiagnostic:context.reportDiagnostic.bind(context)}:{})};
      const unsupported = (message: string): never => { throw new ExecutionError('unsupported-command', message); };
      if(command.inputs.some(file=>file.options.filter(option=>option.name==='-f').at(-1)?.value==='image2pipe'))return createBmpBackend().execute(command,context);
      // An undeclared input is magic probed (opened) below. A request already routed to MP4 copy is checked first, so its refusals open nothing.
      if(command.inputs.length===1&&!command.inputs[0]!.options.some(option=>option.name==='-f')&&!wantsMp4H264Decode(command)&&wantsMp4Copy(command))preflightMp4Copy(command,context);
      const probeFilesystem=context.filesystem,probeUrl=command.inputs[0]?.url;
      let probedReader:ReadHandle|undefined;
      const flacInput=await probeFlacInput(command,{...context,filesystem:{...probeFilesystem,openRead:url=>probeFilesystem.openRead(url).then(handle=>{
        const retained=Object.freeze({size:handle.size,readAt:handle.readAt.bind(handle)});
        if(url===probeUrl)probedReader=retained;
        return retained;
      })}});
      // Non-FLAC dispatch also consumes the same source accepted by the probe.
      const acceptedReader=probedReader;
      if(acceptedReader)context={...context,filesystem:{...probeFilesystem,openRead:url=>url===probeUrl?Promise.resolve(acceptedReader):probeFilesystem.openRead(url)}};
      if(flacInput){
        const codecs=command.outputs[0]?.options.filter(option=>/^-(c|codec)(?::(?:a(?::0)?|0))?$/.test(option.name)||option.name==='-acodec')??[];
        if(codecs.at(-1)?.value==='copy'){
          const output=command.outputs[0]!,format=output.options.filter(option=>option.name==='-f').at(-1)?.value;
          if(format==='flac'||format===undefined&&/\.flac$/i.test(output.url))return executeFlacRemux(command,context,flacInput.handle);
          return executeFlacCopy(command,context,flacInput.handle);
        }
        if(!flac)unsupported('FLAC codec module is not configured; provide a trusted precompiled module');
        return executeFlacDecode(command,context,flac!,flacInput.handle);
      }
      if(wantsMp4H264Decode(command)){if(!h264)unsupported('H264 codec module is not configured');return h264!.execute(command,context);}
      if(wantsMp4Copy(command))return executeMp4Copy(command,context);
      if(command.global.some(option=>['-filter_complex','-lavfi'].includes(option.name)))return executeComplexVideo(command,context,pixelArithmetic);
      if((command.inputs.length>1||command.outputs.length>1)&&command.inputs.every(input=>input.options.filter(option=>option.name==='-f').at(-1)?.value==='rawvideo'))return executeSimpleMultiVideo(command,context,pixelArithmetic);
      if (command.inputs.length !== 1 || command.outputs.length !== 1) unsupported('PCM backend currently requires one input and one output');
      const input = command.inputs[0]!, output = command.outputs[0]!;
      for (const file of [input, output]) if (!file.url.startsWith('/') || file.url === '/') unsupported('PCM backend requires absolute virtual file paths');
      if (input.url.replace(/\/{2,}/g, '/') === output.url.replace(/\/{2,}/g, '/')) unsupported('Input and output paths must differ');
      if(input.options.filter(option=>option.name==='-f').at(-1)?.value==='rawvideo')return executeRawVideo(command,context,pixelArithmetic);
      let overwrite = false, noOverwrite = false, scalarConversion = false, bitexact = false, exitOnError = false;
      for (const option of command.global) {
        if (option.name === '-xerror' || option.name === '-noxerror') exitOnError = option.name === '-xerror';
        else if (option.name === '-y') overwrite = true;
        else if (option.name === '-n') noOverwrite = true;
        else if (option.name === '-cpuflags' && option.value === '0') scalarConversion = true;
        else if (option.name !== '-hide_banner') unsupported(`Unsupported global option: ${option.name}`);
      }
      const inputTime = timeOptions(), outputTime = timeOptions();
      let inputFormat: string | null = null, inputRate: number | null = null, inputChannels: number | null = null, guessLayoutMax = 2147483647;
      for (const option of input.options) {
        if (setTimeOption(inputTime,option.name,option.value)) continue;
        if (option.name === '-bitexact') continue;
        if (option.name === '-fflags' && ['bitexact','+bitexact'].includes(option.value ?? '')) continue;
        if (option.name === '-f') inputFormat = option.value;
        else if (option.name === '-ar') inputRate = positiveInteger(option.value,'input sample rate');
        else if (option.name === '-guess_layout_max') {
          if (!/^\d+$/.test(option.value ?? '') || !Number.isSafeInteger(Number(option.value)) || Number(option.value) > 2147483647) throw new ExecutionError('invalid-arguments','Invalid layout guessing threshold');
          guessLayoutMax = Number(option.value);
        }
        else if (option.name === '-ac') inputChannels = positiveInteger(option.value,'input channel count');
        else unsupported(`Unsupported input option: ${option.name}`);
      }
      const rawInputCodec = inputFormat === null || inputFormat === 'wav' || inputFormat === 'aiff' || inputFormat === 'au' ? null : rawPcmCodec(inputFormat);
      if (inputFormat !== null && inputFormat !== 'wav' && inputFormat !== 'aiff' && inputFormat !== 'au' && !rawInputCodec) unsupported(`Unsupported input format: ${inputFormat}`);
      if (!rawInputCodec && (inputRate !== null || inputChannels !== null)) unsupported('Input rate/channel declarations currently require a raw PCM format');
      let maxFrames: bigint | null = null;
      let codec: string | null = null, outputFormat: string | null = null, maps = 0, filterSpec: string | null = null, outputRate: number | null = null, outputChannels: number | null = null;
      for (const option of output.options) {
        if (setTimeOption(outputTime, option.name, option.value)) continue;
        if (['-c', '-codec', '-c:a', '-codec:a', '-c:a:0', '-codec:a:0', '-c:0', '-codec:0'].includes(option.name)) codec = option.value;
        else if (['-af','-filter','-filter:a','-filter:a:0','-filter:0'].includes(option.name)) filterSpec = option.value;
        else if (['-frames','-frames:a','-frames:a:0','-frames:0','-aframes'].includes(option.name)) {
          try { maxFrames = parseFrameLimit(option.value ?? ''); }
          catch (error) { throw new ExecutionError('invalid-arguments',error instanceof Error ? error.message : String(error)); }
        }
        else if (option.name === '-bitexact') bitexact = true;
        else if (option.name === '-fflags' && ['bitexact','+bitexact'].includes(option.value ?? '')) bitexact = true;
        else if (option.name === '-f') outputFormat = option.value;
        else if (option.name === '-ar') outputRate = positiveInteger(option.value,'output sample rate');
        else if (option.name === '-ac') outputChannels = positiveInteger(option.value,'output channel count');
        else if (option.name === '-map') {
          if (++maps > 1 || !['0', '0:0', '0:a', '0:a:0'].includes(option.value ?? '')) unsupported('Only one mapping of the PCM audio stream is supported');
        } else if (!['-vn', '-sn', '-dn'].includes(option.name)) unsupported(`Unsupported output option: ${option.name}`);
      }
      if(outputFormat===null){const path=output.url.toLowerCase();if(path.endsWith('.au')||path.endsWith('.snd'))outputFormat='au';else if(path.endsWith('.wav'))outputFormat='wav';else if(['.aif','.aiff','.aifc'].some(extension=>path.endsWith(extension)))outputFormat='aiff';}
      const rawOutputCodec = outputFormat === null || outputFormat === 'wav' || outputFormat === 'au' ? null : rawPcmCodec(outputFormat);
      if (outputFormat !== 'wav' && outputFormat !== 'aiff' && outputFormat !== 'au' && outputFormat !== 'framecrc' && !rawOutputCodec) unsupported('Output requires WAV, AIFF, AU, framecrc or an explicit raw PCM format');
      if (codec === null) codec = rawOutputCodec ?? (['aiff','au'].includes(outputFormat??'')?'pcm_s16be':'pcm_s16le');
      let filters: AudioFilterChain | undefined;
      if (filterSpec !== null) {
        try { filters = compileAudioFilterChain(filterSpec,{outputSampleFormat:getPcmFormat(requirePcm(codec === 'copy' ? 'pcm_s16le' : codec)).sampleFormat}); }
        catch (error) { throw new ExecutionError('unsupported-filter', error instanceof Error ? error.message : String(error)); }
        if (codec === 'copy') unsupported('Filtering and stream copy cannot be combined');
      }
      resolveDuration(inputTime); resolveDuration(outputTime);
      if (codec !== 'copy' && !isPcm(codec)) unsupported('Unsupported PCM codec');
      context.signal.throwIfAborted();
      const acceptedSource = await context.filesystem.openRead(input.url);
      const rawProbe = rawInputCodec ? await probeRawRead(acceptedSource,context.signal) : {input:acceptedSource,failure:null};
      const source = rawProbe.input;
      const inputContainer=rawInputCodec?'raw':inputFormat??await detectAudioContainer(source,context.budget.maxBufferBytes,context.signal);
      const audio = rawInputCodec
        ? await openRawPcm(source,{codec:rawInputCodec,channels:inputChannels??1,sampleRate:inputRate??44100,...((inputChannels??1)>guessLayoutMax?{channelMask:null}:{}),maxReadBytes:context.budget.maxBufferBytes,signal:context.signal})
        : inputContainer==='au'?await openAu(source,{maxReadBytes:context.budget.maxBufferBytes,signal:context.signal}):inputContainer==='aiff'?await openAiff(source,{maxReadBytes:context.budget.maxBufferBytes,signal:context.signal}):await openWav(source, { maxReadBytes: context.budget.maxBufferBytes, signal: context.signal });
      const filteredRate = filters?.outputSampleRate(audio.info.sampleRate) ?? audio.info.sampleRate;
      const resultRate=outputRate??filteredRate,resampling=resultRate!==filteredRate;
      const channels=outputChannels??audio.info.channels,remixing=channels!==audio.info.channels;
      if(remixing){
        if(codec==='copy')unsupported('Channel conversion and stream copy cannot be combined');
        if(![1,2].includes(channels)||![1,2].includes(audio.info.channels))unsupported('Only mono/stereo channel conversion is implemented');
        const mask=audio.info.channelMask??0,canonical=audio.info.channels===1?4:3;
        if(mask?mask!==canonical:audio.info.channels>guessLayoutMax)unsupported('Channel conversion requires a canonical mono/stereo input layout');
      }
      if(remixing&&filterSpec!==null)filters=compileAudioFilterChain(filterSpec,{outputSampleFormat:'flt'});
      if (!rawProbe.failure && !['aiff','au'].includes(inputContainer) && inputTime.seek > 0n && inputTime.seek * BigInt(audio.info.sampleRate) >= audio.info.durationSamples * 1000000n) throw new ExecutionError('unsupported-seek', 'Input seek at or beyond EOF requires unimplemented native I/O fallback semantics');
      const pcmCodec = requirePcm(audio.info.codec);
      const outputCodec = requirePcm(codec === 'copy' ? pcmCodec : codec);
      const auCodec=supportsAuCodec(outputCodec)?outputCodec:null;
      if(outputFormat==='au'&&auCodec===null)unsupported(`AU muxer does not support ${outputCodec}`);
      const aiffCodec=supportsAiffCodec(outputCodec)?outputCodec:null;
      if(outputFormat==='aiff'&&aiffCodec===null)unsupported(`AIFF muxer does not support ${outputCodec}`);
      const wavCodec=supportsWavCodec(outputCodec)?outputCodec:null;
      if(outputFormat==='wav'&&wavCodec===null)unsupported(`WAV muxer does not support ${outputCodec}`);
      if (rawOutputCodec && rawOutputCodec !== outputCodec) unsupported('Raw PCM mux format must match the selected codec');
      await assertOutputPolicy(context,output.url,overwrite,noOverwrite);
      if(rawProbe.failure){if(exitOnError)throw rawProbe.failure;context.reportDiagnostic?.({code:rawProbe.failure.code,message:rawProbe.failure.message});}
      const sourceSampleFormat=getPcmFormat(pcmCodec).sampleFormat,targetSampleFormat=getPcmFormat(outputCodec).sampleFormat;
      const mixSource=filters?.resolvedSampleFormat(sourceSampleFormat)??sourceSampleFormat,mixInternal=remixInternalFormat(mixSource,targetSampleFormat);
      const rateBoundary=resampling?filters?.rateBoundary(sourceSampleFormat,audio.info.sampleRate,resultRate):null;
      const resampleFormat=resampleInternalFormat(rateBoundary?.inputFormat??mixSource,rateBoundary?.outputFormat??targetSampleFormat),resampleWidth=resampleFormat==='dbl'?8:resampleFormat==='flt'?4:2;
      if(resampling){
        if(codec==='copy'||remixing)unsupported('Rate conversion currently requires unchanged channels and encoding');
      }
      const padding=filters?.steps.some(step=>step.name==='apad')??false;
      const packetDuration=resolveDuration(outputTime);
      const packetSubsample=(padding||resampling)&&packetDuration!==null&&packetDuration>0n&&(packetDuration*BigInt(resultRate)+500000n)/1000000n===0n;
      const packetTime=packetSubsample?{...outputTime,duration:null,stop:null}:outputTime;
      const scalarRequired = resampling || (remixing&&mixInternal!=='s16') || (filters ? filters.requiresScalarRounding(getPcmFormat(pcmCodec).sampleFormat) : !isIntegerPcm(pcmCodec) && isIntegerPcm(outputCodec));
      if (codec !== 'copy' && scalarRequired && !scalarConversion) unsupported('This conversion currently requires -cpuflags 0 to pin scalar rounding/rematrix arithmetic');
      const sampleBytes = Math.max(resampling?resampleWidth:0,getPcmFormat(pcmCodec).frameBytesPerSample, getPcmFormat(outputCodec).frameBytesPerSample, filters?.maxBytesPerSample ?? 0,remixing?(mixInternal==='dbl'?8:mixInternal==='flt'?4:2):0);
      const inputSpan=inputContainer==='aiff'?BigInt(Math.floor(4096/audio.info.blockAlign)):pcmPacketSpan(audio.info.sampleRate);
      const inputRange = pcmTimeRange(audio.info.durationSamples,audio.info.sampleRate,inputTime,timeOptions(),false,null,audio.info.sampleRate,inputSpan);
      const filterSamplePlan=filters?.planSamples(inputRange.samples,audio.info.sampleRate,{...(rateBoundary?{rateBoundary}:{}),configuredInput:true});
      const filterBuffers=filterSamplePlan?.buffers??[],filterBufferSamples=Math.max(0,...filterBuffers);
      if(filterBufferSamples*Math.max(audio.info.channels,channels)*sampleBytes>context.budget.maxBufferBytes)throw new ExecutionError('resource-budget','Reframed audio exceeds the configured buffer budget');
      const transformedSamples=resampling
        ? filterSamplePlan?.samples??resampledSampleCount(inputRange.samples,filteredRate,resultRate)
        : inputRange.samples;
      let range = resampling
        ? pcmTimeRange(transformedSamples,resultRate,timeOptions(),packetTime,false,null,resultRate)
        : filters?.reframes
        ? pcmTimeRange(filters.outputSamples(inputRange.samples,audio.info.sampleRate,{configuredInput:true}),filteredRate,timeOptions(),padding?packetTime:outputTime,false,padding?null:maxFrames,filteredRate,filters.outputPacketSamples(inputRange.span))
        : pcmTimeRange(audio.info.durationSamples, audio.info.sampleRate, inputTime, outputTime, codec === 'copy', maxFrames, filteredRate, inputSpan);
      let resampledSchedule=resampling?filteredPacketSchedule(inputRange.samples,inputSpan,audio.info.sampleRate,resultRate,filterSamplePlan):undefined;
      if(resampledSchedule){
        resampledSchedule=slicePacketSchedule(resampledSchedule,range.start,range.samples);
        const limit=packetSubsample?(maxFrames===null||maxFrames>1n?1n:maxFrames):maxFrames;
        if(limit!==null){range={...range,samples:resampledSchedule.samplesForPackets(limit)};resampledSchedule=slicePacketSchedule(resampledSchedule,0n,range.samples);}
      }
      let paddingSections:ReturnType<typeof clipPacketSections>|undefined;
      if(padding&&!resampling){
        paddingSections=clipPacketSections(filters!.packetSections(inputRange.samples,inputSpan,audio.info.sampleRate,true),range.start,range.samples);
        const limit=packetSubsample?(maxFrames===null||maxFrames>1n?1n:maxFrames):maxFrames;
        if(limit!==null){range={...range,samples:packetSectionSamplesForFrames(paddingSections,limit)};paddingSections=clipPacketSections(paddingSections,0n,range.samples);}
      }
      const readRange = resampling||filters?.reframes ? inputRange : range;
      let resamplePlan:ReturnType<typeof planAudioResample>|undefined;
      if(resampling){
        try{resamplePlan=planAudioResample(rateBoundary?.inputRate??filteredRate,resultRate,channels,{maxFrameBytes:context.budget.maxBufferBytes,maxStateBytes:context.budget.maxResidentBytes,sampleFormat:resampleFormat});}
        catch(error){throw new ExecutionError('resource-budget',error instanceof Error?error.message:String(error));}
        if(resamplePlan.stateBytes+context.budget.maxBufferBytes>context.budget.maxResidentBytes)throw new ExecutionError('resource-budget','Resampler state and one payload buffer exceed the resident-byte budget');
      }
      const payloadBudget=resamplePlan?{...context.budget,maxResidentBytes:context.budget.maxResidentBytes-resamplePlan.stateBytes}:context.budget;
      const memoryPlan=planPcmMemory({budget:payloadBudget,resample:resampling,channels:Math.max(audio.info.channels,channels),remix:remixing,inputBytesPerSample:getPcmFormat(pcmCodec).bytesPerSample,widestBytesPerSample:sampleBytes,copy:codec==='copy',volumeNodes:filters?.steps.filter(step=>step.name==='volume'||step.name==='apad'||step.name==='aformat'&&step.sampleFormat!==null).length??0,reframeSamples:filterBuffers,sourceSamples:range.samples===0n?0n:readRange.samples,generatedOutput:padding&&range.samples>0n&&readRange.samples===0n,inputHeaderBytes:rawInputCodec?0:128,outputScratchBytes:outputFormat==='framecrc'?512:['wav','aiff','au'].includes(outputFormat??'')?128:0});
      const guessLayout = audio.info.channels <= guessLayoutMax;
      async function* selectedPackets(): AsyncIterable<MediaPacket> {
        if (readRange.samples === 0n) return;
        const packets = audio.packets(readRange.start, Math.max(1,memoryPlan.packetSamples) * audio.info.blockAlign);
        let emitted = 0n;
        for await (const packet of packets) {
          const remaining = readRange.samples - emitted;
          const duration = packet.duration! < remaining ? packet.duration! : remaining;
          yield { ...packet, data: packet.data.subarray(0, Number(duration) * audio.info.blockAlign), pts: emitted, dts: emitted, duration };
          emitted += duration;
          if (emitted === readRange.samples) break;
        }
      }
      const sourcePackets = selectedPackets();
      async function* decoded():AsyncIterable<AudioFrameData> {
        for await (const packet of sourcePackets) yield decodePcm(packet,{codec:pcmCodec,channels:audio.info.channels,sampleRate:audio.info.sampleRate,...(!guessLayout && !audio.info.channelMask ? {channelLayout:`${audio.info.channels} channels`} : {})},{maxFrameBytes:context.budget.maxBufferBytes,signal:context.signal});
      }
      async function* selectedFrames(frames:AsyncIterable<AudioFrameData>):AsyncIterable<AudioFrameData> {
        if(range.samples===0n)return;
        let consumed=0n,emitted=0n;
        for await(const frame of frames){
          context.signal.throwIfAborted();
          const end=consumed+BigInt(frame.samples),start=consumed;consumed=end;
          if(end<=range.start)continue;
          const skip=range.start>start?range.start-start:0n;
          const available=BigInt(frame.samples)-skip,remaining=range.samples-emitted,count=available<remaining?available:remaining;
          const align=frame.planes[0]!.length/frame.samples;
          yield {...frame,samples:Number(count),planes:frame.planes.map(plane=>plane.subarray(Number(skip)*align,Number(skip+count)*align)),pts:{value:emitted,timeBase:{num:1n,den:BigInt(resultRate)}}};
          emitted+=count;
          if(emitted===range.samples)break;
        }
      }
      const filterInputFormat={sampleRate:audio.info.sampleRate,channels:audio.info.channels,channelLayout:!guessLayout&&!audio.info.channelMask?`${audio.info.channels} channels`:audio.info.channels===1?'mono':audio.info.channels===2?'stereo':'unspecified',sampleFormat:sourceSampleFormat,pts:{value:0n,timeBase:{num:1n,den:BigInt(audio.info.sampleRate)}}};
      // Validate even when an empty output never pulls the encoded generator.
      filters?.validateInputFormat(filterInputFormat,...(resampling?[{beforeStep:rateBoundary!.beforeStep,transform:(frames:AsyncIterable<AudioFrameData>)=>frames,outputFormat:{...filterInputFormat,sampleRate:resultRate,sampleFormat:rateBoundary!.outputFormat}}]:[]));
      async function* encoded() {
        const options={maxFrameBytes:context.budget.maxBufferBytes,signal:context.signal};
        const transform=(upstream:AsyncIterable<AudioFrameData>):AsyncIterable<AudioFrameData>=>{
          async function* internalFrames(){for await(const frame of upstream)yield frame.sampleFormat===resampleFormat?frame:convertAudioFrame(frame,resampleFormat,options);}
          const sampled=resampleAudio(internalFrames(),resultRate,{...options,sampleFormat:resampleFormat,maxFrameBytes:Math.max(1,memoryPlan.packetSamples,filterBufferSamples)*channels*resampleWidth,maxStateBytes:resamplePlan!.stateBytes});
          async function* negotiatedFrames(){for await(const frame of sampled)yield rateBoundary&&frame.sampleFormat!==rateBoundary.outputFormat?convertAudioFrame(frame,rateBoundary.outputFormat,options):frame;}
          return negotiatedFrames();
        };
        const frames=filters?filters.process(decoded(),{...options,inputFormat:filterInputFormat},...(resampling?[{beforeStep:rateBoundary!.beforeStep,transform,outputFormat:{...filterInputFormat,sampleRate:resultRate,sampleFormat:rateBoundary!.outputFormat,pts:{value:0n,timeBase:{num:1n,den:BigInt(resultRate)}}}}]:[])):resampling?transform(decoded()):decoded();
        for await(const frame of resampling||filters?.reframes?selectedFrames(frames):frames){const output=remixing?remixAudioFrame(frame,channels as 1|2,targetSampleFormat,{...options,arithmetic:remixArithmetic}):frame;yield encodePcm(output,outputCodec,options);}
      }
      let channelLayout = '';
      if (outputFormat === 'framecrc') {
        const layouts: Record<number,string> = {4:'mono',3:'stereo',11:'2.1',7:'3.0',263:'4.0',51:'quad',55:'5.0',63:'5.1',1543:'5.0(side)',1551:'5.1(side)',1807:'6.1',1599:'7.1'};
        const inferred=defaultChannelLayout(audio.info.channels);
        channelLayout = remixing?(channels===1?'mono':'stereo'):audio.info.channelMask ? layouts[audio.info.channelMask] ?? (inferred?.mask===BigInt(audio.info.channelMask)?inferred.name:'') : (guessLayout ? inferred?.name : undefined) ?? `${audio.info.channels} channels`;
        if (!channelLayout) unsupported('Unknown channel mask for framecrc output');
      }
      if(outputFormat==='au')validateAuOutput({codec:auCodec!,channels,sampleRate:resultRate},range.samples);
      if(outputFormat==='aiff')validateAiffOutput({codec:aiffCodec!,channels,sampleRate:resultRate,channelMask:remixing?null:audio.info.channelMask},range.samples);
      context.signal.throwIfAborted();
      const destination = await context.filesystem.openWrite(output.url, { overwrite });
      const format = { codec: outputCodec, channels, sampleRate: resultRate, channelMask: remixing?null:audio.info.channelMask };
      const packets = codec === 'copy' ? sourcePackets : encoded();
      const options = { ...(bitexact?{}:{metadataProfile:'ffmpeg-9.0.2' as const}),sampleCount: range.samples, maxWriteBytes: context.budget.maxBufferBytes, signal: context.signal };
      if (outputFormat === 'framecrc') {
        await muxFrameCrc(destination,{codec:outputCodec,sampleRate:resultRate,channelLayout},packets,{
          ...options, bitexact,
          framing:{blockAlign:getPcmFormat(outputCodec).bytesPerSample * channels,samplesPerPacket:range.span,firstPacketSamples:range.firstPacketSamples,sampleCount:range.samples,startPts:range.pts,...(resampledSchedule?{packetSchedule:resampledSchedule}:padding?{sections:paddingSections!}:{})}
        });
      }
      else if(outputFormat==='au')await muxAu(destination,{...format,codec:auCodec!},packets,options);
      else if(outputFormat==='aiff')await muxAiff(destination,{...format,codec:aiffCodec!},packets,options);
      else if (rawOutputCodec) await muxRawPcm(destination,format,packets,options);
      else await muxWav(destination,{...format,codec:wavCodec!,channelMask:format.channelMask??((remixing||guessLayout)?defaultChannelLayout(channels)?.mask??null:null)},packets,{...options,metadataProfile:'ffmpeg-9.0.2',bitexact});
      return [output.url];
    }
  };
}

/** Backward-compatible factory name for the finite audio/rawvideo backend. */
export const createWavBackend = createMediaBackend;

export { planPcmMemory } from './memory-plan.js';
export type { PcmMemoryRequest, PcmMemoryPlan } from './memory-plan.js';

export {OutputGroupError} from './output-group.js';
export type {OutputEffect,OutputStatus} from './output-group.js';
export {ComplexVideoFailure} from './complex-video.js';

export {createVideoEncoderSyncQueue} from './video-output/encoder-sync-queue.js';
export type {VideoEncoderSyncFrame,VideoEncoderSyncQueueOptions} from './video-output/encoder-sync-queue.js';

export {createTimedVideoBackend} from './actor-video/backend.js';
export type {TimedVideoBackendOptions} from './actor-video/backend.js';


export {createTimedEventCodec} from './actor-video/spool/event-codec.js';
export type {TimedVideoStore,TimedVideoStoreFactory,TimedVideoScheduler,TimedVideoBackendLimits} from './actor-video/backend.js';

export {createMp4H264Backend} from './mp4-h264.js';
export type {H264BackendConfiguration} from './mp4-h264.js';

export type {FlacBackendConfiguration} from './flac-decode.js';
export {decodeFlacAudioFrames,prepareFlacAudioFrames} from './flac-wave-frames.js';
export type {FlacAudioFrames,FlacAudioFramesMetadata,FlacAudioFramesOptions} from './flac-wave-frames.js';
export {compileFlacTimePolicy,resolveFlacTimePolicy} from './flac-wave-time.js';
export type {FlacTimePolicy,FlacTimeScope,ResolvedFlacTimePolicy} from './flac-wave-time.js';
export {trimFlacAudio,countTrimmedFlacSamples} from './flac-wave-trim.js';
export type {FlacAudioTrimRange,FlacAudioTrimOptions} from './flac-wave-trim.js';
export {remixFlacAudio} from './flac-wave-remix.js';
export type {FlacAudioRemixOptions} from './flac-wave-remix.js';
export {resampleFlacAudio,countResampledFlacSamples} from './flac-wave-resample.js';
export type {FlacAudioResampleOptions} from './flac-wave-resample.js';
export {compileFlacAudioFilters,processFlacAudioFilters} from './flac-wave-filters.js';
export type {CompiledFlacAudioFilters,FlacAudioFilterPlan,FlacAudioFilterOptions} from './flac-wave-filters.js';

export {createAudioCheckpointPipeline,inspectAudioCheckpointPipeline,serializeAudioCheckpointPipeline,deserializeAudioCheckpointPipeline,audioCheckpointPipelinePatches,validateAudioCheckpointPipelineConfig,AudioCheckpointPipelineError} from './audio-checkpoint-pipeline.js';
export type {AudioCheckpointPipeline,AudioCheckpointPipelineCodec,AudioCheckpointPipelineConfig,AudioCheckpointPipelineInput,AudioCheckpointPipelineLimits,AudioCheckpointPipelinePlan,AudioCheckpointPipelinePosition,AudioCheckpointPipelineSnapshot,AudioCheckpointPipelineStage,AudioCheckpointPipelineStageCheckpoint,AudioCheckpointPipelineState,AudioCheckpointPipelineUnit} from './audio-checkpoint-pipeline.js';
