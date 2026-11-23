#include <stdio.h>
#include "libavutil/eval.h"
#include "libavutil/log.h"
int main(int argc,char **argv){if(argc!=2)return 2;av_log_set_level(AV_LOG_QUIET);AVExpr *expression=NULL;int ret=av_expr_parse(&expression,argv[1],NULL,NULL,NULL,NULL,NULL,0,NULL);av_expr_free(expression);printf("{\"accepted\":%s}\n",ret>=0?"true":"false");return 0;}
