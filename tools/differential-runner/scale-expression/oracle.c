/* SPDX-License-Identifier: LGPL-2.1-or-later */
#include <stdio.h>
#include <stdlib.h>
#include "libavfilter/avfilter.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/buffersink.h"
#include "libavutil/log.h"
#include "libavutil/opt.h"
#include "libavutil/mem.h"
int main(int argc,char **argv){if(argc!=2&&argc!=3)return 2;av_log_set_level(AV_LOG_QUIET);AVFilterGraph *g=avfilter_graph_alloc();g->nb_threads=1;AVFilterInOut *ins=NULL,*outs=NULL;AVFilterContext *src=NULL,*sink=NULL;if(avfilter_graph_parse2(g,argv[1],&ins,&outs)<0||!ins||!outs||ins->next||outs->next)return 3;AVFilterContext *scale=ins->filter_ctx;char source_args[256];snprintf(source_args,sizeof(source_args),"video_size=3x2:pix_fmt=8:time_base=1/25:frame_rate=25/1:pixel_aspect=%s",argc==3?argv[2]:"0/1");if(avfilter_graph_create_filter(&src,avfilter_get_by_name("buffer"),"source0",source_args,NULL,g)<0||avfilter_link(src,0,ins->filter_ctx,ins->pad_idx)<0)return 4;if(avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),"sink0",NULL,NULL,g)<0||avfilter_link(outs->filter_ctx,outs->pad_idx,sink,0)<0||avfilter_graph_config(g,NULL)<0)return 5;avfilter_inout_free(&ins);avfilter_inout_free(&outs);int n;if(scanf("%d",&n)!=1||n<0||n>1024)return 6;putchar('[');for(int i=0;i<n;i++){char command[32],expression[4097];if(scanf("%31s %4096s",command,expression)!=2)return 7;int code=avfilter_process_command(scale,command,expression,NULL,0,0);uint8_t *w=NULL,*h=NULL;if(av_opt_get(scale->priv,"w",0,&w)<0||av_opt_get(scale->priv,"h",0,&h)<0)return 8;if(i)putchar(',');printf("{\"code\":%d,\"state\":{\"width\":%d,\"height\":%d,\"widthExpression\":\"%s\",\"heightExpression\":\"%s\"}}",code,scale->outputs[0]->w,scale->outputs[0]->h,w,h);av_free(w);av_free(h);}puts("]");avfilter_graph_free(&g);return 0;}
