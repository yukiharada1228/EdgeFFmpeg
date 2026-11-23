/* Experimental original adapter for pinned libFLAC1.5.0. Not a runtime integration. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <FLAC/stream_decoder.h>
#if defined(__wasm__)
__attribute__((import_module("env"),import_name("edge_host_read")))
#endif
extern int32_t edge_host_read(uint32_t destination,uint32_t capacity);
#define ABI 1u
#define INFO_WORDS 29u
#define ST_METADATA 1u
#define ST_FRAME 2u
#define ST_END 3u
#define ST_ERROR 4u
/* info:ABI,status,decoderState,codecError+1,wrapperError,channels,rate,bits,
 blockSamples,sampleLo,sampleHi,totalLo,totalHi,maxBlock,planeCount,planes[8],
 frameBytes,readCap,frameCap,reserved,finishResult,reserved. */
typedef struct {FLAC__StreamDecoder *decoder;uint32_t info[INFO_WORDS];int initialized;} EdgeFlac;
static _Alignas(16) unsigned char unwind_stack[262144];
static uint32_t unwind_data[2];
uint32_t edge_flac_abi(void){return ABI;}
uint32_t edge_flac_info_words(void){return INFO_WORDS;}
uint32_t edge_flac_async_data(uint32_t reset){if(reset||!unwind_data[1]){unwind_data[0]=(uint32_t)(uintptr_t)unwind_stack;unwind_data[1]=(uint32_t)(uintptr_t)(unwind_stack+sizeof(unwind_stack));}return (uint32_t)(uintptr_t)unwind_data;}
static FLAC__StreamDecoderReadStatus read_cb(const FLAC__StreamDecoder *decoder,FLAC__byte buffer[],size_t *bytes,void *opaque){
 (void)decoder;EdgeFlac *ctx=opaque;if(!*bytes){ctx->info[4]=1;return FLAC__STREAM_DECODER_READ_STATUS_ABORT;}
 uint32_t cap=*bytes>ctx->info[24]?ctx->info[24]:(uint32_t)*bytes;int32_t count=edge_host_read((uint32_t)(uintptr_t)buffer,cap);
 if(count<0||(uint32_t)count>cap){*bytes=0;ctx->info[4]=2;return FLAC__STREAM_DECODER_READ_STATUS_ABORT;}
 *bytes=(size_t)count;return count?FLAC__STREAM_DECODER_READ_STATUS_CONTINUE:FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
}
static FLAC__StreamDecoderWriteStatus write_cb(const FLAC__StreamDecoder *decoder,const FLAC__Frame *frame,const FLAC__int32 *const planes[],void *opaque){
 (void)decoder;EdgeFlac *ctx=opaque;uint64_t bytes=(uint64_t)frame->header.channels*frame->header.blocksize*sizeof(FLAC__int32);
 if(ctx->info[14]||frame->header.channels<1||frame->header.channels>8||frame->header.blocksize<1||frame->header.blocksize>65535||frame->header.bits_per_sample<4||frame->header.bits_per_sample>32||bytes>ctx->info[25]){ctx->info[4]=3;return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;}
 /* libFLAC normalizes decoder frame numbers to sample numbers. Never infer
    final-short-frame PTS by multiplying its own block size. */
 if(frame->header.number_type!=FLAC__FRAME_NUMBER_TYPE_SAMPLE_NUMBER){ctx->info[4]=4;return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;}
 ctx->info[5]=frame->header.channels;ctx->info[6]=frame->header.sample_rate;ctx->info[7]=frame->header.bits_per_sample;ctx->info[8]=frame->header.blocksize;
 ctx->info[9]=(uint32_t)frame->header.number.sample_number;ctx->info[10]=(uint32_t)(frame->header.number.sample_number>>32);ctx->info[14]=frame->header.channels;ctx->info[23]=(uint32_t)bytes;
 for(uint32_t i=0;i<frame->header.channels;i++)ctx->info[15+i]=(uint32_t)(uintptr_t)planes[i];return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}
static void metadata_cb(const FLAC__StreamDecoder *decoder,const FLAC__StreamMetadata *metadata,void *opaque){
 (void)decoder;EdgeFlac *ctx=opaque;if(metadata->type!=FLAC__METADATA_TYPE_STREAMINFO)return;
 const FLAC__StreamMetadata_StreamInfo *info=&metadata->data.stream_info;ctx->info[5]=info->channels;ctx->info[6]=info->sample_rate;ctx->info[7]=info->bits_per_sample;ctx->info[11]=(uint32_t)info->total_samples;ctx->info[12]=(uint32_t)(info->total_samples>>32);ctx->info[13]=info->max_blocksize;
 if((uint64_t)info->channels*info->max_blocksize*sizeof(FLAC__int32)>ctx->info[25])ctx->info[4]=3;
}
static void error_cb(const FLAC__StreamDecoder *decoder,FLAC__StreamDecoderErrorStatus status,void *opaque){(void)decoder;((EdgeFlac*)opaque)->info[3]=(uint32_t)status+1;}
uint32_t edge_flac_create(uint32_t read_cap,uint32_t frame_cap,uint32_t md5){
 if(!read_cap||read_cap>1048576||!frame_cap)return 0;EdgeFlac *ctx=calloc(1,sizeof(*ctx));if(!ctx)return 0;
 ctx->info[0]=ABI;ctx->info[24]=read_cap;ctx->info[25]=frame_cap;ctx->decoder=FLAC__stream_decoder_new();
 if(!ctx->decoder){free(ctx);return 0;}
 if(!FLAC__stream_decoder_set_metadata_ignore_all(ctx->decoder)||!FLAC__stream_decoder_set_metadata_respond(ctx->decoder,FLAC__METADATA_TYPE_STREAMINFO)||!FLAC__stream_decoder_set_md5_checking(ctx->decoder,md5!=0)){FLAC__stream_decoder_delete(ctx->decoder);free(ctx);return 0;}
 if(FLAC__stream_decoder_init_stream(ctx->decoder,read_cb,NULL,NULL,NULL,NULL,write_cb,metadata_cb,error_cb,ctx)!=FLAC__STREAM_DECODER_INIT_STATUS_OK){FLAC__stream_decoder_delete(ctx->decoder);free(ctx);return 0;}
 ctx->initialized=1;return (uint32_t)(uintptr_t)ctx;
}
uint32_t edge_flac_info(uint32_t handle){return handle?(uint32_t)(uintptr_t)((EdgeFlac*)(uintptr_t)handle)->info:0;}
uint32_t edge_flac_step(uint32_t handle){
 if(!handle)return ST_ERROR;EdgeFlac *ctx=(EdgeFlac*)(uintptr_t)handle;
 if(ctx->info[1]==ST_END||ctx->info[1]==ST_ERROR)return ctx->info[1];
 if(ctx->info[3]||ctx->info[4])return ctx->info[1]=ST_ERROR;
 ctx->info[14]=0;ctx->info[23]=0;memset(ctx->info+15,0,8*sizeof(uint32_t));
 int ok=FLAC__stream_decoder_process_single(ctx->decoder);FLAC__StreamDecoderState state=FLAC__stream_decoder_get_state(ctx->decoder);ctx->info[2]=(uint32_t)state;
 if(!ok||ctx->info[3]||ctx->info[4]||state==FLAC__STREAM_DECODER_ABORTED||state==FLAC__STREAM_DECODER_MEMORY_ALLOCATION_ERROR||state==FLAC__STREAM_DECODER_OGG_ERROR||state==FLAC__STREAM_DECODER_SEEK_ERROR||state==FLAC__STREAM_DECODER_END_OF_LINK)return ctx->info[1]=ST_ERROR;
 if(ctx->info[14])return ctx->info[1]=ST_FRAME;
 if(state==FLAC__STREAM_DECODER_END_OF_STREAM){int finished=FLAC__stream_decoder_finish(ctx->decoder);ctx->initialized=0;ctx->info[27]=finished?1:2;return ctx->info[1]=finished?ST_END:ST_ERROR;}
 return ctx->info[1]=ST_METADATA;
}
void edge_flac_destroy(uint32_t handle){if(!handle)return;EdgeFlac *ctx=(EdgeFlac*)(uintptr_t)handle;if(ctx->initialized)FLAC__stream_decoder_finish(ctx->decoder);FLAC__stream_decoder_delete(ctx->decoder);memset(ctx,0,sizeof(*ctx));free(ctx);}
