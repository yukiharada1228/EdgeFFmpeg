import{it,expect}from'vitest';import{createH264PacketClock}from'../../packages/avformat/src/h264-packet-clock.js';
it('matches pinned Native DTS repair while H264 reorder delay changes after the first packet',()=>{
 // Captured Native compute_pkt_fields trace for a zero-duration edit followed by media.
 const pts=[0n,-1024n,-512n,0n,512n,1024n,1536n,2048n,2560n,3072n],expected=[0n,null,null,-1024n,-512n,0n,512n,1024n,1536n,3072n],clock=createH264PacketClock();expect(pts.map((value,i)=>clock.feed(value,value,i===0?0:2,true))).toEqual(expected);
});
it('rejects invalid reorder windows and timestamp sentinels',()=>{
 const clock=createH264PacketClock();for(const delay of [-1,17,0.5])expect(()=>clock.feed(0n,0n,delay,true)).toThrow();for(const value of [-(1n<<63n),1n<<63n])expect(()=>clock.feed(value,0n,2,true)).toThrow();
});
