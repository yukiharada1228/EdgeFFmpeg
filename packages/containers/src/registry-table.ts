import * as registry from './registry.js';
import type {ContainerDemuxer,ContainerDescriptor,ContainerMuxer} from './registry-descriptor.js';
type Registered=typeof registry[keyof typeof registry];
/** Every registered -f name. */
export type ContainerName=Registered['name'];
/** Names detectAudioContainer returns: formats with a magic probe or input extensions. */
export type DetectableContainerName=Extract<Registered,{readonly demux:{readonly probe:object}}|{readonly demux:{readonly extensions:readonly string[]}}>['name'];
export type RegisteredDemuxer=ContainerDescriptor&{readonly demux:ContainerDemuxer};
export type RegisteredMuxer=ContainerDescriptor&{readonly mux:ContainerMuxer};
const nonnegative=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>=0,callable=(value:unknown)=>typeof value==='function',optional=(value:unknown)=>value===undefined||callable(value);
// One dot and no inner dots, so no extension is a suffix of another and matching never depends on order.
const extensions=(list:unknown)=>list===undefined||Array.isArray(list)&&list.length>0&&list.every(value=>typeof value==='string'&&/^\.[a-z0-9_]{1,16}$/.test(value));
function valid(key:string,format:ContainerDescriptor):boolean{
  if(typeof format!=='object'||format===null)return false;
  const {demux,mux}=format;
  if(key!==format.name||!/^[a-z0-9_]{1,32}$/.test(key)||!demux&&!mux||format.headerless!==undefined&&typeof format.headerless!=='boolean')return false;
  if(demux&&(!nonnegative(demux.headerBytes)||!callable(demux.open)||!optional(demux.packetSpan)||!extensions(demux.extensions)||demux.seekBeyondEnd!==undefined&&typeof demux.seekBeyondEnd!=='boolean'||
    demux.probe&&(!Number.isFinite(demux.probe.precedence)||!callable(demux.probe.head)||!optional(demux.probe.confirm))||format.headerless&&(demux.probe||demux.extensions)))return false;
  return !mux||typeof mux.label==='string'&&mux.label.length>0&&(mux.order===undefined||Number.isFinite(mux.order))&&extensions(mux.extensions)&&typeof mux.defaultCodec==='string'&&callable(mux.supports)&&optional(mux.refuse)&&
    (mux.options===undefined||Array.isArray(mux.options)&&mux.options.every(name=>typeof name==='string'&&/^-[a-z0-9_]{1,32}$/.test(name)))&&nonnegative(mux.scratchBytes)&&(mux.dropsMetadata===undefined||typeof mux.dropsMetadata==='boolean')&&optional(mux.validate)&&callable(mux.write)&&mux.supports(mux.defaultCodec);
}
/** Module-load check of one registry export: its key is the descriptor's -f name, every hook has the right kind and the default codec is supported. */
export function assertContainerRegistration(key:string,format:ContainerDescriptor):void{if(!valid(key,format))throw new Error(`Invalid container registration: ${key}`);}
const byName=(left:ContainerDescriptor,right:ContainerDescriptor)=>left.name<right.name?-1:left.name>right.name?1:0;
const table=new Map<string,ContainerDescriptor>();
for(const [key,format] of Object.entries(registry) as [string,ContainerDescriptor][]){assertContainerRegistration(key,format);table.set(key,format);}
/** Every registered format, by name. */
export const containerFormats:readonly ContainerDescriptor[]=Object.freeze([...table.values()].sort(byName));
const demuxers=containerFormats.filter((format):format is RegisteredDemuxer=>format.demux!==undefined),muxers=containerFormats.filter((format):format is RegisteredMuxer=>format.mux!==undefined);
function extensionTable<F extends ContainerDescriptor>(formats:readonly F[],list:(format:F)=>readonly string[]|undefined):ReadonlyMap<string,F>{
  const result=new Map<string,F>();
  for(const format of formats)for(const extension of list(format)??[]){if(result.has(extension))throw new Error(`Duplicated container extension ${extension}`);result.set(extension,format);}
  return result;
}
const inputExtensions=extensionTable(demuxers,format=>format.demux.extensions),outputExtensions=extensionTable(muxers,format=>format.mux.extensions);
const matchExtension=<F>(extensions:ReadonlyMap<string,F>,url:string):F|undefined=>{const path=url.toLowerCase();for(const [extension,format] of extensions)if(path.endsWith(extension))return format;return undefined;};
/** Registry lookup by -f name; prototype names such as constructor are never formats. */
export function containerFormat(name:string):ContainerDescriptor|undefined{return table.get(name);}
/** Magic probes in their fixed precedence, ties by name. */
export const containerProbes:readonly RegisteredDemuxer[]=Object.freeze(demuxers.filter(format=>format.demux.probe).sort((left,right)=>left.demux.probe!.precedence-right.demux.probe!.precedence||byName(left,right)));
/** Format an output path selects without -f (case-insensitive extension). */
export function outputContainerFor(url:string):RegisteredMuxer|undefined{return matchExtension(outputExtensions,url);}
/** Format an undeclared input path selects when no probe matches (native demuxers without read_probe). */
export function inputContainerFor(url:string):RegisteredDemuxer|undefined{return matchExtension(inputExtensions,url);}
/** Every per-format output option name; options outside this set are generic or unsupported. */
export const containerOutputOptions:ReadonlySet<string>=new Set(muxers.flatMap(format=>format.mux.options??[]));
/** Labels of the muxers with a header, by listing order then name: "WAV, AIFF, AU, W64, framecrc". */
export const containerOutputListing:string=muxers.filter(format=>!format.headerless).sort((left,right)=>(left.mux.order??Infinity)-(right.mux.order??Infinity)||byName(left,right)).map(format=>format.mux.label).join(', ');
