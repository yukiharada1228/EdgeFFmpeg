/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Independent public av_parser_parse2 oracle. FFmpeg LGPLv2.1 applies.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/avcodec.h"
int main(int argc,char**argv){
 if(argc!=5)return 2;
 FILE*f=fopen(argv[1],"rb");if(!f)return 3;fseek(f,0,SEEK_END);int n=ftell(f);rewind(f);if(n<0||n>65536)return 4;
 uint8_t*b=av_mallocz(n+AV_INPUT_BUFFER_PADDING_SIZE);if(!b)return 5;fread(b,1,n,f);fclose(f);
 int cap=atoi(argv[2]),flags=atoi(argv[3]),schedule=atoi(argv[4]),at=0;
 AVCodecParserContext*p=av_parser_init(AV_CODEC_ID_FLAC);AVCodecContext*c=avcodec_alloc_context3(NULL);if(!p||!c)return 6;p->flags=flags;c->codec_id=AV_CODEC_ID_FLAC;av_log_set_level(AV_LOG_QUIET);
 for(int call=0;call<2048;call++){
  int size=FFMIN(cap,n-at),outn;uint8_t*out;
  int64_t pts=schedule==2?AV_NOPTS_VALUE:schedule==1?1000+call:123,dts=schedule==2?AV_NOPTS_VALUE:schedule==1?900+call:100,pos=schedule==2?-1:500+at;
  int used=av_parser_parse2(p,c,&out,&outn,b+at,size,pts,dts,pos);
  printf("{\"at\":%d,\"input\":%d,\"used\":%d,\"size\":%d,\"duration\":%d,\"pts\":\"%lld\",\"dts\":\"%lld\",\"pos\":\"%lld\",\"offset\":\"%lld\",\"frameOffset\":\"%lld\",\"nextFrameOffset\":\"%lld\",\"currentOffset\":\"%lld\"}\n",at,size,used,outn,p->duration,(long long)p->pts,(long long)p->dts,(long long)p->pos,(long long)p->offset,(long long)p->frame_offset,(long long)p->next_frame_offset,(long long)p->cur_offset);
  if(!size&&!outn)break;if(!used&&!outn)return 7;at+=used;
 }
 av_parser_close(p);avcodec_free_context(&c);av_free(b);return 0;
}
