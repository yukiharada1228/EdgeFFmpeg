import {expect,it} from 'vitest';import {openOutputGroup,OutputGroupError} from '../../packages/avformat/src/output-group.js';import type {VirtualFileSystem} from '@edge-ffmpeg/core';
const signal=()=>new AbortController().signal;
it('prepares every output before publishing any file and commits only once',async()=>{
 const commits:string[]=[],fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(path){return {async write(){},async abort(){},async commit(){commits.push(path);}};}};
 const group=await openOutputGroup(fs,['/a','/b'],false,signal());await group.writers[0]!.commit();await expect(group.commit()).rejects.toThrow();expect(commits).toEqual([]);await group.writers[1]!.commit();expect(commits).toEqual([]);await group.commit();await group.commit();expect(commits).toEqual(['/a','/b']);
});
it('reports published and uncertain outputs and aborts untouched outputs after a commit failure',async()=>{
 const aborted:string[]=[],fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(path){return {async write(){},async commit(){if(path==='/b')throw new Error('Lost commit acknowledgment');},async abort(){aborted.push(path);}};}};
 const group=await openOutputGroup(fs,['/a','/b','/c'],false,signal());for(const writer of group.writers)await writer.commit();let failure:unknown;try{await group.commit();}catch(error){failure=error;}expect(failure).toBeInstanceOf(OutputGroupError);expect((failure as OutputGroupError).effects).toEqual([{path:'/a',status:'published'},{path:'/b',status:'uncertain'},{path:'/c',status:'aborted'}]);expect((failure as OutputGroupError).publishedOutputs).toEqual(['/a']);expect(aborted).toEqual(['/b','/c']);await expect(group.commit()).rejects.toThrow();
});
it('retains positive publication markers and exposes cleanup failures without aborting published files',async()=>{
 const aborted:string[]=[],cleanupError=new Error('Cannot remove stage'),fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(path){return {async write(){},async commit(){if(path==='/a')throw Object.assign(new Error('Published but cleanup failed'),{published:true});},async abort(){aborted.push(path);if(path==='/b')throw cleanupError;}};}};
 const group=await openOutputGroup(fs,['/a','/b'],false,signal());for(const writer of group.writers)await writer.commit();let failure:unknown;try{await group.commit();}catch(error){failure=error;}expect((failure as OutputGroupError).effects).toEqual([{path:'/a',status:'published'},{path:'/b',status:'cleanup-failed'}]);expect((failure as OutputGroupError).cleanupErrors).toContain(cleanupError);expect(aborted).toEqual(['/b']);
});
it('aborts opened handles when a later open fails and never opens duplicate destinations',async()=>{
 let opens=0,aborts=0;const fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(){if(++opens===2)throw new Error('No permission');return {async write(){},async commit(){},async abort(){aborts++;}};}};
 await expect(openOutputGroup(fs,['/a','/a'],false,signal())).rejects.toThrow();expect(opens).toBe(0);await expect(openOutputGroup(fs,['/a','/b'],false,signal())).rejects.toThrow(OutputGroupError);expect(aborts).toBe(1);
});
it('waits for in-flight writes and serializes cleanup before closing output handles',async()=>{
 let release!:()=>void,writing=false,aborts=0;const gate=new Promise<void>(resolve=>{release=resolve;}),fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(){return {async write(){writing=true;await gate;writing=false;},async commit(){},async abort(){expect(writing).toBe(false);aborts++;}};}};
 const group=await openOutputGroup(fs,['/a'],false,signal()),write=group.writers[0]!.write(Uint8Array.of(1));const rejected=expect(write).rejects.toThrow();await Promise.resolve();const abort=group.abort(new Error('Cancelled'));release();await Promise.all([rejected,abort]);expect(aborts).toBe(1);expect(group.effects()).toEqual([{path:'/a',status:'aborted'}]);
});
it('reports a completed publication when cancellation arrives during commit and stops later outputs',async()=>{
 let release!:()=>void,commits=0;const controller=new AbortController(),gate=new Promise<void>(resolve=>{release=resolve;}),fs:VirtualFileSystem={async openRead(){throw new Error('Unexpected read');},async openWrite(){return {async write(){},async abort(){},async commit(){commits++;await gate;}};}};
 const group=await openOutputGroup(fs,['/a','/b'],false,controller.signal);for(const writer of group.writers)await writer.commit();const commit=group.commit();await Promise.resolve();controller.abort();release();let failure:unknown;try{await commit;}catch(error){failure=error;}expect(failure).toBeInstanceOf(OutputGroupError);expect((failure as OutputGroupError).effects).toEqual([{path:'/a',status:'published'},{path:'/b',status:'aborted'}]);expect(commits).toBe(1);
});
it('rechecks every no-clobber destination before publishing and aborts all stages on an observed race',async()=>{
 const commits:string[]=[],aborts:string[]=[],fs:VirtualFileSystem={async openRead(){throw Error('Unexpected read');},async outputExists(path){return path==='/b';},async openWrite(path){return{async write(){},async commit(){commits.push(path);},async abort(){aborts.push(path);}};}};
 const group=await openOutputGroup(fs,['/a','/b'],false,signal());for(const writer of group.writers)await writer.commit();let failure:unknown;try{await group.commit();}catch(error){failure=error;}expect(failure).toBeInstanceOf(OutputGroupError);expect(commits).toEqual([]);expect(aborts).toEqual(['/a','/b']);expect((failure as OutputGroupError).publishedOutputs).toEqual([]);expect(group.effects()).toEqual([{path:'/a',status:'aborted'},{path:'/b',status:'aborted'}]);
});
it('retains a capability reason only after completely cleaning earlier opened stages',async()=>{
 const blocked=new (await import('@edge-ffmpeg/core')).ExecutionError('runtime-blocked','No atomic replacement'),cleanup=new Error('cleanup');let aborts=0;
 const make=(fail:boolean):VirtualFileSystem=>({async openRead(){throw Error('Unexpected read');},async openWrite(path){if(path==='/b')throw blocked;return{async write(){},async commit(){throw Error('Unexpected publication');},async abort(){aborts++;if(fail)throw cleanup;}};}});
 await expect(openOutputGroup(make(false),['/a','/b'],false,signal())).rejects.toBe(blocked);let failure:unknown;try{await openOutputGroup(make(true),['/a','/b'],false,signal());}catch(error){failure=error;}expect(failure).toBeInstanceOf(OutputGroupError);expect((failure as OutputGroupError).cause).toBe(blocked);expect((failure as OutputGroupError).cleanupErrors).toContain(cleanup);expect((failure as OutputGroupError).effects).toEqual([{path:'/a',status:'cleanup-failed'}]);expect(aborts).toBe(2);
});
