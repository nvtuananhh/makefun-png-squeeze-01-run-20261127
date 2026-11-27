[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/nvtuananhh/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/nvtuananhh/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# Squeeze screenshots into the smallest PNG

A lossless PNG re-encoder for the make.fun bounty
`png-squeeze-01-run-20261127`. One run answers all eight 1280×720 RGBA
screenshots under `/input`, writing pixel-identical PNGs under `/output`.

## How it works

For each screenshot the program:

1. **Decodes** the PNG itself (inflate + unfilter) and analyses the pixels:
   opaque or not, grey or not, at most 256 distinct colours, and whether a
   single fully-transparent value can be keyed with `tRNS`.
2. **Chooses a form**: a palette (colour type 3, ordered by count or by
   luminance, transparent entries first) when the image holds few colours;
   otherwise the smallest channel form that keeps every pixel exact —
   grey (0), grey+alpha (4), RGB (2) or RGBA (6), with a `tRNS` key when
   one transparent value covers all transparent pixels.
3. **Chooses row filters** per row among five candidates — all-None,
   minimum signed sum, fewest distinct byte pairs, and brute force (each
   row's filter is the one whose level-4 deflate, with the previous 32 KiB
   as dictionary, is shortest) — screening each candidate at zlib level 6
   and keeping the smallest file.
4. **Compresses** the filtered bytes with its own optimal-parsing deflate
   encoder: hash-chain longest matches (plus the same column one to four
   rows above, where screenshot rows repeat), two dynamic-programming
   passes (first under fixed Huffman costs, then under the costs the first
   pass implies), adaptive block splitting, and an exact dynamic-vs-fixed
   Huffman choice per block. A node:zlib level-9 encode of the same stream
   is kept as a safety net and the smaller of the two is written.
5. **Verifies** its own output by decoding it and comparing every pixel,
   including the RGB of fully transparent pixels; on any mismatch it falls
   back to a stored (uncompressed) PNG, which is valid by construction.

Everything is pure Node built-ins, no installs, and fully deterministic:
no clock, no environment reads, no randomness — every decision is a
function of the input bytes, so two runs produce byte-identical outputs.

## Practice-set result

Official kit scorer on the practice set: **735,074** total (all 8 answered, all pixel-exact), about 26 s for the whole run on this machine — resubmitted 27/11 after the first entry timed out in dev grading at ~50 s; the runtime was halved to fit the 60 s grade wall.

| instance | bytes | score |
| --- | --- | --- |
| i001 | 11,676 | 758.7 |
| i002 | 49,606 | 732.7 |
| i003 | 99,641 | 717.7 |
| i004 | 102,464 | 715.3 |
| i005 | 15,489 | 780.2 |
| i006 | 174,716 | 704.7 |
| i007 | 59,403 | 717.3 |
| i008 | 23,295 | 754.0 |

## Run

```sh
node main.ts
```

It reads `/input/<id>/image.png` and writes `/output/<id>/image.png`,
creating the output directories. `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` override the paths (used for local testing on the
practice set).
