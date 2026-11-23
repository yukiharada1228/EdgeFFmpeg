#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "libavfilter/avfilter.h"
#include "libavutil/log.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "libavutil/mem.h"
static void string(const char *s){if(!s){printf("null");return;}putchar('"');for(const unsigned char *p=(const unsigned char *)s;*p;p++){if(*p=='"'||*p=='\\')putchar('\\');if(*p<32)printf("\\u%04x",*p);else putchar(*p);}putchar('"');}
static void geometry(AVFilterLink *l){if(!l){printf("null");return;}printf("{\"format\":");string(av_get_pix_fmt_name(l->format));printf(",\"width\":%d,\"height\":%d}",l->w,l->h);}
int main(int argc,char **argv){
 if(argc<4)return 2;av_log_set_level(AV_LOG_QUIET);AVFilterGraph *graph=avfilter_graph_alloc();graph->nb_threads=1;AVFilterInOut *inputs=NULL,*outputs=NULL;int ret=avfilter_graph_parse2(graph,argv[1],&inputs,&outputs);unsigned original=graph->nb_filters;AVFilterContext *sinks[32];unsigned nsinks=0;char *targets=av_strdup(argv[3]),*save=NULL,*target=strtok_r(targets,",",&save);
 if(ret>=0&&(!inputs||inputs->next))ret=-1;
 if(ret>=0){char args[256];snprintf(args,sizeof(args),"video_size=5x3:pix_fmt=%d:time_base=1/25:pixel_aspect=0/1",av_get_pix_fmt(argv[2]));AVFilterContext *source=NULL;ret=avfilter_graph_create_filter(&source,avfilter_get_by_name("buffer"),"input",args,NULL,graph);
  if(ret>=0&&argc>4&&!strcmp(argv[4],"trim")){AVFilterContext *trim=NULL;ret=avfilter_graph_create_filter(&trim,avfilter_get_by_name("trim"),"input_trim","start=0",NULL,graph);if(ret>=0)ret=avfilter_link(source,0,trim,0);source=trim;}
  if(ret>=0)ret=avfilter_link(source,0,inputs->filter_ctx,inputs->pad_idx);
 }
 AVFilterInOut *ports[32];const char *formats[32];unsigned order[32],nout=0;
 for(AVFilterInOut *io=outputs;ret>=0&&io;io=io->next){if(nout>=32||!target){ret=-1;break;}ports[nout]=io;formats[nout]=target;order[nout]=nout;nout++;target=strtok_r(NULL,",",&save);}if(ret>=0&&target)ret=-1;
 if(ret>=0&&argc>5){char *mapping=av_strdup(argv[5]),*state=NULL,*value=strtok_r(mapping,",",&state);unsigned count=0;int seen[32]={0};while(value&&ret>=0){char *end=NULL;long index=strtol(value,&end,10);if(count>=nout||*end||index<0||index>=nout||seen[index]){ret=-1;break;}seen[index]=1;order[count++]=(unsigned)index;value=strtok_r(NULL,",",&state);}if(count!=nout)ret=-1;av_free(mapping);}
 int widths[32]={0},heights[32]={0};
 if(ret>=0&&argc>6){char *sizes=av_strdup(argv[6]),*state=NULL,*value=strtok_r(sizes,",",&state);unsigned count=0;while(value&&ret>=0){char extra;if(count>=nout){ret=-1;break;}if(strcmp(value,"-")&&(sscanf(value,"%dx%d%c",&widths[count],&heights[count],&extra)!=2||widths[count]<1||heights[count]<1)){ret=-1;break;}count++;value=strtok_r(NULL,",",&state);}if(count!=nout)ret=-1;av_free(sizes);}
 for(unsigned position=0;ret>=0&&position<nout;position++){unsigned index=order[position];AVFilterInOut *io=ports[index];target=(char *)formats[index];AVFilterContext *last=io->filter_ctx,*sink=NULL;unsigned pad=io->pad_idx;char name[32];
  if(widths[index]>0){AVFilterContext *scale=NULL;char args[64];snprintf(args,sizeof(args),"%d:%d",widths[index],heights[index]);snprintf(name,sizeof(name),"output_scale_%u",index);ret=avfilter_graph_create_filter(&scale,avfilter_get_by_name("scale"),name,args,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,scale,0);last=scale;pad=0;}
  if(strcmp(target,"-")){AVFilterContext *format=NULL;snprintf(name,sizeof(name),"output_format_%u",index);ret=avfilter_graph_create_filter(&format,avfilter_get_by_name("format"),name,target,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,format,0);last=format;pad=0;}
  snprintf(name,sizeof(name),"sink_%u",index);if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),name,NULL,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,sink,0);sinks[index]=sink;nsinks++;
 }
 if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){printf(",\"nodes\":[");for(unsigned i=0;i<original;i++){AVFilterContext *node=graph->filters[i];if(i)putchar(',');printf("{\"name\":");string(node->filter->name);printf(",\"inputs\":[");for(unsigned pad=0;pad<node->nb_inputs;pad++){if(pad)putchar(',');geometry(node->inputs[pad]);}printf("],\"outputs\":[");for(unsigned pad=0;pad<node->nb_outputs;pad++){if(pad)putchar(',');geometry(node->outputs[pad]);}printf("]}");}printf("],\"sinks\":[");for(unsigned i=0;i<nsinks;i++){if(i)putchar(',');geometry(sinks[i]->inputs[0]);}printf("]");}puts("}");av_free(targets);avfilter_inout_free(&inputs);avfilter_inout_free(&outputs);avfilter_graph_free(&graph);return 0;
}
