import {expect,it} from 'vitest';
import {CheckpointCompatibilityError,deserializeExecutionCheckpoint,serializeExecutionCheckpoint,validateExecutionCheckpoint} from '@edge-ffmpeg/core';
import type {ExecutionCheckpoint,ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
const expected:ExecutionCheckpointIdentity={jobId:'job',workUnitId:'reframe',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'reframe-v1'};
const checkpoint=():ExecutionCheckpoint=>({version:1,...expected,lastCommittedPosition:9007199254740993123n,filterStateRef:'states/filter.bin'});
it('round trips bigint positions and state references through bounded canonical bytes',()=>{
 const bytes=serializeExecutionCheckpoint(checkpoint()),restored=deserializeExecutionCheckpoint(bytes,expected);expect(restored).toEqual(checkpoint());expect(Object.isFrozen(restored)).toBe(true);expect(new TextDecoder().decode(bytes)).toContain('9007199254740993123');
});
it.each(['jobId','workUnitId','graphHash','inputFingerprint','implementationVersion'] as const)('rejects incompatible %s before state restoration',key=>{
 const changed={...expected,[key]:key==='graphHash'||key==='inputFingerprint'?'c'.repeat(64):'different'};expect(()=>deserializeExecutionCheckpoint(serializeExecutionCheckpoint(checkpoint()),changed)).toThrow(CheckpointCompatibilityError);
});
it('rejects unsupported versions, noncanonical counters and unknown state fields',()=>{
 const json=JSON.parse(new TextDecoder().decode(serializeExecutionCheckpoint(checkpoint())));
 for(const override of [{version:2},{lastCommittedPosition:'01'},{lastCommittedPosition:'-1'},{lastCommittedPosition:12},{lastCommittedPosition:'1e10'},{unrecognizedState:'ignored'}])expect(()=>deserializeExecutionCheckpoint(new TextEncoder().encode(JSON.stringify({...json,...override})),expected)).toThrow(CheckpointCompatibilityError);
 expect(()=>validateExecutionCheckpoint({...checkpoint(),lastCommittedPosition:-1n})).toThrow(CheckpointCompatibilityError);
});
it('bounds encoded input before parsing and rejects unsafe reference paths',()=>{
 expect(()=>serializeExecutionCheckpoint(checkpoint(),16)).toThrow(/limit/);expect(()=>deserializeExecutionCheckpoint(new Uint8Array(1025),expected,1024)).toThrow(/limit/);
 for(const ref of ['/absolute','../escape','state/../escape','state\\file','state//file'])expect(()=>validateExecutionCheckpoint({...checkpoint(),filterStateRef:ref})).toThrow(/reference/);
 expect(()=>deserializeExecutionCheckpoint(Uint8Array.of(255),expected)).toThrow(/encoding/);
});
it('snapshots metadata without retaining caller-owned checkpoint objects',()=>{
 const mutable={...checkpoint()},snapshot=validateExecutionCheckpoint(mutable),bytes=serializeExecutionCheckpoint(mutable);mutable.filterStateRef='different/state';mutable.lastCommittedPosition=0n;expect(snapshot).toEqual(checkpoint());expect(deserializeExecutionCheckpoint(bytes,expected)).toEqual(checkpoint());
});

it('retains canonical graph component identifiers without delimiter rewriting',()=>{
 const identity={...expected,workUnitId:'component:["source:左","sink/output"]'},value={...checkpoint(),...identity};expect(deserializeExecutionCheckpoint(serializeExecutionCheckpoint(value),identity)).toEqual(value);
});
