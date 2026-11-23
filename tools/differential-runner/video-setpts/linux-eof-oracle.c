#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#include "libavfilter/avfilter.h"
#include "libavfilter/avfilter_internal.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/buffersink.h"
#include "libavutil/opt.h"
#include "libavutil/log.h"
#include "libavutil/pixfmt.h"
#include "libavutil/mem.h"
static int64_t now_value=1000000;
int64_t av_gettime(void){return now_value;}
int64_t av_gettime_relative(void){return now_value;}
int av_gettime_relative_is_monotonic(void){return 1;}
int av_usleep(unsigned usec){fprintf(stderr,"Unexpected Native sleep in deterministic oracle\n");exit(5);}

static int run_query(int argc,char **argv){now_value=1000000;if(argc!=7&&argc!=9)return 2;av_log_set_level(AV_LOG_QUIET);AVFilterGraph *graph=avfilter_graph_alloc();graph->nb_threads=1;AVFilterContext *source=NULL,*set=NULL,*sink=NULL;char args[256];snprintf(args,sizeof(args),"video_size=1x1:pix_fmt=%d:time_base=%s:frame_rate=%s:pixel_aspect=1/1",AV_PIX_FMT_GRAY8,argv[2],argv[3]);int ret=avfilter_graph_create_filter(&source,avfilter_get_by_name("buffer"),"source",args,NULL,graph);
 if(ret>=0){set=avfilter_graph_alloc_filter(graph,avfilter_get_by_name("setpts"),"set");if(!set)ret=-1;}
 if(ret>=0)ret=av_opt_set(set->priv,"expr",argv[1],0);if(ret>=0)ret=av_opt_set_int(set->priv,"strip_fps",atoi(argv[5]),0);if(ret>=0)ret=avfilter_init_str(set,NULL);
 if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),"sink",NULL,NULL,graph);if(ret>=0)ret=avfilter_link(source,0,set,0);if(ret>=0)ret=avfilter_link(set,0,sink,0);if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){AVRational tb=av_buffersink_get_time_base(sink),fr=av_buffersink_get_frame_rate(sink);printf(",\"timeBase\":[%d,%d],\"frameRate\":[%d,%d],\"frames\":[",tb.num,tb.den,fr.num,fr.den);char *text=av_strdup(argv[4]),*save=NULL,*point=strtok_r(text,",",&save);int index=0,command_ret=0;while(point&&ret>=0){if(index>=32){ret=-1;break;}now_value=1000000+index*1000;if(argc==9&&index==atoi(argv[7]))command_ret=avfilter_process_command(set,"expr",argv[6],NULL,0,0);AVFrame *input=av_frame_alloc(),*output=av_frame_alloc();input->format=AV_PIX_FMT_GRAY8;input->width=input->height=1;input->pts=!strcmp(point,"N")?AV_NOPTS_VALUE:strtoll(point,NULL,10);input->duration=index%3+1;if(index%2)input->flags|=AV_FRAME_FLAG_INTERLACED;ret=av_frame_get_buffer(input,32);if(ret>=0){input->data[0][0]=10+index;ret=av_buffersrc_add_frame_flags(source,input,0);}if(ret>=0)ret=av_buffersink_get_frame(sink,output);if(ret>=0)printf("%s{\"pts\":\"%" PRId64 "\",\"duration\":\"%" PRId64 "\",\"value\":%d}",index?",":"",output->pts,output->duration,output->data[0][0]);av_frame_free(&input);av_frame_free(&output);point=strtok_r(NULL,",",&save);index++;}av_free(text);int frames_ret=ret;now_value=1000000+index*1000;const char *end_text=argv[argc-1];int64_t end_pts=!strcmp(end_text,"N")?AV_NOPTS_VALUE:strtoll(end_text,NULL,10);int close_ret=av_buffersrc_close(source,end_pts,0);AVFrame *end_frame=av_frame_alloc();int eof_ret=close_ret<0?close_ret:av_buffersink_get_frame(sink,end_frame);av_frame_free(&end_frame);FilterLinkInternal *input_link=ff_link_internal(source->outputs[0]),*output_link=ff_link_internal(sink->inputs[0]);printf("],\"eof\":%s,\"inputStatusPts\":\"%" PRId64 "\",\"rawOutputStatusPts\":\"%" PRId64 "\",\"effectiveOutputStatusPts\":\"%" PRId64 "\"",eof_ret==AVERROR_EOF?"true":"false",input_link->l.current_pts,output_link->status_in_pts,output_link->l.current_pts);printf(",\"commandAccepted\":%s,\"framesAccepted\":%s",command_ret>=0?"true":"false",frames_ret>=0?"true":"false");}printf("}\n");avfilter_graph_free(&graph);return 0;}

int main(void){char line[4096];while(fgets(line,sizeof line,stdin)){size_t size=strlen(line);if(size&&line[size-1]=='\n')line[--size]=0;char *args[12]={"setpts"};int count=1;args[count++]=line;for(char *p=line;*p;p++)if(*p=='\t'){*p=0;args[count++]=p+1;if(count>=12)return 6;}int ret=run_query(count,args);if(ret)return ret;}return 0;}
