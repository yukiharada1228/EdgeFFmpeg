export interface StageCompletion {readonly status:'eof'|'error'|'cancelled'|'closed';readonly error?:unknown;readonly secondaryErrors:readonly unknown[]}
/** Error identity and every observing stage are retained independently of Native EOF. */
export function createExecutionFailures(){
 const pending=new Map<string,Promise<void>>(),required=new Set<string>();let registrationClosed=false,settled:Promise<readonly {readonly error:unknown;readonly sightings:readonly {readonly stage:string;readonly role:string}[]}[]>|undefined;
 const records=new Map<unknown,{error:unknown;sightings:{stage:string;role:string}[]}>();
 const observe=(stage:string,role:string,error:unknown)=>{let record=records.get(error);if(!record){record={error,sightings:[]};records.set(error,record);}if(!record.sightings.some(item=>item.stage===stage&&item.role===role))record.sightings.push({stage,role});};
 const tracker={observe,capture(stage:string,completion:StageCompletion){if(completion.status==='closed'&&required.has(stage))observe(stage,'incomplete',completion.error);if(completion.status==='error'||completion.status==='cancelled')observe(stage,'primary',completion.error);for(const error of completion.secondaryErrors)observe(stage,'cleanup',error);},
  snapshot(){return Object.freeze([...records.values()].map(record=>Object.freeze({error:record.error,sightings:Object.freeze(record.sightings.map(item=>Object.freeze({...item})))})));},
  register(stage:string,completion:Promise<StageCompletion>,options:{required?:boolean}={}){if(registrationClosed)throw new Error('Execution stage registration is closed');if(pending.has(stage))throw new Error('Execution stage already registered');if(options.required)required.add(stage);pending.set(stage,completion.then(value=>{tracker.capture(stage,value);},error=>{observe(stage,'completion',error);}));},
  settle(){if(!settled){registrationClosed=true;settled=Promise.all([...pending.values()]).then(()=>tracker.snapshot());}return settled;},
  async finish(){await tracker.settle();tracker.assertSuccess();return tracker.snapshot();},
  assertSuccess(){if(records.size)throw records.values().next().value!.error;}
 };return tracker;
}
