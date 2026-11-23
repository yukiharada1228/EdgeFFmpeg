// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned avfiltergraph.c ff_filter_graph_run_once and avfilter.c
// ff_filter_set_ready/ff_filter_activate; see NOTICE.activation.
export function createActivationScheduler(nodes:readonly (()=>Promise<number|'not-ready'>)[],options:{maxSteps:number;signal?:AbortSignal}){
 if(!nodes.length||nodes.length>128||nodes.some(node=>typeof node!=='function')||!Number.isSafeInteger(options.maxSteps)||options.maxSteps<1)throw new Error('Invalid activation scheduler bounds');
 const callbacks=[...nodes],settings={...options},ready=callbacks.map(()=>0);let steps=0,busy=false,failed=false,failure:unknown;
 return {
  mark(index:number,priority:number){if(failed)throw failure;if(!Number.isInteger(index)||index<0||index>=ready.length||!Number.isInteger(priority)||priority<0||priority>4294967295)throw new Error('Invalid activation priority');ready[index]=Math.max(ready[index]!,priority);},
  get steps(){return steps;},get priorities(){return Object.freeze([...ready]);},
  async runOnce(){if(busy)throw new Error('Concurrent activation runs');if(failed)throw failure;settings.signal?.throwIfAborted();let selected=0;for(let index=1;index<ready.length;index++)if(ready[index]!>ready[selected]!)selected=index;if(!ready[selected])return {node:-1,code:'again' as const};if(steps>=settings.maxSteps)throw new Error('Activation work budget exceeded');
   busy=true;steps++;ready[selected]=0;try{const result=await callbacks[selected]!();settings.signal?.throwIfAborted();if(result!=='not-ready'&&(!Number.isInteger(result)||result>0||result< -2147483648))throw new Error('Invalid activation result');return {node:selected,code:result==='not-ready'?0:result};}catch(error){failed=true;failure=error;throw error;}finally{busy=false;}
  }
 };
}
