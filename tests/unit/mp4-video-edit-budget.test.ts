import{it,expect}from'vitest';import{readVideoEditList}from'../../packages/containers/src/mp4/video-edit-list.js';
it('rejects excessive edit entry metadata before reconstructing intervals',()=>{
 const data=new Uint8Array(8+8*12),view=new DataView(data.buffer);view.setUint32(4,8);for(let i=0;i<8;i++){view.setUint32(8+i*12,80);view.setUint32(16+i*12,65536);}const box={type:'elst',start:0,data:0,end:data.length,children:[]};expect(()=>readVideoEditList(data,box,1000,12800,undefined,3)).toThrowError(expect.objectContaining({code:'resource-budget'}));expect(readVideoEditList(data,box,1000,12800,undefined,8)?.segments).toHaveLength(8);
});
