import {ExecutionError} from '@edge-ffmpeg/core';
export interface AudioPacketSection {readonly samples:bigint;readonly span:bigint;readonly firstPacketSamples?:bigint}
/** Clip finite semantic packet ranges without enumerating packets or retaining media. */
export function clipPacketSections(sections:readonly AudioPacketSection[],start:bigint,samples:bigint):readonly AudioPacketSection[]{
  if(typeof start!=='bigint'||start<0n||typeof samples!=='bigint'||samples<0n||!Array.isArray(sections)||sections.length>65)throw new ExecutionError('invalid-arguments','Invalid packet section selection');
  const output:AudioPacketSection[]=[];let skip=start,remaining=samples;
  for(const section of sections){
    if(!section||typeof section.samples!=='bigint'||section.samples<1n||typeof section.span!=='bigint'||section.span<1n||(section.firstPacketSamples!==undefined&&(typeof section.firstPacketSamples!=='bigint'||section.firstPacketSamples<1n||section.firstPacketSamples>section.span)))throw new ExecutionError('invalid-arguments','Invalid packet section');
    if(skip>=section.samples){skip-=section.samples;continue;}
    if(remaining===0n)continue;
    const available=section.samples-skip,count=available<remaining?available:remaining,first=section.firstPacketSamples??section.span;
    const firstPacketSamples=skip<first?first-skip:section.span-(skip-first)%section.span;
    output.push(Object.freeze({samples:count,span:section.span,firstPacketSamples}));remaining-=count;skip=0n;
  }
  return Object.freeze(output);
}
/** Number of samples in at most N semantic packets, in O(section count) time. */
export function packetSectionSamplesForFrames(sections:readonly AudioPacketSection[],frames:bigint):bigint{
  if(typeof frames!=='bigint'||frames<0n)throw new ExecutionError('invalid-arguments','Invalid packet frame limit');
  clipPacketSections(sections,0n,0n);
  let remaining=frames,samples=0n;
  for(const section of sections){
    if(remaining===0n)break;
    const first=section.firstPacketSamples??section.span,firstCount=first<section.samples?first:section.samples;
    const rest=section.samples-firstCount,packets=1n+(rest+section.span-1n)/section.span;
    if(remaining>=packets){samples+=section.samples;remaining-=packets;}
    else{const selected=firstCount+(remaining-1n)*section.span;samples+=selected<section.samples?selected:section.samples;break;}
  }
  return samples;
}
