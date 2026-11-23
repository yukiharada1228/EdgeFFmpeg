#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <libavcodec/avcodec.h>
#include <libavutil/mem.h>
#include <libavutil/sha.h>
static void digest(const uint8_t *data,int size){
 struct AVSHA*s=av_sha_alloc();uint8_t hash[32];if(!s)exit(6);av_sha_init(s,256);av_sha_update(s,data,size);av_sha_final(s,hash);av_free(s);printf("{\"sha256\":\"");for(int i=0;i<32;i++)printf("%02x",hash[i]);printf("\"}\n");
}
int main(int argc,char **argv){
 if(argc!=4)return 2;
 FILE*f=fopen(argv[1],"rb"); long start=strtol(argv[2],0,10); int cap=atoi(argv[3]);
 if(!f||cap<1||fseek(f,start,SEEK_SET))return 3;
 AVCodecParserContext*p=av_parser_init(AV_CODEC_ID_FLAC);
 AVCodecContext*c=avcodec_alloc_context3(NULL); uint8_t*b=av_mallocz(cap+AV_INPUT_BUFFER_PADDING_SIZE);
 if(!p||!c||!b)return 4;
 c->codec_id=AV_CODEC_ID_FLAC;
 int n,outn,used; uint8_t*out; long pos=start,calls=0,packets=0,consumed=0;
 while((n=fread(b,1,cap,f))>0){int off=0;memset(b+n,0,AV_INPUT_BUFFER_PADDING_SIZE);
  while(off<n){used=av_parser_parse2(p,c,&out,&outn,b+off,n-off,AV_NOPTS_VALUE,AV_NOPTS_VALUE,pos+off);calls++;printf("{\"trace\":true,\"call\":%ld,\"used\":%d,\"size\":%d,\"frameOffset\":%lld,\"nextFrameOffset\":%lld,\"currentOffset\":%lld,\"duration\":%d,\"eof\":%s}\n",calls,used,outn,(long long)p->frame_offset,(long long)p->next_frame_offset,(long long)p->cur_offset,p->duration,"false");
   if(used<0||(!used&&!outn))return 5;
   if(outn){digest(out,outn);packets++;printf("{\"packet\":%ld,\"size\":%d,\"call\":%ld,\"physicalIntake\":%ld,\"frameOffset\":%lld}\n",packets,outn,calls,pos+off,(long long)p->frame_offset);}
   off+=used;consumed+=used;
  }pos+=n;
 }
 for(int i=0;i<32;i++){used=av_parser_parse2(p,c,&out,&outn,b,0,AV_NOPTS_VALUE,AV_NOPTS_VALUE,pos);calls++;printf("{\"trace\":true,\"call\":%ld,\"used\":%d,\"size\":%d,\"frameOffset\":%lld,\"nextFrameOffset\":%lld,\"currentOffset\":%lld,\"duration\":%d,\"eof\":%s}\n",calls,used,outn,(long long)p->frame_offset,(long long)p->next_frame_offset,(long long)p->cur_offset,p->duration,"true");if(!outn)break;digest(out,outn);packets++;printf("{\"packet\":%ld,\"size\":%d,\"eof\":true,\"frameOffset\":%lld}\n",packets,outn,(long long)p->frame_offset);}
 printf("{\"summary\":true,\"chunkBytes\":%d,\"start\":%ld,\"consumed\":%ld,\"calls\":%ld,\"packets\":%ld}\n",cap,start,consumed,calls,packets);
 av_parser_close(p);avcodec_free_context(&c);av_free(b);fclose(f);return 0;
}
