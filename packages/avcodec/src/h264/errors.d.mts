export class H264InputError extends Error {}
export type H264Resource = 'resident-bytes'|'packet-bytes'|'frame-bytes'|'nal-units'|'pending-packets'|'display-bytes'|'display-frames'|'wasm-memory';
export class H264ResourceError extends H264InputError {
 readonly resource:H264Resource;
 constructor(resource:H264Resource,message:string,options?:ErrorOptions);
}
