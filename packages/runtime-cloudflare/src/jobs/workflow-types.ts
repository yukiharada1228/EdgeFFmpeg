import type {ResourceBudget} from '@edge-ffmpeg/core';
import type {MediaJobArtifact} from './types.js';

export type MediaWorkflowInputSource={readonly kind:'object';readonly key:string;readonly etag:string;readonly version:string;readonly size:number}|{readonly kind:'artifact';readonly nodeId:string;readonly path:string};
export interface MediaWorkflowInput {readonly path:string;readonly source:MediaWorkflowInputSource}
/** A dependency node is a complete command invocation, not codec checkpoint state. */
export interface MediaWorkflowNode {
 readonly id:string;
 readonly args:readonly string[];
 readonly inputs:readonly MediaWorkflowInput[];
 readonly outputs:readonly {readonly path:string}[];
 readonly budget:Readonly<ResourceBudget>;
 readonly implementationVersion:string;
 readonly maxAttempts:number;
 readonly leaseMs:number;
}
export interface MediaWorkflowSpec {
 readonly version:1;
 readonly workflowId:string;
 readonly graphHash:string;
 /** Optional provenance of an automatically partitioned operator graph. */
 readonly sourceGraphHash?:string;
 readonly nodes:readonly MediaWorkflowNode[];
 readonly maxParallel:number;
 readonly pollIntervalMs:number;
 readonly maxPolls:number;
}
export interface MediaWorkflowResult {
 readonly workflowId:string;
 readonly graphHash:string;
 readonly artifacts:Readonly<Record<string,readonly MediaJobArtifact[]>>;
}
