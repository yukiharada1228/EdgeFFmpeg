// EdgeFFmpeg experiment: independent OpenH264 API adapter, not FFmpeg code.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include "codec_api.h"
#include "welsDecoderExt.h"
struct EdgeDecoder {ISVCDecoder *codec; uint32_t info[18];};
static uint32_t forbidden_thread_calls=0;
extern "C" {
// The Workers experiment intentionally has no OS thread or timed-wait support.
// Fail explicitly if a library path attempts either operation.
int sem_timedwait(sem_t *,const struct timespec *){forbidden_thread_calls++;errno=ENOSYS;return -1;}
int pthread_create(pthread_t *,const pthread_attr_t *,void *(*)(void *),void *){forbidden_thread_calls++;return ENOSYS;}
uint32_t edge_forbidden_thread_calls(){return forbidden_thread_calls;}

uint32_t edge_abi_version(){return 2;}
uintptr_t edge_create() {
    EdgeDecoder *ctx=(EdgeDecoder*)calloc(1,sizeof(EdgeDecoder));
    if(!ctx)return 0;
    if(WelsCreateDecoder(&ctx->codec)!=0){free(ctx);return 0;}
    SDecodingParam parameters={};parameters.uiTargetDqLayer=255;
    parameters.eEcActiveIdc=ERROR_CON_DISABLE;
    parameters.sVideoProperty.size=sizeof(SVideoProperty);
    parameters.sVideoProperty.eVideoBsType=VIDEO_BITSTREAM_AVC;
    int threads=0,level=0;
    ctx->codec->SetOption(DECODER_OPTION_NUM_OF_THREADS,&threads);
    ctx->codec->SetOption(DECODER_OPTION_TRACE_LEVEL,&level);
    if(ctx->codec->Initialize(&parameters)!=0){WelsDestroyDecoder(ctx->codec);free(ctx);return 0;}
    return (uintptr_t)ctx;
}
void edge_decode_order(uintptr_t handle,int enabled) {
    EdgeDecoder *ctx=(EdgeDecoder*)handle;if(ctx)static_cast<WelsDec::CWelsDecoder*>(ctx->codec)->EdgeDecodeOrder(enabled!=0);
}
void edge_destroy(uintptr_t handle) {
    EdgeDecoder *ctx=(EdgeDecoder*)handle;if(!ctx)return;
    ctx->codec->Uninitialize();WelsDestroyDecoder(ctx->codec);free(ctx);
}
int edge_decode(uintptr_t handle,const unsigned char *bytes,int length,uint64_t token,int flush) {
    EdgeDecoder *ctx=(EdgeDecoder*)handle;if(!ctx||length<0)return -1;
    if (!flush && bytes && length > 3) {
      uint32_t count = 0;
      for (int i=0; i+3<length; ++i) {
        if (bytes[i]==0 && bytes[i+1]==0 && bytes[i+2]==1) {
          const unsigned type = bytes[i+3] & 31;
          if (type==1 || type==5 || type==20) ++count;
          i += 2;
        }
      }
      if (static_cast<WelsDec::CWelsDecoder*>(ctx->codec)->EdgeReserveInputNals(count) != 0) return 16384;
    }
    SBufferInfo frame={};unsigned char *planes[3]={};frame.uiInBsTimeStamp=token;
    int status;
    if(flush){int eof=1;ctx->codec->SetOption(DECODER_OPTION_END_OF_STREAM,&eof);status=ctx->codec->FlushFrame(planes,&frame);if(flush==2){eof=0;ctx->codec->SetOption(DECODER_OPTION_END_OF_STREAM,&eof);}}
    else {int eof=0;ctx->codec->SetOption(DECODER_OPTION_END_OF_STREAM,&eof);status=ctx->codec->DecodeFrameNoDelay(bytes,length,planes,&frame);}
    memset(ctx->info,0,sizeof(ctx->info));ctx->info[0]=frame.iBufferStatus;ctx->info[1]=status;
    if(frame.iBufferStatus){
        SSysMEMBuffer *system=&frame.UsrData.sSystemBuffer;
        ctx->info[2]=system->iWidth;ctx->info[3]=system->iHeight;ctx->info[4]=system->iStride[0];ctx->info[5]=system->iStride[1];
        for(int i=0;i<3;i++)ctx->info[6+i]=(uintptr_t)frame.pDst[i];
        ctx->info[9]=frame.uiOutYuvTimeStamp;ctx->info[10]=frame.uiOutYuvTimeStamp>>32;ctx->info[11]=system->iFormat;
    }
    WelsDec::CWelsDecoder *decoder=static_cast<WelsDec::CWelsDecoder*>(ctx->codec);
    ctx->info[12]=decoder->EdgeOutputPOC();ctx->info[13]=decoder->EdgeOutputSequence();
    ctx->info[14]=decoder->EdgeCurrentPOC();ctx->info[15]=decoder->EdgeCurrentSequence();
    ctx->info[16]=decoder->EdgeCurrentSliceType();ctx->info[17]=decoder->EdgeCurrentMMCO5();
    return status;
}
uintptr_t edge_info(uintptr_t handle){return handle?(uintptr_t)((EdgeDecoder*)handle)->info:0;}
}
