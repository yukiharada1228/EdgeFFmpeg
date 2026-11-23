#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "libavutil/eval.h"
#include "libavutil/log.h"
int main(int argc,char **argv){if(argc!=3)return 2;int count=atoi(argv[2]);if(count<0||count>256)return 3;av_log_set_level(AV_LOG_QUIET);AVExpr *expression=NULL;int ret=av_expr_parse(&expression,argv[1],NULL,NULL,NULL,NULL,NULL,0,NULL);if(ret<0)return 4;printf("[");for(int i=0;i<count;i++){double value=av_expr_eval(expression,NULL,NULL);uint64_t bits;memcpy(&bits,&value,sizeof bits);printf("%s{\"nan\":%s,\"bits\":\"%016" PRIx64 "\"}",i?",":"",isnan(value)?"true":"false",bits);}printf("]\n");av_expr_free(expression);return 0;}
