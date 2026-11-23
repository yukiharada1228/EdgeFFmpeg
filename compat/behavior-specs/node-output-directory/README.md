# Output directories and significant trailing slash

Regenerate with node tools/differential-runner/node-output-directory/generate.mjs.
26owned profiles*5scenarios*5flags=650Native observations:104refusals0,52EISDIR235,
78missing-directory254,208ENOTDIR236,208overwrite-conflicts234. Existing output
directories refuse defaultEOF/-n before write validation;with-y they fail235
before mux initialization. A regular file with trailing slash is not silently
read or replaced. Missing trailing-slash output does not create a regular file.
Independent cwd regeneration reproduces all4JSON artifacts byte-for-byte.

Actual Node checks every fresh/fixed status/reason and directory/file/staging
preservation. Adapter controls cover late target becoming a directory,earlier
stage abort and root containment through trailing-slash aliases. These checks
do not certify general symlink races,input itself a directory,ACL/ownership/
other errno/full OS/log/descriptor/R2prefix/production behavior.
