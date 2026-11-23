export class H264InputError extends Error {}
/** A declared codec payload limit or its Wasm allocation was exhausted. */
export class H264ResourceError extends H264InputError {
 constructor(resource,message,options){super(message,options);this.name='H264ResourceError';this.resource=resource;}
}
