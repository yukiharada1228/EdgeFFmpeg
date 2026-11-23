#include <inttypes.h>
#include <stdio.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/sha.h>
#include <libavutil/intreadwrite.h>
#include <libavutil/mem.h>
static void integer(int64_t value){if(value==AV_NOPTS_VALUE)printf("null");else printf("\"%"PRId64"\"",value);}
static void hex(const uint8_t *data,int size){for(int i=0;i<size;i++)printf("%02x",data[i]);}
int main(int argc,char **argv){
 if(argc!=2)return 2;
 if(avformat_version()!=LIBAVFORMAT_VERSION_INT||avcodec_version()!=LIBAVCODEC_VERSION_INT||avutil_version()!=LIBAVUTIL_VERSION_INT)return 10;
 AVFormatContext *ctx=NULL;AVPacket *packet=av_packet_alloc();struct AVSHA *sha=av_sha_alloc();
 if(!packet||!sha)return 3;
 av_log_set_level(AV_LOG_ERROR);
 int ret=avformat_open_input(&ctx,argv[1],NULL,NULL);if(ret<0)return 4;
 ret=avformat_find_stream_info(ctx,NULL);if(ret<0)return 5;
 printf("{\"packets\":[");int first=1,count=0;
 while((ret=av_read_frame(ctx,packet))>=0){
  if(++count>65536)return 6;
  if(!first)printf(",");first=0;
  printf("{\"stream_index\":%d,\"pts\":",packet->stream_index);
  integer(packet->pts);printf(",\"dts\":");integer(packet->dts);
  printf(",\"duration\":\"%" PRId64 "\",\"pos\":\"%" PRId64 "\",\"flags\":%d,\"size\":%d,\"sha256\":\"",packet->duration,packet->pos,packet->flags,packet->size);
  uint8_t digest[32];av_sha_init(sha,256);av_sha_update(sha,packet->data,packet->size);av_sha_final(sha,digest);hex(digest,32);printf("\"");
  size_t size=0;const uint8_t *side=av_packet_get_side_data(packet,AV_PKT_DATA_SKIP_SAMPLES,&size);
  if(side){if(size<10)return 7;printf(",\"skipSamples\":{\"skipSamples\":%u,\"discardPadding\":%u}",AV_RL32(side),AV_RL32(side+4));}
  else printf(",\"skipSamples\":null");printf("}");av_packet_unref(packet);
 }
 if(ret!=AVERROR_EOF)return 8;
 printf("],\"streams\":[");
 for(unsigned i=0;i<ctx->nb_streams;i++){
  const AVStream *st=ctx->streams[i];const AVCodecParameters *par=st->codecpar;if(i)printf(",");
  if(par->codec_type!=AVMEDIA_TYPE_AUDIO||par->codec_id!=AV_CODEC_ID_AAC)return 9;
  printf("{\"codec\":\"aac\",\"id\":%d,\"default\":%d,\"timeBase\":\"%d/%d\",\"sampleRate\":%d,\"channels\":%d,\"start\":",st->id,!!(st->disposition&AV_DISPOSITION_DEFAULT),st->time_base.num,st->time_base.den,par->sample_rate,par->ch_layout.nb_channels);integer(st->start_time);printf(",\"duration\":");integer(st->duration);printf(",\"count\":\"%"PRId64"\",\"extradata\":\"",st->nb_frames);hex(par->extradata,par->extradata_size);printf("\"}");
 }
 printf("],\"formatStartUs\":");integer(ctx->start_time);printf("}\n");
 avformat_close_input(&ctx);av_packet_free(&packet);av_free(sha);return 0;
}
