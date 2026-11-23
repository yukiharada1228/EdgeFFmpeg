import {ExecutionError,InputReadError} from '@edge-ffmpeg/core';
import {openMp4} from '@edge-ffmpeg/containers';
/** Initial MP4 discovery failure is distinct from a later packet read failure. */
export async function openMp4Input(...[input,options]:Parameters<typeof openMp4>):ReturnType<typeof openMp4>{
 try{
  await input.probeRead?.(options.signal);
  options.signal?.throwIfAborted();
  return await openMp4(input,options);
 }catch(error){
  options.signal?.throwIfAborted();
  if(!(error instanceof InputReadError))throw error;
  const failure=new ExecutionError('invalid-data','moov atom not found',{exitCode:183});
  failure.cause=error;throw failure;
 }
}
