import {ExecutionError} from '@edge-ffmpeg/core';
import type {OutputEffect} from './output-group.js';
export class ComplexVideoFailure extends ExecutionError{
 readonly publishedOutputs:readonly string[];
 constructor(cause:unknown,readonly effects:readonly OutputEffect[],readonly cleanupErrors:readonly unknown[]){super(cause instanceof ExecutionError?cause.code:'execution-failed',cause instanceof Error?cause.message:String(cause),{exitCode:cleanupErrors.length===0&&cause instanceof ExecutionError?cause.exitCode:1});this.cause=cause;this.publishedOutputs=Object.freeze(effects.filter(effect=>effect.status==='published').map(effect=>effect.path));}
}
