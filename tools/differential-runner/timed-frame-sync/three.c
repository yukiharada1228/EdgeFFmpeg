#include <stdio.h>
#include <errno.h>
#include "libavfilter/avfilter_internal.h"
#include "libavfilter/filters.h"
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
static int feed(AVFilterContext *source,const char *sequence,int value,const char *end_text,int status){
 char *text=av_strdup(sequence),*state=NULL,*point=strtok_r(text,",",&state);int count=0,ret=0;
 while(point&&ret>=0){if(count>=32){ret=-1;break;}char *end=NULL;int64_t pts=strtoll(point,&end,10);if(*end){ret=-1;break;}AVFrame *frame=av_frame_alloc();frame->format=AV_PIX_FMT_GRAY8;frame->width=frame->height=1;frame->pts=pts;ret=av_frame_get_buffer(frame,32);if(ret>=0){frame->data[0][0]=value+count;ret=av_buffersrc_add_frame_flags(source,frame,0);}av_frame_free(&frame);point=strtok_r(NULL,",",&state);count++;}
 av_free(text);if(ret<0)return ret;int64_t end_pts=!strcmp(end_text,"N")?AV_NOPTS_VALUE:strtoll(end_text,NULL,10);if(status){ff_avfilter_link_set_in_status(source->outputs[0],AVERROR(EIO),end_pts);return 0;}return av_buffersrc_close(source,end_pts,0);
}
int main(int argc,char **argv){
 if(argc!=14)return 2;av_log_set_level(AV_LOG_QUIET);AVFilterGraph *graph=avfilter_graph_alloc();graph->nb_threads=1;AVFilterContext *sources[3]={NULL,NULL,NULL},*stack=NULL,*sink=NULL;int ret=0;
 for(int i=0;i<3&&ret>=0;i++){char args[256],name[32];snprintf(args,sizeof(args),"video_size=1x1:pix_fmt=%d:time_base=%s:pixel_aspect=0/1",AV_PIX_FMT_GRAY8,argv[2+i]);snprintf(name,sizeof(name),"source%d",i);ret=avfilter_graph_create_filter(&sources[i],avfilter_get_by_name("buffer"),name,args,NULL,graph);}
 char args[64];snprintf(args,sizeof(args),"inputs=3:shortest=%s",argv[1]);if(ret>=0)ret=avfilter_graph_create_filter(&stack,avfilter_get_by_name("hstack"),"stack",args,NULL,graph);if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),"sink",NULL,NULL,graph);
 for(int i=0;i<3&&ret>=0;i++)ret=avfilter_link(sources[i],0,stack,i);if(ret>=0)ret=avfilter_link(stack,0,sink,0);if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 if(ret>=0)for(int i=0;i<3&&ret>=0;i++)ret=feed(sources[i],argv[5+i],i?100*i:10,argv[8+i],atoi(argv[11+i]));
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){AVRational base=av_buffersink_get_time_base(sink);printf(",\"timeBase\":{\"num\":%d,\"den\":%d},\"events\":[",base.num,base.den);int count=0;AVFrame *frame=av_frame_alloc();while((ret=av_buffersink_get_frame(sink,frame))>=0){if(count++)putchar(',');printf("{\"pts\":\"%"PRId64"\",\"values\":[%d,%d,%d]}",frame->pts,frame->data[0][0],frame->data[0][1],frame->data[0][2]);av_frame_unref(frame);if(count>256){ret=-1;break;}}FilterLinkInternal *out=ff_link_internal(sink->inputs[0]);printf("],\"eof\":%s,\"statusCode\":%d,\"rawStatusPts\":\"%"PRId64"\",\"effectiveStatusPts\":\"%"PRId64"\",\"inputStatusPts\":[\"%"PRId64"\",\"%"PRId64"\",\"%"PRId64"\"]",ret==AVERROR_EOF?"true":"false",ret,out->status_in_pts,out->l.current_pts,ff_link_internal(sources[0]->outputs[0])->l.current_pts,ff_link_internal(sources[1]->outputs[0])->l.current_pts,ff_link_internal(sources[2]->outputs[0])->l.current_pts);av_frame_free(&frame);}puts("}");avfilter_graph_free(&graph);return 0;
}
