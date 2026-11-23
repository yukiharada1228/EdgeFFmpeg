import {InputReadError} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {BackendContext} from '@edge-ffmpeg/core';
import type {ReadHandle} from '@edge-ffmpeg/core';
/** Headerless streams have declared parameters even if their first packet read fails. */
export async function probeRawRead(input:ReadHandle,signal:AbortSignal):Promise<{input:ReadHandle;failure:InputReadError|null}>{
 signal.throwIfAborted();
 try{await input.probeRead?.(signal);signal.throwIfAborted();return {input,failure:null};}
 catch(error){
  signal.throwIfAborted();
  if(!(error instanceof InputReadError))throw error;
  // No packet payload was obtained. Keep the error separate from the zero packet extent.
  return {input:{size:0n,readAt:input.readAt.bind(input)},failure:error};
 }
}

/** Apply read-error policy after all destination refusal/conflict checks. */
export function finishRawProbes(command:ParsedCommand,context:BackendContext,failures:readonly InputReadError[]):void{
 context.signal.throwIfAborted();
 const exitOnError=command.global.filter(option=>['-xerror','-noxerror'].includes(option.name)).at(-1)?.name==='-xerror';
 for(const failure of failures){if(exitOnError)throw failure;context.reportDiagnostic?.({code:failure.code,message:failure.message});}
}
