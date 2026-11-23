#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include "libavfilter/avfilter.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/buffersink.h"
#include "libavutil/log.h"
#include "libavutil/error.h"
#include "libavutil/pixfmt.h"
#include "libavutil/mem.h"
static int feed(AVFilterContext *source,const char *sequence,int value){
 char *text=av_strdup(sequence),*state=NULL,*point=strtok_r(text,",",&state);int count=0,ret=0;
 while(point&&ret>=0){if(count>=32){ret=-1;break;}char *end=NULL;int64_t pts=strtoll(point,&end,10);if(*end){ret=-1;break;}AVFrame *frame=av_frame_alloc();frame->format=AV_PIX_FMT_GRAY8;frame->width=frame->height=1;frame->pts=pts;ret=av_frame_get_buffer(frame,32);if(ret>=0){frame->data[0][0]=value+count;ret=av_buffersrc_add_frame_flags(source,frame,0);}av_frame_free(&frame);point=strtok_r(NULL,",",&state);count++;}
 av_free(text);return ret<0?ret:av_buffersrc_add_frame_flags(source,NULL,0);
}
int main(int argc,char **argv){
 if(argc!=6)return 2;av_log_set_level(AV_LOG_QUIET);AVFilterGraph *graph=avfilter_graph_alloc();graph->nb_threads=1;AVFilterContext *sources[2]={NULL,NULL},*stack=NULL,*sink=NULL;int ret=0;
 for(int i=0;i<2&&ret>=0;i++){char args[256],name[32];snprintf(args,sizeof(args),"video_size=1x1:pix_fmt=%d:time_base=%s:pixel_aspect=0/1",AV_PIX_FMT_GRAY8,argv[2+i]);snprintf(name,sizeof(name),"source%d",i);ret=avfilter_graph_create_filter(&sources[i],avfilter_get_by_name("buffer"),name,args,NULL,graph);}
 char args[64];snprintf(args,sizeof(args),"inputs=2:shortest=%s",argv[1]);if(ret>=0)ret=avfilter_graph_create_filter(&stack,avfilter_get_by_name("hstack"),"stack",args,NULL,graph);if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),"sink",NULL,NULL,graph);
 for(int i=0;i<2&&ret>=0;i++)ret=avfilter_link(sources[i],0,stack,i);if(ret>=0)ret=avfilter_link(stack,0,sink,0);if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 if(ret>=0)for(int i=0;i<2&&ret>=0;i++)ret=feed(sources[i],argv[4+i],i?100:10);
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){AVRational base=av_buffersink_get_time_base(sink);printf(",\"timeBase\":{\"num\":%d,\"den\":%d},\"events\":[",base.num,base.den);int count=0;AVFrame *frame=av_frame_alloc();while((ret=av_buffersink_get_frame(sink,frame))>=0){if(count++)putchar(',');printf("{\"pts\":\"%"PRId64"\",\"values\":[%d,%d]}",frame->pts,frame->data[0][0],frame->data[0][1]);av_frame_unref(frame);if(count>256){ret=-1;break;}}printf("],\"eof\":%s",ret==AVERROR_EOF?"true":"false");av_frame_free(&frame);}puts("}");avfilter_graph_free(&graph);return 0;
}
