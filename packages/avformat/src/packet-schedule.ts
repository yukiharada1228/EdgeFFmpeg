import {ExecutionError} from '@edge-ffmpeg/core';
import {resampledSampleCount,resampledStreamingSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioPacketSchedule} from '@edge-ffmpeg/avutil';
import {audioFilterCapabilities} from '@edge-ffmpeg/avfilter';
import type {AudioFilterCountPlan} from '@edge-ffmpeg/avfilter';
import type {AudioPacketSection} from './packet-sections.js';
import {clipPacketSections} from './packet-sections.js';
interface Segment {readonly samples:bigint;readonly packets:bigint;readonly cumulative:(packets:bigint)=>bigint}
interface UniformRun {readonly samples:bigint;readonly span:bigint}
export interface PlannedPacketSchedule extends AudioPacketSchedule {readonly uniformRuns?:readonly UniformRun[]}
const minimum=(a:bigint,b:bigint)=>a<b?a:b;
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
function schedule(segments:readonly Segment[],uniformRuns?:readonly UniformRun[]):PlannedPacketSchedule{
  const parts=Object.freeze(segments.filter(part=>part.samples>0n).map(part=>Object.freeze({...part})));
  const sampleCount=parts.reduce((n,part)=>n+part.samples,0n),packetCount=parts.reduce((n,part)=>n+part.packets,0n);
  return Object.freeze({sampleCount,packetCount,...(uniformRuns?{uniformRuns:Object.freeze(uniformRuns.map(run=>Object.freeze({...run})))}:{}),samplesForPackets(packets:bigint){
    if(typeof packets!=='bigint'||packets<0n)throw new ExecutionError('invalid-arguments','Invalid packet schedule limit');
    let remaining=packets,result=0n;
    for(const part of parts){if(remaining>=part.packets){result+=part.samples;remaining-=part.packets;}else {result+=part.cumulative(remaining);break;}}
    return result;
  }});
}
function uniform(samples:bigint,span:bigint):Segment{return {samples,packets:ceil(samples,span),cumulative:packets=>minimum(samples,packets*span)};}
/** Bounded uniform runs, including partial first and final packets. */
export function schedulePacketSections(sections:readonly AudioPacketSection[]):PlannedPacketSchedule{
  clipPacketSections(sections,0n,0n);const runs:UniformRun[]=[];
  for(const section of sections){const first=minimum(section.samples,section.firstPacketSamples??section.span);runs.push({samples:first,span:first});const rest=section.samples-first;if(rest)runs.push({samples:rest,span:section.span});}
  return schedule(runs.map(run=>uniform(run.samples,run.span)),runs);
}
export function appendPacketSection(source:PlannedPacketSchedule,samples:bigint,span:bigint):PlannedPacketSchedule{
  if(typeof samples!=='bigint'||samples<0n||typeof span!=='bigint'||span<1n)throw new ExecutionError('invalid-arguments','Invalid appended packet section');
  if(samples===0n)return source;
  return schedule([{samples:source.sampleCount,packets:source.packetCount,cumulative:source.samplesForPackets},uniform(samples,span)],source.uniformRuns?[...source.uniformRuns,{samples,span}]:undefined);
}
/** Skip by cumulative count, without enumerating packets before an output seek. */
export function slicePacketSchedule(source:PlannedPacketSchedule,start:bigint,samples:bigint):PlannedPacketSchedule{
  if(typeof start!=='bigint'||start<0n||typeof samples!=='bigint'||samples<0n)throw new ExecutionError('invalid-arguments','Invalid packet schedule selection');
  const end=minimum(source.sampleCount,start+samples);if(start>=end)return schedule([]);
  const find=(value:bigint,strict:boolean)=>{let low=0n,high=source.packetCount;while(low<high){const middle=(low+high)/2n,position=source.samplesForPackets(middle);if(strict?position>value:position>=value)high=middle;else low=middle+1n;}return low;};
  const first=find(start,true)-1n,last=find(end,false),packets=last-first;
  return schedule([{samples:end-start,packets,cumulative:n=>n===0n?0n:minimum(end,source.samplesForPackets(first+minimum(n,packets)))-start}]);
}
/** Native automatic FIR framing. Each input packet drains available output;
 * the initial output allocation can overflow into 4096-sample non-final drains.
 * Final EOF drains also use 4096 samples. Metadata work is bounded by input runs.
 */
export function resamplePacketSchedule(source:PlannedPacketSchedule,inputRate:number,outputRate:number):PlannedPacketSchedule{
  const total=resampledSampleCount(source.sampleCount,inputRate,outputRate);
  if(inputRate===outputRate)return source;
  if(!source.uniformRuns)throw new ExecutionError('unsupported-command','Repeated resampling packet scheduling is not implemented');
  const available=(samples:bigint)=>resampledStreamingSampleCount(samples,inputRate,outputRate),parts:Segment[]=[];
  let received=0n,emitted=0n,started=false;
  const addUniform=(samples:bigint,span:bigint)=>{if(samples>0n)parts.push(uniform(samples,span));};
  const run=(span:bigint,packets:bigint)=>{
    if(packets===0n)return;
    if(span>2147483647n)throw new ExecutionError('unsupported-command','Native resampler input packet exceeds signed32');
    const start=received,end=start+span*packets,at=(n:bigint)=>available(start+n*span);
    if(!started&&available(end)>0n){
      let low=1n,high=packets;while(low<high){const middle=(low+high)/2n;if(at(middle)>0n)high=middle;else low=middle+1n;}
      const prior=start+(low-1n)*span,base=BigInt(Math.floor(Number(span)*(outputRate/inputRate)+32)),delay=(prior*BigInt(outputRate)+BigInt(inputRate)/2n)/BigInt(inputRate);
      if(base>2147483647n)throw new ExecutionError('unsupported-command','Native resampler output allocation exceeds signed32');
      const cap=base+minimum(delay,base>4096n?base:4096n),first=minimum(at(low),cap);
      if(cap>2147483647n)throw new ExecutionError('unsupported-command','Native resampler output allocation exceeds signed32');
      addUniform(first,first);addUniform(at(low)-first,4096n);emitted=at(low);received=start+low*span;started=true;
      run(span,packets-low);return;
    }
    if(started){
      const count=at(packets)-emitted;
      if(count>0n){
        if(span*BigInt(outputRate)<BigInt(inputRate))addUniform(count,1n);
        else {const origin=emitted;parts.push({samples:count,packets,cumulative:n=>at(n)-origin});}
      }
      emitted+=count;
    }
    received=end;
  };
  for(const item of source.uniformRuns){const full=item.samples/item.span,tail=item.samples%item.span;run(item.span,full);if(tail)run(tail,1n);}
  addUniform(total-emitted,4096n);
  return schedule(parts);
}

/** Apply the shared filter count plan's per-stage packet effects while preserving semantic frame boundaries. */
export function filteredPacketSchedule(inputSamples:bigint,inputSpan:bigint,inputRate:number,outputRate:number,plan?:AudioFilterCountPlan):PlannedPacketSchedule{
  let result=schedulePacketSections(inputSamples?[{samples:inputSamples,span:inputSpan}]:[]);
  if(!plan)return resamplePacketSchedule(result,inputRate,outputRate);
  for(const stage of plan.stages){
    if(stage.inputSamples!==result.sampleCount)throw new ExecutionError('invalid-arguments','Packet schedule and filter counts disagree');
    if(stage.step===null)result=resamplePacketSchedule(result,stage.inputRate!,stage.outputRate!);
    // Resampled scheduling only covers steps with pinned rate-conversion evidence; rateBoundary() refuses the others first.
    else if(!audioFilterCapabilities(stage.step).rateConversion)throw new ExecutionError('unsupported-command',`${stage.step.name} with sample rate conversion is not implemented`);
    else if(stage.packets){
      const {reframe,leading,trailing}=stage.packets;
      if(leading)throw new ExecutionError('unsupported-command','Leading filter output requires unimplemented resampled packet scheduling');
      if(reframe!==undefined)result=schedulePacketSections(stage.outputSamples?[{samples:stage.outputSamples,span:reframe}]:[]);
      if(trailing)result=appendPacketSection(result,trailing.samples,trailing.span);
    }
    if(stage.outputSamples!==result.sampleCount)throw new ExecutionError('invalid-arguments','Packet schedule and filter output counts disagree');
  }
  return result;
}
