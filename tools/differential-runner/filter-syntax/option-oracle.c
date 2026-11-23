#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavutil/opt.h"
#include "libavutil/mem.h"
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    long start = strtol(argv[2], NULL, 10);
    size_t length = strlen(argv[1]);
    if (start < 0 || (size_t)start > length) return 2;
    const char *next = argv[1] + start;
    char *key = NULL, *value = NULL;
    int ret = av_opt_get_key_value(&next, "=", ":",
        atoi(argv[3]) ? AV_OPT_FLAG_IMPLICIT_KEY : 0, &key, &value);
    if (ret < 0) { printf("%d\n", ret); return 0; }
    printf("0\n%td\n%ld\n%zu\n", next - argv[1], key ? (long)strlen(key) : -1L, strlen(value));
    if (key) fwrite(key, 1, strlen(key), stdout);
    fwrite(value, 1, strlen(value), stdout);
    av_free(key); av_free(value);
    return 0;
}
