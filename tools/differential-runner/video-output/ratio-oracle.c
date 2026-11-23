#include <stdio.h>
#include <limits.h>
#include "libavutil/parseutils.h"
#include "libavutil/log.h"
int main(int argc,char **argv){if(argc!=2)return 2;av_log_set_level(AV_LOG_QUIET);AVRational q={0,0};int ret=av_parse_ratio(&q,argv[1],INT_MAX,0,NULL);printf("{\"accepted\":%s,\"num\":%d,\"den\":%d}\n",ret>=0&&q.num>=0&&q.den>0?"true":"false",q.num,q.den);return 0;}
