# load transcripts

`load.md` is the committed evidence for 9I Task 5, written by `node scripts/load-smoke.mjs`.
Each run overwrites it: the figures are device-specific and a stale one would be worse than none.

`--quick` runs write `load-quick.md`, which is deliberately **not** committed — reduced
concurrency levels are for iteration and must never be cited as the five-level series.
