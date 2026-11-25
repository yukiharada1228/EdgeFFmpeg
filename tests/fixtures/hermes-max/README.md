# hermes-max API notes

Hand-written descriptions of the FLAC helper modules, from an earlier agent run.
The `tests/workers/flac-max-*.test.ts` files read them to check module paths and
exported names. No generator exists and they are not Native evidence, so they are
tracked fixtures rather than generated `.build` inputs. They are byte for byte the
files the bootstrap's former `seeds` step installed into `.build/hermes-max/api/`
(sha256 `d9cc6a29…` filters, `356231d0…` frames, `4578cbcb…` remix, `a16c1178…`
remux, `2347014d…` selection, `dfd835be…` time, `0acb77e6…` trim).
