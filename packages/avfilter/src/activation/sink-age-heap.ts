// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts pinned avfiltergraph.c sink-link heap updates; see NOTICE.activation.
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
/** Preserve Native heap tie rules and its asymmetric up/down update order. */
export function createSinkAgeHeap(order:readonly number[]){
 if(order.length>32||new Set(order).size!==order.length||order.some(id=>!Number.isInteger(id)||id<0||id>=order.length))throw new Error('Invalid sink registration order');
 const heap=[...order],positions=Array<number>(order.length),ages=order.map(()=>MIN);for(const [position,id]of heap.entries())positions[id]=position;
 const put=(position:number,id:number)=>{heap[position]=id;positions[id]=position;};
 const up=(id:number,index:number)=>{while(index){const parent=(index-1)>>1;if(ages[heap[parent]!]!>=ages[id]!)break;put(index,heap[parent]!);index=parent;}put(index,id);};
 const down=(id:number,index:number)=>{for(;;){let child=2*index+1;if(child>=heap.length)break;if(child+1<heap.length&&ages[heap[child+1]!]!<ages[heap[child]!]!)child++;if(ages[id]!<ages[heap[child]!]!)break;put(index,heap[child]!);index=child;}put(index,id);};
 const valid=(id:number)=>{if(!Number.isInteger(id)||id<0||id>=ages.length)throw new Error('Invalid sink index');};
 return {get oldest(){return heap[0]??null;},get entries(){return Object.freeze([...heap]);},get ages(){return Object.freeze([...ages]);},get positions(){return Object.freeze([...positions]);},update(id:number,age:bigint){valid(id);if(typeof age!=='bigint'||age<MIN||age>MAX)throw new Error('Invalid sink age');ages[id]=age;if(positions[id]!<0)return;up(id,positions[id]!);down(id,positions[id]!);},remove(id:number){valid(id);const index=positions[id]!;if(index<0)return;const last=heap.pop()!;if(index<heap.length)down(last,index);positions[id]=-1;}};
}
