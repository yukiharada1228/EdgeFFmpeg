import {describe,it,expect} from 'vitest';
import {createH264DisplayPolicy} from '../../packages/avcodec/src/h264/display-policy.mjs';

describe('H264 display reset boundaries',()=>{
 it('keeps inferred reorder delay across an MMCO5 reset',()=>{
  const policy=createH264DisplayPolicy<number>({initialDelay:1,maxQueuedFrames:17,maxQueuedBytes:1024});
  const output:(number|null)[]=[];
  for(const [index,poc] of [0,2,4,6,8,10,0,2,4].entries())output.push(policy.feed({poc,key:index===0,reset:index===6,type:index===0?'I':'P',restricted:false,reorder:0,bytes:16,value:index}).frame);
  expect(output).toEqual([null,0,1,2,3,4,5,6,7]);
  expect(policy.reorderDelay).toBe(1);
  expect(policy.flush()).toBe(8);
  expect(policy.flush()).toBeNull();
  policy.close();
  expect(policy.queuedBytes).toBe(0);
 });
 it('drains the preceding pictures before a non-key reset picture',()=>{
  const policy=createH264DisplayPolicy<number>({initialDelay:2,maxQueuedFrames:17,maxQueuedBytes:1024});
  const emitted:number[]=[];
  for(const [index,poc] of [0,4,2,0,4,2].entries()){
   const result=policy.feed({poc,key:index===0,reset:index===3,type:index===2||index===5?'B':index===0?'I':'P',restricted:true,reorder:2,bytes:16,value:index});
   expect(result.dropped).toBeNull();if(result.frame!==null)emitted.push(result.frame);
  }
  for(;;){const frame=policy.flush();if(frame===null)break;emitted.push(frame);}
  expect(emitted).toEqual([0,2,1,3,5,4]);
  policy.close();
 });
});
