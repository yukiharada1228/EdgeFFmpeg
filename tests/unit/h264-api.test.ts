import {describe,it,expect} from 'vitest';
import {createH264Decoder,validateH264DecoderOptions,H264InputError,createAvcDecoder} from '@edge-ffmpeg/avcodec';
const module=new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
const options={maxPacketBytes:1048576,maxFrameBytes:4194304,maxMemoryBytes:67108864,maxResidentBytes:134217728,maxPendingPackets:32,maxNalUnits:16384,maxDisplayBytes:16777216,initialReorderDelay:2};
function oldAbiModule(){
 const names=['edge_abi_version','edge_create','edge_decode_order','edge_destroy','edge_decode','edge_info','edge_forbidden_thread_calls','malloc','free'];
 const uint=(value:number)=>{const bytes:number[]=[];do{const byte=value&127;value>>>=7;bytes.push(byte|(value?128:0));}while(value);return bytes;};
 const exports=names.flatMap(name=>{const bytes=[...new TextEncoder().encode(name)];return [...uint(bytes.length),...bytes,0,0];});
 const section=[names.length,...exports];
 return new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,...uint(section.length),...section,10,6,1,4,0,65,1,11]));
}
describe('public H264 resource and module boundary',()=>{
 it('validates the combined display/codec reservation before instantiation',()=>{const checked=validateH264DecoderOptions(options);expect(Object.isFrozen(checked)).toBe(true);expect(checked).toEqual(options);expect(()=>createH264Decoder(module,{...options,maxResidentBytes:67108864})).toThrow(/reservation/);expect(()=>createH264Decoder(module,{...options,maxMemoryBytes:67239936})).toThrow(H264InputError);expect(()=>createH264Decoder(module,{...options,initialReorderDelay:17})).toThrow(/presentation/);});
 it('rejects an incomplete codec module and preserves an existing cancellation reason',()=>{expect(()=>createH264Decoder(module,options)).toThrow(/Incomplete H264 Wasm ABI/);const controller=new AbortController(),reason=new Error('cancel before codec allocation');controller.abort(reason);expect(()=>createH264Decoder(module,{...options,signal:controller.signal})).toThrow(reason);expect(()=>createAvcDecoder(module,new Uint8Array(),options)).toThrow(H264InputError);});
 it('rejects an older metadata ABI before creating a decoder',()=>{expect(()=>createH264Decoder(oldAbiModule(),options)).toThrow('Unsupported H264 Wasm ABI version');});
});
