/** Observe even late provider rejection, without retaining an abort listener. */
export function waitForDecoder<T>(promise: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
 return new Promise<T>((resolve, reject) => {
  const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, {once: true});
  Promise.resolve(promise).then(value => {signal.removeEventListener('abort', abort); resolve(value);}, error => {signal.removeEventListener('abort', abort); reject(error);});
  if (signal.aborted) abort();
 });
}
