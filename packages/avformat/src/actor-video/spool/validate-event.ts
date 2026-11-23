import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
/** Structural validation; media operators validate the actual pixel layout. */
export function validateTimedEvent(value:unknown):asserts value is TimedVideoOutputEvent {
 const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
 const fields=(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>=>{if(!object(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw new Error('Invalid event fields');return v;};
 const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v);
 const i64=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=-(1n<<63n)&&v<(1n<<63n);
 const stamp=(v:unknown)=>v===null||i64(v);
 if(!object(value))throw new Error('Invalid event envelope');
 if(value.kind==='frame'){
  fields(value,['kind','frame','duration'],['interlaced']);if(!i64(value.duration)||Object.hasOwn(value,'interlaced')&&typeof value.interlaced!=='boolean')throw new Error('Invalid event frame flags');
  const f=fields(value.frame,['width','height','pixelFormat','planes','linesizes','pts','metadata']);
  if(!integer(f.width)||f.width<1||f.width>2147483647||!integer(f.height)||f.height<1||f.height>2147483647||typeof f.pixelFormat!=='string'||!f.pixelFormat.length||f.pixelFormat.length>128||!object(f.metadata))throw new Error('Invalid event frame description');
  if(!Array.isArray(f.planes)||f.planes.length<1||f.planes.length>8||f.planes.some((p:unknown)=>!(p instanceof Uint8Array))||!Array.isArray(f.linesizes)||f.linesizes.length!==f.planes.length||f.linesizes.some((n:unknown)=>!integer(n)||n< -2147483648||n>2147483647))throw new Error('Invalid event planes');
  if(f.pts!==null){const pts=fields(f.pts,['value','timeBase']),base=fields(pts.timeBase,['num','den']);if(!i64(pts.value)||typeof base.num!=='bigint'||typeof base.den!=='bigint'||base.num<1n||base.num>2147483647n||base.den<1n||base.den>2147483647n)throw new Error('Invalid event timestamp');}
 }else if(value.kind==='end'){
  fields(value,['kind','status','pts','rawPts','inputPts','secondaryErrors'],['error']);
  if(typeof value.status!=='string'||!['eof','error','cancelled','closed'].includes(value.status)||![value.pts,value.rawPts,value.inputPts].every(stamp)||!Array.isArray(value.secondaryErrors)||value.status!=='eof'&&!Object.hasOwn(value,'error'))throw new Error('Invalid event terminal');
 }else throw new Error('Invalid event kind');
}
