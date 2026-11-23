# Staged R2 output

R2 output is opt-in. Without `output` configuration, `createR2FileSystem` remains read-only. Example configuration for the existing WAV backend:

```typescript
const filesystem = createR2FileSystem({
  bucket: env.MEDIA_BUCKET,
  mounts: { '/input': 'source/', '/output': 'result/' },
  maxReadBytes: 65536,
  output: {
    writableMounts: ['/output'],
    stagingPrefix: '.edgeffmpeg-staging',
    partBytes: 5 * 1024 * 1024,
    maxWriteBytes: 65536,
    maxOutputBytes: 512 * 1024 * 1024
  }
});
const ffmpeg = new FFmpeg({ filesystem, backend: createWavBackend() });
const result = await ffmpeg.exec(['-n', '-i', '/input/movie.wav', '-c', 'copy', '/output/movie.wav']);
```

Only listed virtual mounts are writable. The staging prefix cannot overlap any mounted object prefix. This prevents the VFS from reading or publishing internal staging objects; applications must also keep that bucket prefix private through their own access policies. No Cloudflare resources or lifecycle policies are created by this library.

## Storage and memory

Each transaction owns a random UUID, a Multipart Upload under the staging prefix and a transaction metadata marker. Writes accumulate in a fixed part buffer, allocated lazily. Full parts are uploaded sequentially with backpressure; the final part may be smaller. The library currently accepts part buffers from 5 to 64 MiB, caps per-write and total output bytes, and caps the part manifest at 10,000 entries. These bounds are not a guarantee that all such output sizes fit a single Worker invocation.

The part buffer is additional to Core buffers, Wasm, packet state and runtime/network overhead. It is not yet charged through ResourceContext. A caller must provision and measure an adequate resident-memory budget. The implementation does not buffer the complete output in memory. Large output finalization streams the completed staging object's known-length body into a final R2 put, incurring an additional full read/write. It does not provide server-side rename.

## Publication and recovery

Commit completes staging, checks its size and marker, and publishes the final object. No-overwrite publication uses an atomic `etagDoesNotMatch: '*'` condition; explicit overwrite omits that condition. A failed condition preserves the existing destination. On success, staging is deleted. Empty outputs are supported. Sequential operations must be awaited; concurrent operations on one handle fail explicitly.

Abort normally cancels the upload or deletes completed staging. It also handles a completion that succeeded before its acknowledgement was lost. General crash recovery, lifecycle cleanup and job-state coordination are not implemented.

If the final put throws, the remote publication may already have happened. `R2CommitUncertainError` retains the key, staging key and transaction ID; abort deliberately preserves staging. `recoverPublishedR2Output(bucket, error)` positively confirms a matching published transaction marker and then deletes matching staging. False means unresolved, not definitely unpublished, and retains staging. Recovery does not retry publication or remove unrelated output.

If publication succeeded but staging deletion failed, `R2OutputCleanupError` reports `published: true` and the same recovery identifiers. Abort never removes a published final output. Recovery can clean staging after confirming the marker. These outcomes survive in FFmpeg.exec's original `error` field. An uncertain result needs application/job reconciliation; it must not be treated as a rolled-back output.

workerd tests cover R2-backed WAV execution, multiple parts (8 MiB), precommit visibility, conditional collision/replacement, empty output, abort, byte limits, read-only mounts, staging completion acknowledgement loss, final publication acknowledgement loss and postpublication cleanup failure. They do not establish production-cloud conformance, persisted checkpoint recovery, checksum verification or random-access output support.

Reference: [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
