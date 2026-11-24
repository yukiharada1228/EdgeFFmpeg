import {expect,it} from 'vitest';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const value of frames)result.push(value);return result;}
const step=(text:string)=>compileAudioFilterChain(text).steps[0];
const widths={u8:1,s16:2,s32:4,flt:4,dbl:8} as const;
it('parses positional and named mode and seed options and refuses everything else with exact messages',()=>{
  expect(step('aperms')).toEqual({name:'aperms',mode:'none',seed:null});
  for(const mode of ['none','ro','rw','toggle'])expect(step(`aperms=${mode}`)).toEqual({name:'aperms',mode,seed:null});
  expect(step('aperms=mode=toggle')).toEqual({name:'aperms',mode:'toggle',seed:null});
  expect(step('aperms=mode=random:seed=7')).toEqual({name:'aperms',mode:'random',seed:7n});
  expect(step('aperms=random:0')).toEqual({name:'aperms',mode:'random',seed:0n});
  expect(step('aperms=random:seed=4294967295')).toEqual({name:'aperms',mode:'random',seed:4294967295n});
  expect(step('aperms=seed=9:mode=random')).toEqual({name:'aperms',mode:'random',seed:9n});
  expect(step('aperms=ro:seed=-1')).toEqual({name:'aperms',mode:'ro',seed:null});
  expect(step('aperms=mode=rw:mode=none')).toEqual({name:'aperms',mode:'none',seed:null});
  const refusals:[string,string][]=[
    ['aperms=random','aperms random mode requires an explicit seed'],['aperms=mode=random','aperms random mode requires an explicit seed'],['aperms=mode=random:seed=-1','aperms random mode requires an explicit seed'],
    ['aperms=seed=-2','Invalid aperms seed: -2'],['aperms=seed=4294967296','Invalid aperms seed: 4294967296'],['aperms=random:seed=07','Invalid aperms seed: 07'],['aperms=random:seed=0x7','Invalid aperms seed: 0x7'],['aperms=random:seed=','Invalid aperms seed: '],['aperms=random:seed=99999999999','Invalid aperms seed: 99999999999'],
    ['aperms=mode=bogus','Unsupported aperms mode: bogus'],['aperms=bogus','Unsupported aperms mode: bogus'],['aperms=1','Unsupported aperms mode: 1'],['aperms=RO','Unsupported aperms mode: RO'],['aperms=mode=ro+rw','Unsupported aperms mode: ro+rw'],
    ['aperms=enable=1','Unsupported aperms option: enable'],['aperms=m=ro','Unsupported aperms option: m'],['aperms=foo=1','Unsupported aperms option: foo'],
    ['aperms=ro:7:1','Invalid aperms option'],['aperms=mode=ro:7','Invalid aperms option'],['aperms=mode=ro=rw','Invalid aperms option']
  ];
  for(const [text,message]of refusals){expect(()=>compileAudioFilterChain(text),text).toThrow(AudioFilterError);expect(()=>compileAudioFilterChain(text),text).toThrow(message);}
  expect(()=>compileAudioFilterChain('apermsx')).toThrow('Unsupported audio filter: apermsx');
});
it('declares every capability false, negotiates the input format unchanged and leaves counts, packets and reservations alone',()=>{
  for(const text of ['aperms','aperms=mode=toggle','aperms=mode=random:seed=7']){
    const chain=compileAudioFilterChain(text);
    expect(audioFilterCapabilities(chain.steps[0]!)).toEqual({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:false,timeSelection:false,flacInput:false,stateless:true,changesRate:false});
    expect(chain.reframes).toBe(false);expect(chain.maxBufferedSamples).toBe(0);
    for(const format of ['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'] as const){expect(chain.negotiatedSampleFormats(format)).toEqual([format]);expect(chain.requiresScalarRounding(format)).toBe(compileAudioFilterChain('anull').requiresScalarRounding(format));}
    expect(chain.planSamples(13n,8000,{channels:2})).toMatchObject({samples:13n,buffers:[]});expect(chain.outputSamples(0n,8000,{configuredInput:true,channels:1})).toBe(0n);
    expect(chain.packetSections(13n,5n,8000,true,2)).toEqual([{samples:13n,span:5n}]);expect(chain.packetSections(0n,5n,8000,true,2)).toEqual([]);expect(chain.outputPacketSamples(7n)).toBe(7n);
    expect(chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{samples:13n,channels:2,configuredInput:true}).map(entry=>[entry.reservation,entry.countBuffers])).toEqual([[{frames:0,buffers:[],stateBytes:0n},[]]]);
    expect([...chain.reservations({sampleRate:8000,channels:2,sampleFormat:'flt'})]).toEqual([{frames:0,buffers:[],stateBytes:0n}]);
    expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow('aperms with sample rate conversion is not implemented');expect(chain.rateBoundary('s16',8000,8000)).toBeNull();
    for(const layout of ['mono','stereo','unspecified','2 channels (FL+FC)','downmix','3.0(back)'])expect(()=>chain.validateInputFormat({sampleRate:8000,channels:layout==='mono'?1:layout==='unspecified'||layout==='3.0(back)'?3:2,channelLayout:layout})).not.toThrow();
  }
  const composed=compileAudioFilterChain('aperms=toggle,asetnsamples=5,aperms=ro,apad=pad_len=3');
  expect(composed.outputSamples(13n,8000,{channels:1})).toBe(18n);expect(composed.packetSections(13n,4n,8000,false,1)).toEqual([{samples:15n,span:5n},{samples:3n,span:4096n}]);
  expect(compileAudioFilterChain('volume=0.5:precision=fixed,aperms=rw',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toEqual(['s16','s16']);
});
it('returns every input frame unchanged with its own planes, for every mode, format, channel count and frame split',async()=>{
  for(const text of ['aperms','aperms=ro','aperms=rw','aperms=toggle','aperms=random:seed=0','aperms=random:7','aperms=mode=random:seed=4294967295','aperms=toggle,aperms=random:seed=7'])
    for(const format of ['u8','s16','s32','flt','dbl','s16p','dblp'] as const)for(const channels of [1,2]){
      const width=widths[format.replace(/p$/,'') as keyof typeof widths],planar=format.endsWith('p'),chain=compileAudioFilterChain(text),total=23,source=Uint8Array.from({length:total*channels*width},(_,i)=>(i*37+11)&255);
      for(const sizes of [[23],[1,4,7,11],[5,5,5,5,3]]){
        let offset=0;const frames:AudioFrameData[]=sizes.map(samples=>{const planes=planar?Array.from({length:channels},(_,c)=>source.slice((c*total+offset)*width,(c*total+offset+samples)*width)):[source.slice(offset*channels*width,(offset+samples)*channels*width)];const frame:AudioFrameData={sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples,planes,pts:{value:BigInt(offset)+90071992547409920n,timeBase:{num:1n,den:8000n}}};offset+=samples;return frame;});
        const copies=frames.map(frame=>frame.planes.map(plane=>plane.slice()));
        // The C filter forwards the same AVFrame (or a reference clone): data, count, layout and pts are those of the input.
        for(const frame of frames)expect(chain.apply(frame,{maxFrameBytes:1024})).toBe(frame);
        const output=await collect(chain.process(input(...frames),{maxFrameBytes:1024}));
        expect(output,`${text} ${format} ${channels} ${sizes}`).toEqual(frames);expect(frames.map(frame=>frame.planes)).toEqual(copies);
        const joined=planar?Array.from({length:channels},(_,c)=>Buffer.concat(output.map(frame=>frame.planes[c]!))):[Buffer.concat(output.map(frame=>frame.planes[0]!))];
        expect(Buffer.concat(joined).equals(Buffer.from(source))).toBe(true);
      }
    }
});
it('keeps the chain allocation limits and observes cancellation',async()=>{
  const chain=compileAudioFilterChain('aperms=toggle'),frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:4,planes:[new Uint8Array(16)],pts:null};
  expect(()=>chain.apply(frame,{maxFrameBytes:15})).toThrow('Audio filter frame exceeds allocation limit');
  expect(()=>chain.apply({...frame,planes:[new Uint8Array(15)]},{maxFrameBytes:64})).toThrow('Invalid audio filter plane');
  const controller=new AbortController();controller.abort();
  expect(()=>chain.apply(frame,{maxFrameBytes:64,signal:controller.signal})).toThrow();
  await expect(collect(chain.process(input(frame,frame),{maxFrameBytes:64,signal:controller.signal}))).rejects.toThrow();
  const later=new AbortController(),seen:AudioFrameData[]=[];
  await expect((async()=>{for await(const value of chain.process(input(frame,frame,frame),{maxFrameBytes:64,signal:later.signal})){seen.push(value);later.abort();}})()).rejects.toThrow();
  expect(seen).toHaveLength(1);
});
