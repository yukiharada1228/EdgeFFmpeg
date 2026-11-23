/** Conservative static triage, never a compatibility or execution result. */
export function auditAudioCandidates(entries,compile,reviewedIds=[]) {
  const reviewed=new Set(reviewedIds);
  return entries.filter(entry=>entry.file==='tests/fate/filter-audio.mak').map(entry=>{
    const match=/(?:^|\s)-af\s+([^\s]+)/.exec(entry.command),description=match?.[1];
    let filterStatus='not-analyzed',reason='No simple whitespace-delimited -af argument; complex/quoted graphs require separate review',steps=[];
    if(description&&!/["'\\$;`<>|]/.test(description)){
      try{steps=compile(description).steps.map(step=>step.name);filterStatus='accepted-by-compiler';reason='Filter syntax accepted only; input/helper/expected-output/runtime semantics still require reviewed execution';}
      catch(error){filterStatus='unsupported-filter';reason=error instanceof Error?error.message:String(error);}
    }
    return {id:entry.id,file:entry.file,logicalLine:entry.logicalLine,command:entry.command,helper:entry.helper,sampleDependent:entry.sampleDependent,filter:description??null,steps,filterStatus,reason,executionStatus:reviewed.has(entry.id)?'reviewed-profile-present':'not-executed',blockers:reviewed.has(entry.id)?[]:[...(filterStatus==='accepted-by-compiler'?[]:['filter implementation or syntax review']),...(entry.sampleDependent?['external sample provenance and availability']:['input variable and generator provenance review']),'helper/argv adaptation and upstream expected-result review']};
  });
}
