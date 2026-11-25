# Scoped MP4 input selection and language

The one-input/output MP4 copy path supports ordered positive and negative maps.
A negative map disables every matching earlier mapping, including duplicates;
later positive maps add new entries. Disabled records remain in the plan so that
removing every stream does not trigger automatic selection. A required negative
map without earlier records fails; an optional unused map can leave automatic
selection active. Retained record count is bounded by the indexing budget.

Input IDs use `0:i:<id>` or `0:#<id>`, optionally preceded by `v:` or `a:`.
Decimal, hexadecimal, octal, signs and Native leading C whitespace are supported;
trailing garbage is rejected. The public container API preserves raw unsigned32
track IDs, including zero, while CLI matching uses pinned AVStream signed32
identity. Thus raw0xffffffff can match `i:-1` rather than a positive4294967295.
This follows the pinned implementation; it is not a universal identifier rule.

`Mp4TrackInfo.language` exposes MDHD v0/v1 language metadata. Legacy QuickTime
codes and packed15-bit values follow pinned isom.c. Unknown legacy codes omit the
field. Muxing applies Native defaults/normalization, including32767 for invalid
encodings; old aliases are not silently modernized. Language tokens may contain
unusual characters because the Native decoder accepts them.

Input metadata maps support `0:m:language`, `0:m:language:eng` and optional `v:`/
`a:` constraints. Keys match case-insensitively and values exactly. Single quotes,
backslash escaping and unquoted trailing-space removal follow av_get_token.
For this pinned version, `m:language:und?` treats the question mark as part of the
value; `m:language:und:?` supplies a separate optional remainder.

Evidence includes320negative-map jobs each through Node/R2;1812Node and780R2
ID jobs; all65536 language-code conversions against the pinned C library; and342
language preservation/selection jobs each through Node/R2, including wide MDHD.
Static corpora and reference source are hash-pinned. Native comparisons use the
pinned reference of the platform they run on. The language oracle record and
`language-results.txt` are darwin-arm64 evidence: the oracle must name exactly the
darwin-arm64 pinned libraries. Container-byte identity,
exact diagnostics, output codec ID/metadata specifiers, other metadata keys,
general selector grammar/codecs/formats and production runtime certification are
unfinished. See [MP4 mux scope](mp4-mux.md).
