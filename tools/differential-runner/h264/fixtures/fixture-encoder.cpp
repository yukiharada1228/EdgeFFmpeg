// Development fixture encoder only; no FFmpeg implementation is linked.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include "codec_api.h"
static uint32_t forbidden_thread_calls=0;
extern "C" int sem_timedwait(sem_t*,const struct timespec*){forbidden_thread_calls++;errno=ENOSYS;return -1;}
extern "C" int pthread_create(pthread_t*,const pthread_attr_t*,void*(*)(void*),void*){forbidden_thread_calls++;return ENOSYS;}
extern "C" uint32_t edge_forbidden_thread_calls(){return forbidden_thread_calls;}
static uint8_t owned_stream[262144];
static uint32_t owned_length=0;
extern "C" uint32_t edge_owned_data(){return (uintptr_t)owned_stream;}
extern "C" uint32_t edge_owned_size(){return owned_length;}
extern "C" int edge_encode_owned(int entropy,int seed){
 ISVCEncoder* encoder=NULL;owned_length=0;
 if(WelsCreateSVCEncoder(&encoder)!=0||!encoder)return -1;
 SEncParamExt params={};encoder->GetDefaultParams(&params);
 params.iUsageType=CAMERA_VIDEO_REAL_TIME;params.fMaxFrameRate=25.0f;
 params.iPicWidth=64;params.iPicHeight=48;params.iTargetBitrate=200000;
 params.iRCMode=RC_OFF_MODE;params.iTemporalLayerNum=1;params.iSpatialLayerNum=1;
 params.iMultipleThreadIdc=1;params.uiIntraPeriod=3;params.bEnableFrameSkip=false;
 params.bEnableSSEI=false;params.bSimulcastAVC=true;params.iEntropyCodingModeFlag=entropy;
 params.bEnableSceneChangeDetect=false;params.bEnableAdaptiveQuant=false;
 params.sSpatialLayers[0].iVideoWidth=64;params.sSpatialLayers[0].iVideoHeight=48;
 params.sSpatialLayers[0].fFrameRate=25.0f;params.sSpatialLayers[0].iSpatialBitrate=200000;
 params.sSpatialLayers[0].iMaxSpatialBitrate=200000;
 params.sSpatialLayers[0].uiProfileIdc=entropy?PRO_MAIN:PRO_BASELINE;
 int trace=0;encoder->SetOption(ENCODER_OPTION_TRACE_LEVEL,&trace);
 int status=encoder->InitializeExt(&params);
 if(status){WelsDestroySVCEncoder(encoder);return status;}
 uint8_t pixels[64*48*3/2];SSourcePicture picture={};
 picture.iColorFormat=videoFormatI420;picture.iPicWidth=64;picture.iPicHeight=48;
 picture.iStride[0]=64;picture.iStride[1]=picture.iStride[2]=32;
 picture.pData[0]=pixels;picture.pData[1]=pixels+64*48;picture.pData[2]=pixels+64*48+32*24;
 for(int n=0;n<6;n++){
  for(int y=0;y<48;y++)for(int x=0;x<64;x++)pixels[y*64+x]=(x*3+y*5+n*17+seed*31)&255;
  for(int y=0;y<24;y++)for(int x=0;x<32;x++){picture.pData[1][y*32+x]=(64+x*7+n*3+seed*13)&255;picture.pData[2][y*32+x]=(128+y*5+n*11+seed*19)&255;}
  picture.uiTimeStamp=n*40;SFrameBSInfo info={};status=encoder->EncodeFrame(&picture,&info);if(status)break;
  uint32_t bytes=0;for(int l=0;l<info.iLayerNum;l++)for(int i=0;i<info.sLayerInfo[l].iNalCount;i++)bytes+=info.sLayerInfo[l].pNalLengthInByte[i];
  if(!bytes||bytes>sizeof(owned_stream)-owned_length-4){status=-2;break;}
  memcpy(owned_stream+owned_length,&bytes,4);owned_length+=4;
  for(int l=0;l<info.iLayerNum;l++){uint32_t size=0;for(int i=0;i<info.sLayerInfo[l].iNalCount;i++)size+=info.sLayerInfo[l].pNalLengthInByte[i];memcpy(owned_stream+owned_length,info.sLayerInfo[l].pBsBuf,size);owned_length+=size;}
 }
 encoder->Uninitialize();WelsDestroySVCEncoder(encoder);return status;
}
