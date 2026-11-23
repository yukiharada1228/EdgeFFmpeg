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
 AVFilterInOut *input_ports[32];unsigned ninputs=0;for(AVFilterInOut *io=inputs;ret>=0&&io;io=io->next){if(ninputs>=32){ret=-1;break;}input_ports[ninputs++]=io;}if(!ninputs)ret=-1;
 int input_formats[32],input_widths[32],input_heights[32],input_order[32];unsigned parsed=0;char *specs=av_strdup(argv[2]),*spec_state=NULL,*spec=strtok_r(specs,",",&spec_state);
 while(spec&&ret>=0){char name[64],extra;int width,height;if(parsed>=ninputs||sscanf(spec,"%63[^@]@%dx%d%c",name,&width,&height,&extra)!=3||width<1||height<1){ret=-1;break;}input_formats[parsed]=av_get_pix_fmt(name);input_widths[parsed]=width;input_heights[parsed]=height;input_order[parsed]=parsed;if(input_formats[parsed]<0)ret=-1;parsed++;spec=strtok_r(NULL,",",&spec_state);}if(parsed!=ninputs)ret=-1;av_free(specs);
 if(ret>=0&&argc>5){char *mapping=av_strdup(argv[5]),*state=NULL,*value=strtok_r(mapping,",",&state);unsigned count=0;int seen[32]={0};while(value&&ret>=0){char *end=NULL;long index=strtol(value,&end,10);if(count>=ninputs||*end||index<0||index>=ninputs||seen[index]){ret=-1;break;}seen[index]=1;input_order[count++]=index;value=strtok_r(NULL,",",&state);}if(count!=ninputs)ret=-1;av_free(mapping);}
 if(ret>=0&&argc>4&&strlen(argv[4])!=ninputs)ret=-1;
 for(unsigned position=0;ret>=0&&position<ninputs;position++){unsigned index=input_order[position];char args[256],name[32];snprintf(args,sizeof(args),"video_size=%dx%d:pix_fmt=%d:time_base=1/25:pixel_aspect=0/1",input_widths[index],input_heights[index],input_formats[index]);snprintf(name,sizeof(name),"input_%u",index);AVFilterContext *source=NULL;ret=avfilter_graph_create_filter(&source,avfilter_get_by_name("buffer"),name,args,NULL,graph);
  if(ret>=0&&argc>4&&argv[4][index]=='1'){AVFilterContext *trim=NULL;snprintf(name,sizeof(name),"input_trim_%u",index);ret=avfilter_graph_create_filter(&trim,avfilter_get_by_name("trim"),name,"start=0",NULL,graph);if(ret>=0)ret=avfilter_link(source,0,trim,0);source=trim;}else if(argc>4&&argv[4][index]!='0')ret=-1;
  if(ret>=0)ret=avfilter_link(source,0,input_ports[index]->filter_ctx,input_ports[index]->pad_idx);
 }
 AVFilterInOut *ports[32];const char *formats[32];unsigned order[32],nout=0;
 for(AVFilterInOut *io=outputs;ret>=0&&io;io=io->next){if(nout>=32||!target){ret=-1;break;}ports[nout]=io;formats[nout]=target;order[nout]=nout;nout++;target=strtok_r(NULL,",",&save);}if(ret>=0&&target)ret=-1;
 if(ret>=0&&argc>6){char *mapping=av_strdup(argv[6]),*state=NULL,*value=strtok_r(mapping,",",&state);unsigned count=0;int seen[32]={0};while(value&&ret>=0){char *end=NULL;long index=strtol(value,&end,10);if(count>=nout||*end||index<0||index>=nout||seen[index]){ret=-1;break;}seen[index]=1;order[count++]=(unsigned)index;value=strtok_r(NULL,",",&state);}if(count!=nout)ret=-1;av_free(mapping);}
 int widths[32]={0},heights[32]={0};
 if(ret>=0&&argc>7){char *sizes=av_strdup(argv[7]),*state=NULL,*value=strtok_r(sizes,",",&state);unsigned count=0;while(value&&ret>=0){char extra;if(count>=nout){ret=-1;break;}if(strcmp(value,"-")&&(sscanf(value,"%dx%d%c",&widths[count],&heights[count],&extra)!=2||widths[count]<1||heights[count]<1)){ret=-1;break;}count++;value=strtok_r(NULL,",",&state);}if(count!=nout)ret=-1;av_free(sizes);}
 for(unsigned position=0;ret>=0&&position<nout;position++){unsigned index=order[position];AVFilterInOut *io=ports[index];target=(char *)formats[index];AVFilterContext *last=io->filter_ctx,*sink=NULL;unsigned pad=io->pad_idx;char name[32];
  if(widths[index]>0){AVFilterContext *scale=NULL;char args[64];snprintf(args,sizeof(args),"%d:%d",widths[index],heights[index]);snprintf(name,sizeof(name),"output_scale_%u",index);ret=avfilter_graph_create_filter(&scale,avfilter_get_by_name("scale"),name,args,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,scale,0);last=scale;pad=0;}
  if(strcmp(target,"-")){AVFilterContext *format=NULL;snprintf(name,sizeof(name),"output_format_%u",index);ret=avfilter_graph_create_filter(&format,avfilter_get_by_name("format"),name,target,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,format,0);last=format;pad=0;}
  snprintf(name,sizeof(name),"sink_%u",index);if(ret>=0)ret=avfilter_graph_create_filter(&sink,avfilter_get_by_name("buffersink"),name,NULL,NULL,graph);if(ret>=0)ret=avfilter_link(last,pad,sink,0);sinks[index]=sink;nsinks++;
 }
 if(ret>=0)ret=avfilter_graph_config(graph,NULL);
 printf("{\"accepted\":%s",ret>=0?"true":"false");if(ret>=0){printf(",\"nodes\":[");for(unsigned i=0;i<original;i++){AVFilterContext *node=graph->filters[i];if(i)putchar(',');printf("{\"name\":");string(node->filter->name);printf(",\"inputs\":[");for(unsigned pad=0;pad<node->nb_inputs;pad++){if(pad)putchar(',');geometry(node->inputs[pad]);}printf("],\"outputs\":[");for(unsigned pad=0;pad<node->nb_outputs;pad++){if(pad)putchar(',');geometry(node->outputs[pad]);}printf("]}");}printf("],\"sinks\":[");for(unsigned i=0;i<nsinks;i++){if(i)putchar(',');geometry(sinks[i]->inputs[0]);}printf("]");}puts("}");av_free(targets);avfilter_inout_free(&inputs);avfilter_inout_free(&outputs);avfilter_graph_free(&graph);return 0;
}
