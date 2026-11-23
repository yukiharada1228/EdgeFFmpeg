#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include "libavutil/parseutils.h"
#include "libavutil/eval.h"
#include "libavutil/log.h"
int main(void){av_log_set_level(AV_LOG_QUIET);char expression[1024];int first=1;printf("[");while(fgets(expression,sizeof expression,stdin)){size_t n=strlen(expression);if(n&&expression[n-1]=='\n')expression[--n]=0;AVRational q={0,0};int ret,value_ret;double value=0;if(!strncmp(expression,"@exp2:",6)){ret=-1;value=exp2(strtod(expression+6,NULL));value_ret=isnan(value)?-1:0;}else{ret=av_parse_ratio(&q,expression,INT_MAX,0,NULL);value_ret=av_expr_parse_and_eval(&value,expression,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL);}uint64_t bits;memcpy(&bits,&value,sizeof bits);printf("%s{\"accepted\":%s,\"num\":%d,\"den\":%d,\"valueAccepted\":%s,\"bits\":\"%016" PRIx64 "\"}",first?"":",",ret>=0&&q.num>=0&&q.den>0?"true":"false",q.num,q.den,value_ret>=0?"true":"false",bits);first=0;}puts("]");return 0;}
