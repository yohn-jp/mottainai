# Artifact bounding benchmark

Issue #7 decision benchmark. It measures the current artifact-bounding
implementation through `InMemoryArtifactStore.putArtifact()`.

## Protocol

- Command: `node --import tsx scripts/benchmark-artifact-bounding.mjs`
- Node: `v22.22.1`
- Input: deterministically generated strings: ASCII, JSON-escaped quotes and
  backslashes, and multibyte UTF-8.
- Input sizes: 100 KiB, 1 MiB, and 10 MiB (UTF-8 byte length).
- `maxBytes`: 64 KiB. Every case exceeds it and therefore forces bounding and
  truncation.
- Warm-up: three 100 KiB runs, two 1 MiB runs, and one 10 MiB run.
- Measurement: 20 runs at 100 KiB, eight at 1 MiB, and three at 10 MiB;
  median duration of one operation measured with `performance.now()`.
- Output: no payload body; each line reports size, shape, input bytes,
  `maxBytes`, iteration count, and median duration.

## Baseline

Before the production optimization, measured on 2026-08-08.

| size    | shape   | input bytes | maxBytes | iterations | median ms/op |
| ------- | ------- | ----------: | -------: | ---------: | -----------: |
| 100 KiB | ascii   |      102400 |    65536 |         20 |        5.366 |
| 100 KiB | escaped |      102400 |    65536 |         20 |        7.283 |
| 100 KiB | utf8    |      102400 |    65536 |         20 |        5.297 |
| 1 MiB   | ascii   |     1048576 |    65536 |          8 |       32.900 |
| 1 MiB   | escaped |     1048576 |    65536 |          8 |       51.862 |
| 1 MiB   | utf8    |     1048576 |    65536 |          8 |       27.801 |
| 10 MiB  | ascii   |    10485760 |    65536 |          3 |      331.070 |
| 10 MiB  | escaped |    10485760 |    65536 |          3 |      564.143 |
| 10 MiB  | utf8    |    10485760 |    65536 |          3 |      277.080 |

The benchmark verifies that every case exceeds `maxBytes`, that the stored
body contains a truncation footer, and that it contains no UTF-8 replacement
character.

## Before/after

The same protocol was rerun after the production optimization.

| size    | shape   | before ms/op | after ms/op | after/before |
| ------- | ------- | -----------: | ----------: | -----------: |
| 100 KiB | ascii   |        5.366 |       5.676 |        1.058 |
| 100 KiB | escaped |        7.283 |       7.323 |        1.005 |
| 100 KiB | utf8    |        5.297 |       4.178 |        0.789 |
| 1 MiB   | ascii   |       32.900 |      29.037 |        0.883 |
| 1 MiB   | escaped |       51.862 |      51.617 |        0.995 |
| 1 MiB   | utf8    |       27.801 |      15.661 |        0.563 |
| 10 MiB  | ascii   |      331.070 |     266.323 |        0.804 |
| 10 MiB  | escaped |      564.143 |     536.894 |        0.952 |
| 10 MiB  | utf8    |      277.080 |     141.554 |        0.511 |

At 10 MiB, ASCII improved by 19.6%, escaped input by 4.8%, and UTF-8 by
48.9%. ASCII at 100 KiB increased by 0.310 ms and escaped input by 0.040 ms,
but every case at 1 MiB or larger was at least as fast, including escaped
input. There is no regression in the important large-input cases.

## Benchmark Decision

### MATERIAL

Bounding a 10 MiB artifact takes 277–564 ms/op. Growth from 100 KiB to
10 MiB is approximately linear, with escaping-heavy input being the slowest.
This is a realistic cost for large Mottainai output and worth measuring for
localized optimization.

The main cost was that every fitting binary-search iteration made a `Buffer`
for the complete candidate in `utf8Prefix`, while `payloadBytes` recalculated
the byte length by applying `JSON.stringify` to the complete candidate
payload.

After optimization, each fit operation reuses the input UTF-8 buffer and
calculates fixed JSON overhead once from an empty-string candidate. Each
candidate's JSON string byte length is still calculated with `JSON.stringify`;
escaping is not approximated. The selected candidate is finally verified with
the existing complete-payload `payloadBytes` calculation.
