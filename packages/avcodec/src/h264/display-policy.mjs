// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavcodec/h264_slice.c h264_select_output_frame
// and h264dec.c send_next_delayed_frame/idr. This module is TypeScript/JS-side
// scheduling; no FFmpeg code is compiled into or linked with the codec Wasm.
import {H264ResourceError} from './errors.mjs';
const MIN=-2147483648;
export function createH264DisplayPolicy({initialDelay,maxQueuedFrames,maxQueuedBytes,signal}){
 if(!Number.isSafeInteger(initialDelay)||initialDelay<0||initialDelay>16||!Number.isSafeInteger(maxQueuedFrames)||maxQueuedFrames<1||maxQueuedFrames>17||!Number.isSafeInteger(maxQueuedBytes)||maxQueuedBytes<1)throw Error('Invalid H264 display budget');
 let closed=false,draining=false,delay=initialDelay,nextOutputPoc=MIN,queueBytes=0,peakBytes=0;const lastPocs=Array(16).fill(MIN),queue=[];
 const check=()=>{signal?.throwIfAborted();if(closed)throw Error('H264 display policy is closed');};
 const close=()=>{queue.length=0;queueBytes=0;closed=true;};
 const remove=index=>{const [picture]=queue.splice(index,1);queueBytes-=picture.bytes;return picture;};
 const select=()=>{let index=0;for(let i=1;i<queue.length&&!queue[i].key&&!queue[i].reset;i++)if(queue[i].poc<queue[index].poc)index=i;return index;};
 const fail=error=>{close();throw error;};
 return Object.freeze({get queuedBytes(){return queueBytes;},get queuedFrames(){return queue.length;},get peakQueuedBytes(){return peakBytes;},get reorderDelay(){return delay;},get isClosed(){return closed;},
  feed(picture){try{check();if(draining)throw Error('H264 display policy is draining');
   if(!Number.isInteger(picture.poc)||picture.poc<MIN||picture.poc>2147483647||!Number.isSafeInteger(picture.bytes)||picture.bytes<1||!['I','P','B'].includes(picture.type)||typeof picture.key!=='boolean'||typeof picture.reset!=='boolean'||!Number.isInteger(picture.reorder)||picture.reorder<0||picture.reorder>16||typeof picture.restricted!=='boolean')throw Error('Invalid H264 display picture');
   picture={...picture};if(picture.key||picture.reset)lastPocs.fill(MIN);if(picture.restricted)delay=Math.max(delay,picture.reorder);
   let i=0;for(;;i++){if(i===16||picture.poc<lastPocs[i]){if(i)lastPocs[i-1]=picture.poc;break;}if(i)lastPocs[i-1]=lastPocs[i];}
   let outOfOrder=16-i;if(picture.type==='B'||lastPocs[14]>MIN&&lastPocs[15]-lastPocs[14]>2)outOfOrder=Math.max(outOfOrder,1);
   if(outOfOrder===16){for(let i=1;i<16;i++)lastPocs[i]=MIN;lastPocs[0]=picture.poc;picture.reset=true;}else if(delay<outOfOrder&&!picture.restricted)delay=outOfOrder;
   if(queue.length>=maxQueuedFrames)throw new H264ResourceError('display-frames','H264 display frame count exceeds budget');if(picture.bytes>maxQueuedBytes-queueBytes)throw new H264ResourceError('display-bytes','H264 display queue exceeds budget');
   queue.push(picture);queueBytes+=picture.bytes;peakBytes=Math.max(peakBytes,queueBytes);const index=select(),out=queue[index],count=queue.length;
   if(delay===0&&(queue[0].key||queue[0].reset))nextOutputPoc=MIN;
   const backwards=out.poc<nextOutputPoc;if(backwards||count>delay)remove(index);
   if(!backwards&&count>delay){nextOutputPoc=index===0&&queue.length&&(queue[0].key||queue[0].reset)?MIN:out.poc;return {frame:out.value,dropped:null};}
   return {frame:null,dropped:backwards?out.value:null};
  }catch(error){return fail(error);}},
  flush(){try{check();draining=true;return queue.length?remove(select()).value:null;}catch(error){return fail(error);}},close
 });
}
