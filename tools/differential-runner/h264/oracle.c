/* Development-only FFmpeg packet/frame oracle. Not linked into runtime Wasm. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/error.h"
#include "libavutil/pixfmt.h"
#include "libavutil/mem.h"
static int read32(uint32_t *value){unsigned char b[4];if(fread(b,1,4,stdin)!=4)return -1;*value=(uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;return 0;}
static int read64(int64_t *value){uint32_t low,high;if(read32(&low)||read32(&high))return -1;*value=(int64_t)((uint64_t)low|((uint64_t)high<<32));return 0;}
static void out32(uint32_t value){for(int i=0;i<4;i++)putchar((value>>(i*8))&255);}
static void out64(int64_t value){out32((uint64_t)value);out32((uint64_t)value>>32);}
static int receive(AVCodecContext *context,AVFrame *frame){
 int status;while((status=avcodec_receive_frame(context,frame))>=0){
  if(av_frame_apply_cropping(frame,AV_FRAME_CROP_UNALIGNED)<0)return -1;
  if((frame->format!=AV_PIX_FMT_YUV420P&&frame->format!=AV_PIX_FMT_YUVJ420P)||frame->width<1||frame->height<1||frame->width>4096||frame->height>4096)return -1;
  int widths[3]={frame->width,(frame->width+1)/2,(frame->width+1)/2},heights[3]={frame->height,(frame->height+1)/2,(frame->height+1)/2};
  out32(frame->width);out32(frame->height);out64(frame->pts);out64(frame->duration);out32(widths[0]*heights[0]+2*widths[1]*heights[1]);out32(frame->format==AV_PIX_FMT_YUVJ420P?1:0);out32(frame->color_range);out32((frame->flags&AV_FRAME_FLAG_KEY)!=0);out32(frame->pict_type);
  for(int p=0;p<3;p++)for(int y=0;y<heights[p];y++)fwrite(frame->data[p]+y*frame->linesize[p],1,widths[p],stdout);
  av_frame_unref(frame);
 }
 return status==AVERROR(EAGAIN)||status==AVERROR_EOF?0:-1;
}
int main(int argc,char **argv){
 if(argc!=2&&argc!=3&&argc!=5)return 1;int delay=atoi(argv[1]);if(delay<0||delay>16)return 1;
 const AVCodec *codec=avcodec_find_decoder(AV_CODEC_ID_H264);AVCodecContext *context=avcodec_alloc_context3(codec);AVFrame *frame=av_frame_alloc();AVPacket *packet=av_packet_alloc();if(!context||!frame||!packet)return 2;
 if(argc>=3){unsigned char bytes[65536];FILE *file=fopen(argv[2],"rb");if(!file)return 8;size_t size=fread(bytes,1,sizeof(bytes),file);fclose(file);if(!size||size==sizeof(bytes))return 8;context->extradata=av_mallocz(size+AV_INPUT_BUFFER_PADDING_SIZE);if(!context->extradata)return 8;memcpy(context->extradata,bytes,size);context->extradata_size=size;}
 context->apply_cropping=0;context->thread_count=1;context->has_b_frames=delay;context->pkt_timebase=argc==5?(AVRational){atoi(argv[3]),atoi(argv[4])}:(AVRational){1,90000};if(context->pkt_timebase.num<=0||context->pkt_timebase.den<=0)return 1;if(avcodec_open2(context,codec,NULL)<0)return 3;
 uint32_t length;while(!read32(&length)&&length){if(length>2097152||av_new_packet(packet,length)<0||read64(&packet->pts)||read64(&packet->dts)||read64(&packet->duration)||fread(packet->data,1,length,stdin)!=length)return 4;
  if(avcodec_send_packet(context,packet)<0||receive(context,frame)<0)return 5;av_packet_unref(packet);
 }
 if(avcodec_send_packet(context,NULL)<0||receive(context,frame)<0)return 6;
 av_packet_free(&packet);av_frame_free(&frame);avcodec_free_context(&context);return ferror(stdout)?7:0;
}
