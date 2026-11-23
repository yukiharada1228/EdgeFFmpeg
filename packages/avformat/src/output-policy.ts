// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped assert_file_overwrite behavior from pinned fftools/ffmpeg_opt.c;
// AVERROR_EXIT is mapped to0 by fftools/ffmpeg.c. See NOTICE-OUTPUT-POLICY.
import {ExecutionError,ExecutionExit} from '@edge-ffmpeg/core';
import type {BackendContext} from '@edge-ffmpeg/core';
/** Call after source/selected-codec validation, before output creation. */
export async function assertOutputPolicy(context:BackendContext,path:string,overwrite:boolean,noOverwrite:boolean):Promise<void>{
 context.signal.throwIfAborted();
 if(overwrite&&noOverwrite)throw new ExecutionError('invalid-arguments','Error, both -y and -n supplied. Exiting.',{exitCode:234});
 const exists=context.filesystem.outputExists?await context.filesystem.outputExists(path,context.signal,{overwrite}):false;
 if(!overwrite&&exists)throw new ExecutionExit('output-exists',"File '"+path+"' already exists. Exiting.");
 context.signal.throwIfAborted();
}
