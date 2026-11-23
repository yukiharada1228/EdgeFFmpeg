#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include "libavutil/eval.h"
#include "libavutil/log.h"
int main(int argc,char **argv){if(argc!=2)return 2;av_log_set_level(AV_LOG_QUIET);double value=0;int ret=av_expr_parse_and_eval(&value,argv[1],NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL);uint64_t bits;memcpy(&bits,&value,sizeof bits);printf("{\"accepted\":%s,\"bits\":\"%016" PRIx64 "\"}\n",ret>=0?"true":"false",bits);return 0;}
