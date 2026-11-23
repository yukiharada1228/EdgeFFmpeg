import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
export interface PullGraphExecution {
 readonly cleanupErrors?:readonly unknown[];
 readonly outputs:readonly AsyncIterable<TimedVideoOutputEvent>[];
 fail(error:unknown):void;
 drain():Promise<void>;
 finish():Promise<void>;
}
