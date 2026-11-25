import {ExecutionError} from '@edge-ffmpeg/core';
import {nativeFrameLimitRejection} from '@edge-ffmpeg/cli';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
/**
 * Rejects, before dispatch and before any input is opened, the output option values whose native parse depends on the
 * reference CPU and fails under `profile` (nativeFrameLimitRejection), with the native message and AVERROR(EINVAL) exit
 * status 234. Outputs and their options are checked in command order, so the first native failure is reported. Native
 * parses output options after opening the inputs, so a command that also names a missing input reports this error
 * first. darwin-arm64 rejects nothing here.
 */
export function rejectNativeNumericOptions(command:ParsedCommand,profile:ExpressionNumericProfile):void{
 if(profile!=='darwin-arm64'&&profile!=='linux-x64')throw new ExecutionError('unsupported-command','Invalid native numeric profile');
 for(const output of command.outputs)for(const option of output.options){
  const message=nativeFrameLimitRejection(option.name,option.value,profile);
  if(message!==null)throw new ExecutionError('invalid-arguments',message,{exitCode:234});
 }
}
