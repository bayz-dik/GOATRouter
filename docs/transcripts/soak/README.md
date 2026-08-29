# soak transcripts

`soak.md` is the committed evidence for 9I Task 6, written by
`node --expose-gc scripts/soak-smoke.mjs`. Each run overwrites it.

`--expose-gc` is load-bearing, not optional: without it the heap trend is measured on a raw
sawtooth and the run records the trend UNVERIFIED rather than asserting on an unstable number.

`--long` (2 hours) writes `soak-long.md`, which is not committed from this host — see the report
row explaining why it is UNVERIFIED here.
