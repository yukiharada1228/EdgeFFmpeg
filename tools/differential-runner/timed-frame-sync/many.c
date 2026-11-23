#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <errno.h>
#include "libavfilter/avfilter.h"
#include "libavfilter/avfilter_internal.h"
#include "libavfilter/filters.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/buffersink.h"
#include "libavutil/log.h"
#include "libavutil/error.h"
#include "libavutil/pixfmt.h"
#include "libavutil/mem.h"
static int feed(AVFilterContext *source,const char *sequence,int value,const char *end_text,int status){
 char *text=av_strdup(sequence),*state=NULL,*point=strtok_r(text,",",&state);int count=0,ret=0;
 while(point&&ret>=0){if(count>=32){ret=-1;break;}char *end=NULL;int64_t pts=strtoll(point,&end,10);if(*end){ret=-1;break;}AVFrame *frame=av_frame_alloc();frame->format=AV_PIX_FMT_GRAY8;frame->width=frame->height=1;frame->pts=pts;ret=av_frame_get_buffer(frame,32);if(ret>=0){frame->data[0][0]=value+count;ret=av_buffersrc_add_frame_flags(source,frame,0);}av_frame_free(&frame);point=strtok_r(NULL,",",&state);count++;}
 av_free(text);if(ret<0)return ret;int64_t pts=!strcmp(end_text,"N")?AV_NOPTS_VALUE:strtoll(end_text,NULL,10);if(status){ff_avfilter_link_set_in_status(source->outputs[0],AVERROR(EIO),pts);return 0;}return av_buffersrc_close(source,pts,0);
}
int main(int argc,char **argv){
 if(argc<3)return 2;int n=atoi(argv[1]);if(n<2||n>32||argc!=3+4*n)return 2;
 av_log_set_level(AV_LOG_QUIET);AVFilterGraph *graph=avfilter_graph_alloc();graph->nb_threads=1;AVFilterContext *sources[32]={0},*stack=NULL,*sink=NULL;int ret=0;
 for(int i=0;i<n&&ret>=0;i++){char args[256],name[32];snprintf(args,sizeof(args),"video_size=1x1:pix_fmt=%d:time_base=%s:pixel_aspect=0/1",AV_PIX_FMT_GRAY8,argv[3+i]);snprintf(name,sizeof(name),"source%d",i);ret=avfilter_graph_create_filter(&sources[i],avfilter_get_by_name("buffer"),name,args,NULL,graph);}
 char args[64];snprintf(args,sizeof(args),"inputs=%d:shortest=%s",n,argv[2]);if(ret>=0)ret=avfilter_graph_create_filter(&stack,avfilter_get_by_name("hstack"),"stack",args,NULL,graph);if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),"sink",NULL,NULL,graph);
 for(int i=0;i<n&&ret>=0;i++)ret=avfilter_link(sources[i],0,stack,i);if(ret>=0)ret=avfilter_link(stack,0,sink,0);if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 if(ret>=0)for(int i=0;i<n&&ret>=0;i++)ret=feed(sources[i],argv[3+n+i],10+5*i,argv[3+2*n+i],atoi(argv[3+3*n+i]));
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){AVRational base=av_buffersink_get_time_base(sink);printf(",\"timeBase\":{\"num\":%d,\"den\":%d},\"events\":[",base.num,base.den);int count=0;AVFrame *frame=av_frame_alloc();while((ret=av_buffersink_get_frame(sink,frame))>=0){if(count++)putchar(',');printf("{\"pts\":\"%"PRId64"\",\"values\":[",frame->pts);for(int i=0;i<n;i++)printf("%s%d",i?",":"",frame->data[0][i]);printf("]}");av_frame_unref(frame);if(count>256){ret=-1;break;}}
 FilterLinkInternal *out=ff_link_internal(sink->inputs[0]);printf("],\"eof\":%s,\"statusCode\":%d,\"rawStatusPts\":\"%"PRId64"\",\"effectiveStatusPts\":\"%"PRId64"\",\"inputStatusPts\":[",ret==AVERROR_EOF?"true":"false",ret,out->status_in_pts,out->l.current_pts);for(int i=0;i<n;i++)printf("%s\"%"PRId64"\"",i?",":"",ff_link_internal(sources[i]->outputs[0])->l.current_pts);printf("]");av_frame_free(&frame);}puts("}");avfilter_graph_free(&graph);return 0;
}
