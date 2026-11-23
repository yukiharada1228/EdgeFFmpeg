import {compileExpression} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile,ExpressionPrint} from '@edge-ffmpeg/avutil';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import type {Store} from './spool/index.js';
import {executeParsedTimedVideoCommand} from './command.js';
export type TimedVideoStore=Store<TimedVideoOutputEvent>;
/** Each call returns an independent, execution-owned store. */
export type TimedVideoStoreFactory=(kind:'input'|'graph'|'output',index:number)=>TimedVideoStore;
export type TimedVideoScheduler='pull'|'activation'|'read-frames'|'queued'|'scheduled'|'producer';
export interface TimedVideoBackendLimits {
 numericProfile:ExpressionNumericProfile;
 maxEvents:number;
 scheduler?:TimedVideoScheduler;
 onPrint?(node:number,entry:ExpressionPrint):void;
 logLevel?:number;
}
export interface TimedVideoBackendOptions {storage:TimedVideoStoreFactory;limits:TimedVideoBackendLimits}
/** Explicit bounded rawvideo adapter; execution uses the public frontend's budget and signal. */
export function createTimedVideoBackend(options:TimedVideoBackendOptions):ExecutionBackend {
 const storage=options.storage,limits={...options.limits};
 limits.scheduler??='producer';
 if(typeof storage!=='function'||!Number.isSafeInteger(limits.maxEvents)||limits.maxEvents<1)throw new Error('Invalid timed video backend options');
 compileExpression('1',{numericProfile:limits.numericProfile});
 if(!['pull','activation','read-frames','queued','scheduled','producer'].includes(limits.scheduler))throw new Error('Invalid timed video scheduler');
 return Object.freeze({execute(command,context){return executeParsedTimedVideoCommand(command,context.filesystem,context.budget,storage,{...limits,signal:context.signal,...(context.reportDiagnostic?{reportDiagnostic:context.reportDiagnostic}:{})});}} as ExecutionBackend);
}
