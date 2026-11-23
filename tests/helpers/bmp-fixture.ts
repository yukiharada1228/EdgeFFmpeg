export function image(width:number,height:number,depth:number,top:boolean,stream:number[]){
 const colors=1<<depth,offset=54+colors*4,data=new Uint8Array(offset+stream.length),v=new DataView(data.buffer);
 v.setUint16(0,0x4d42,true);v.setUint32(2,data.length,true);v.setUint32(10,offset,true);v.setUint32(14,40,true);v.setInt32(18,width,true);v.setInt32(22,top?-height:height,true);v.setUint16(26,1,true);v.setUint16(28,depth,true);v.setUint32(30,depth===8?1:2,true);
 for(let i=0;i<colors;i++){data[54+i*4]=i;data[55+i*4]=(i*39)%256;data[56+i*4]=(i*71)%256;}
 data.set(stream,offset);return data;
}
