# WAV channel-mask serialization

Generate with `node tools/differential-runner/wav-channel-mask/generate.mjs` using the pinned local Native reference. An optional first argument selects an independent output directory for reproducibility checks.

Fourteen finite PCM16 WAVEFORMATEXTENSIBLE inputs cover masks 0x4, 0x20000, 0x3ffff, 0x40000, 0x40001, 0x60000 and 0x80000000, each with zero or four samples. Native stream copy uses default compliance and output `-bitexact`. A canonical mono layout becomes ordinary PCM; high masks retain an extensible header but serialize the mask field as zero. Input layout information must remain intact during demux.

`provenance.json` pins the reference artifacts and relevant upstream/generator sources. `manifest.json` pins both evidence JSON files. Tests compare complete output bytes and bounded output writes, and run all fourteen inputs through independent actual Node launcher processes to compare status, diagnostics and output publication. The behavior applies only to the explicit FFmpeg reference metadata profile; this fixture does not certify strict-compliance overrides, RF64, arbitrary layouts or general WAV compatibility.
