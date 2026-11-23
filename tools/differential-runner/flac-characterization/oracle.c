/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Development harness including FFmpeg flac_parser.c (Michael Chinen, 2010),
 * pinned by generate.mjs. Upstream COPYING.LGPLv2.1 applies to included code.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/flac_parser.c"
#include "libavformat/avformat.h"
static void fields(FLACFrameInfo *f) {
 printf("\"variable\":%s,\"number\":%lld,\"channels\":%d,\"channelMode\":%d,\"bitsPerSample\":%d,\"sampleRate\":%d,\"blockSamples\":%d",f->is_var_size?"true":"false",(long long)f->frame_or_sample_num,f->channels,f->ch_mode,f->bps,f->samplerate,f->blocksize);
}
typedef struct {uint8_t *b; int n,pos,cap,calls;} Reader;
static int short_read(void *opaque,uint8_t *b,int n){Reader*r=opaque;int take=FFMIN(n,FFMIN(r->cap,r->n-r->pos));printf("{\"read\":%d,\"requested\":%d,\"position\":%d,\"returned\":%d}\n",++r->calls,n,r->pos,take);if(!take)return AVERROR_EOF;memcpy(b,r->b+r->pos,take);r->pos+=take;return take;}
int main(int argc,char **argv){
 if(argc<3)return 2;av_log_set_level(AV_LOG_QUIET);FILE*f=fopen(argv[2],"rb");if(!f)return 3;fseek(f,0,SEEK_END);int n=ftell(f);rewind(f);if(n<0||n>65536)return 4;uint8_t*b=av_mallocz(n+128);fread(b,1,n,f);fclose(f);
 if(!strcmp(argv[1],"header")){GetBitContext gb;FLACFrameInfo fi={0};init_get_bits(&gb,b,n*8);int ret=ff_flac_decode_frame_header(NULL,&gb,&fi,0);printf("{\"return\":%d,\"bitsRead\":%d,\"available\":%d",ret,get_bits_count(&gb),n);if(!ret){printf(",");fields(&fi);printf(",\"headerBytes\":%d,\"candidate\":%s",get_bits_count(&gb)/8,frame_header_is_valid(NULL,b,&fi)?"true":"false");}puts("}");
 }else if(!strcmp(argv[1],"graph")){
 FLACParseContext ctx={0};FLACHeaderMarker nodes[32]={0};int count=0;ctx.fifo_buf=(FifoBuffer){b,b+n,b,b+n,0};
 for(int i=0;i+17<=n;i++){FLACFrameInfo fi;if(b[i]==255&&(b[i+1]&254)==248&&frame_header_is_valid(NULL,b+i,&fi)){if(count==32)return 5;FLACHeaderMarker*p=&nodes[count++];p->offset=i;p->fi=fi;for(int k=0;k<4;k++)p->link_penalty[k]=100000;if(count>1)nodes[count-2].next=p;}}
 ctx.headers=nodes;
 for(int stage=0;stage<6;stage++){if(stage==2&&count){ctx.last_fi=nodes[0].fi;ctx.last_fi_valid=1;}if(stage==3){for(int i=0;i<count;i++){nodes[i].best_child=NULL;for(int k=0;k<4;k++)nodes[i].link_penalty[k]=100000;}}if(stage==4&&count>1)ctx.headers=nodes+1;if(stage==5&&count>2){ctx.headers=nodes;ctx.last_fi_valid=0;for(int i=0;i<count;i++){nodes[i].best_child=NULL;for(int k=0;k<4;k++)nodes[i].link_penalty[k]=100000;}nodes[count-3].next=NULL;score_sequences(&ctx);nodes[count-3].next=&nodes[count-2];}score_sequences(&ctx);printf("{\"stage\":%d,\"headers\":[",stage);for(int i=stage==4?1:0;i<count;i++){FLACHeaderMarker*p=&nodes[i];if(i>(stage==4?1:0))printf(",");printf("{\"offset\":%d,",p->offset);fields(&p->fi);printf(",\"score\":%d,\"best\":%d,\"penalties\":[%d,%d,%d,%d]}",p->max_score,p->best_child?p->best_child->offset:-1,p->link_penalty[0],p->link_penalty[1],p->link_penalty[2],p->link_penalty[3]);}puts("]}");}
 }else if((!strcmp(argv[1],"parser")||!strcmp(argv[1],"direct"))){
 int cap=atoi(argv[3]),flags=atoi(argv[4]),pos=0;AVCodecParserContext*p=av_parser_init(AV_CODEC_ID_FLAC);AVCodecContext*c=avcodec_alloc_context3(NULL);p->flags=flags;c->codec_id=AV_CODEC_ID_FLAC;
 for(int calls=0;calls<2048;calls++){int size=FFMIN(cap,n-pos),outn;uint8_t*out;int direct=!strcmp(argv[1],"direct");int used=direct?flac_parse(p,c,(const uint8_t**)&out,&outn,b+pos,size):av_parser_parse2(p,c,&out,&outn,b+pos,size,123,123,pos);printf("{\"input\":%d,\"position\":%d,\"used\":%d,\"size\":%d,\"duration\":%d,\"pts\":\"%lld\",\"frameOffset\":%lld,\"nextFrameOffset\":%lld,\"currentOffset\":%lld,\"hex\":\"",size,pos,used,outn,p->duration,(long long)p->pts,(long long)p->frame_offset,(long long)p->next_frame_offset,(long long)p->cur_offset);for(int i=0;i<outn;i++)printf("%02x",out[i]);puts("\"}");if((used<0&&!direct)||(!size&&!outn))break;if(!used&&!outn)return 6;pos+=FFMAX(0,used);}
 av_parser_close(p);avcodec_free_context(&c);
 }else if(!strcmp(argv[1],"avio")){
 Reader r={b,n,0,atoi(argv[3]),0};AVFormatContext*fmt=avformat_alloc_context();AVIOContext*io=avio_alloc_context(av_malloc(4096),4096,0,&r,short_read,NULL,NULL);fmt->pb=io;fmt->flags|=AVFMT_FLAG_CUSTOM_IO;int ret=avformat_open_input(&fmt,NULL,NULL,NULL);printf("{\"open\":%d,\"probeScore\":%d}\n",ret,fmt?fmt->probe_score:0);if(ret>=0){AVPacket*p=av_packet_alloc();for(int i=0;i<64;i++){ret=av_read_frame(fmt,p);printf("{\"packetReturn\":%d,\"size\":%d,\"pos\":%lld}\n",ret,p->size,(long long)p->pos);av_packet_unref(p);if(ret<0)break;}av_packet_free(&p);avformat_close_input(&fmt);}av_freep(&io->buffer);avio_context_free(&io);
 }else return 7;av_free(b);return 0;
}
