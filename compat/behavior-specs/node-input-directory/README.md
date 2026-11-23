# Initial directory input behavior

`node tools/differential-runner/node-input-directory/generate.mjs` regenerates
1,932 Native-only cases against the pinned POSIX reference artifacts. The
manifest covers results and provenance; provenance hashes the generator and its
source fixtures. An independent working directory produced identical files.

| Group | Native cases | Conditions |
| --- | ---: | --- |
| Single output | 1,360 | 26 profiles, empty/populated directory, prior output, overwrite flags, xerror; eight raw profiles additionally retain explicit output bitexact cases |
| Complex graph | 360 | Seven graph profiles, each physical input replaced by a directory, overwrite flags, xerror, four output existence masks |
| Termination | 200 | Eight raw profiles, xerror/noxerror ordering, zero frames, zero duration and input/output seek |
| Automatic selection | 12 | Two raw inputs, either directory, automatic/good/bad mapping, xerror |

The default media backend matches all1,932statuses. Exactly1,632cases also
match every output byte and its existence. The remaining300cases retain354
output differences:264cases of Native error-created output versus atomic
preservation/absence,and36late-refusal cases. The original32non-bitexact encoder
metadata caseIDs remain recorded as resolved by complete byte equality with the
reference serialization profile;the original Native corpus has not been reduced.
See `compat/behavior-specs/reference-metadata/README.md` for the broader metadata
matrix and its remaining limits.

The graph matrix additionally runs through all six explicit timed schedulers;
automatic selection has separate six-scheduler checks. These are initial read
and discovery cases. General midstream I/O errors, arbitrary malformed media,
all options, symlinks/ACLs/OS races, other platforms and production Workers are
not certified. R2 prefixes are not POSIX directories. See
`compat/known-differences/node-input-directory.json` for retained differences.
