# Timed video backend

`createTimedVideoBackend` is an explicit backend for the public `FFmpeg.exec`
frontend. It combines the bounded actor graph, timestamp propagation, frame
synchronization and output publication path. The existing `createMediaBackend`
and `createWavBackend` factories keep their current selection behavior. This
backend is a partial implementation of the detailed design.

```ts
import {FFmpeg} from '@edge-ffmpeg/core';
import {createTimedVideoBackend,createTimedEventCodec} from '@edge-ffmpeg/avformat';
import {createR2FileSystem,createR2SpoolStore} from '@edge-ffmpeg/storage-r2';

const codec=createTimedEventCodec({maxRecordBytes:8192,maxNodes:512,maxErrors:16});
const backend=createTimedVideoBackend({
  storage:()=>createR2SpoolStore(bucket,codec,{
    maxRecordBytes:8192,maxWrittenBytes:262144,
  }),
  limits:{numericProfile:'linux-x64',maxEvents:128},
});
const filesystem=createR2FileSystem(filesystemOptions);
const ffmpeg=new FFmpeg({filesystem,backend,budget});
try {
  const result=await ffmpeg.exec(argv,{signal});
  // Handle exitCode, diagnostics, error and confirmed output paths.
} finally {
  codec.close();
}
```

The application supplies its own bucket, filesystem options, resource budget,
argv and cancellation signal. Choose the explicit numeric profile for the intended
reference target. Core does not launch native FFmpeg or contact a conversion server.
The default scheduler is `producer`; alternate pull/activation/read-frames/queued/
scheduled modes remain available for scoped scheduling investigation. A passing
producer corpus does not prove all scheduler modes equivalent.

`TimedVideoBackendOptions`, `TimedVideoBackendLimits`, `TimedVideoStoreFactory`,
`TimedVideoStore` and `TimedVideoScheduler` describe the public configuration.
Backend construction snapshots its factory and limits. Execution receives the
frontend's budget and signal. Each factory call must return an independent store;
append must snapshot values before resolving, and read must return owned data.
The backend closes input, graph and output stores as their execution finishes.
The caller owns the codec and closes it after every associated operation finishes.

R2 stores use a private execution namespace, bounded record/lifetime written bytes,
owner/index/schema/digest checks and disposal of discarded/unpublished records.
Cancellation after a pending R2 operation is observed when the operation returns;
R2 operations themselves are not abortable through this interface. Cleanup errors
remain observable. Event serialization preserves bigint, typed byte arrays, special
numbers and bounded plain metadata. Error references live in the codec instance:
these ephemeral records cannot recover error identity across an isolate restart.
They are not distributed checkpoints. Record bounds alone do not prove isolate
peak memory compliance. `maxCpuTimeMs` is validated as a budget field, but
actual CPU time is not yet measured/enforced by this graph path; the graph uses
a bounded operator-step counter. Full CPU enforcement remains unfinished.

The CLI path accepts the current finite rawvideo subset and rawvideo/framecrc
outputs. Crop, setsar/setdar, init/frame scale expressions and neighbor/bilinear/area
interpolation extend the existing bounded graph operators. Other formats/codecs,
full negotiation, unrestricted frame geometry/strides, arbitrary FFmpeg options,
complete hardware/device semantics and general graph conformance remain unfinished.
Unsupported requests fail explicitly.

The canonical corpus under `compat/behavior-specs/timed-video-backend/` records
1,134 Native framecrc outputs: fourteen declared eight-bit formats, twenty-seven
crop/aspect/scale/chain configurations and frame limits 0/1/4. It includes persistent
frame expressions, odd chroma cropping, aspect resets/rounding, transpose and three
interpolation kernels. `tools/differential-runner/timed-video-backend/generate.mjs`
regenerates cases with a validated fixed native reference; its manifest hashes the
cases, results, provenance and generator. Node/public backend and local workerd/R2
compare the complete framecrc texts. This is framecrc-output evidence, not a claim
that all raw pixels, geometry or FFmpeg filters are bit exact.

Eleven injected VFS outcomes verify disposal and publication accounting on Node
and local workerd. Confirmed earlier outputs survive a later commit failure;
unknown publication remains `uncertain`, and abort cleanup errors remain visible.
Multi-output publication is not atomic. Read failure/cancellation can place effects
inside an aggregate error's child, preserving both the primary failure and input
cleanup failure. Tests traverse that error graph rather than dropping failures.

Adapted FFmpeg functions retain LGPL-2.1-or-later provenance in avfilter/avformat/
swscale notices and source headers. The complete project license/distribution
audit, production Workers validation, complete resource proofs and distributed
recovery remain outstanding. No full compatibility certification is claimed.

`npm run types:declarations` verifies that package declarations can be emitted
without private node_modules/development paths. Public graph clock, source, step
and registered-link/node types are exported alongside the graph APIs. Declaration
generation is a required foundation and compatibility-report gate; it does not
by itself certify npm packaging or publication.


## Ordinary video CLI path

The same explicit backend accepts `-vf`, `-filter`, `-filter:v`, `-filter:v:0` and
`-filter:0`, including a missing filter (the null path). Last applicable options
win separately for each output. Known nonmatching media/index selectors are
ignored as in the reference; supported simple numeric selector parsing retains
LP64 base-zero conversion, signed32 narrowing and the negative-index sentinel
produced by that narrowing. A literal negative selector remains invalid.
Program, group, metadata and other general stream selectors remain unfinished.

Present numeric input-video maps and automatic selection operate on declared
finite rawvideo inputs. Automatic selection uses the reference's area and packet
presence score with stable input-order ties. Empty inputs therefore do not always
win on area alone. Metadata handles are retained by input index and reused for
packet reads, preserving each handle's generation/fingerprint. Cancellation after
pending metadata acquisition is observed before acquiring subsequent inputs.

Simple graphs may contain internal labels, branches and nullsink when they expose
exactly one input and one output. Topology edges are rebound while preserving raw
filter token text, quote/escape layers and instance names. No identity nodes are
inserted. Multiple mapped streams in one output and unsupported selectors/options
remain explicit unfinished paths.

`compat/behavior-specs/simple-video-cli/` adds 1,369 complete Native framecrc jobs:
596 simple-filter/selection jobs, 17 empty-input/geometry jobs, 36 file/time/option
scope jobs and 720 repeated-PTS deadline jobs. Node and local R2 compare the whole
corpus. Another 42 filter-selector boundaries record 34 successful texts and eight
rejections; rejection checks compare success/failure classification, not exact
Native error codes or diagnostics. The generator validates the fixed build and
source before regenerating expected results. These remain scoped tests, not a
complete CLI compatibility claim.

The shared output limiter closes on an actual frame/run outside the recording
deadline, rather than assuming the next passthrough timestamp must increase.
Equal timestamps at the last permitted tick are retained. Frame-count limits still
close immediately when their actual count is reached.
