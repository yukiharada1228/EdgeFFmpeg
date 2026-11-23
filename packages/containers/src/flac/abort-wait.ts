// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
/** Interrupt a wait without abandoning observation of the provider's settlement. */
export function waitForFlacAbort<T>(pending:PromiseLike<T>|T,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
