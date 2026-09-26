# video-optimizer

A three-stage CLI for shrinking a video library's storage footprint:
**scan** a directory for video files → **reencode** them with one fixed, versioned encoding profile → **finalize** by keeping only the encodes that actually saved enough space.

Every stage is fully auditable: every input row always produces exactly one output row, tagged with a per-stage result column, so the final CSV is a complete trail from source file to final outcome.

## Install / run

```bash
npm install
npm run build      # compiles to dist/
node dist/cli.js <command> ...
```

Or run directly against the TypeScript source during development:

```bash
npx tsx src/cli.ts <command> ...
```

Requires `ffmpeg`/`ffprobe` on `PATH`. This profile was designed against ffmpeg/ffprobe **8.0.1-3ubuntu2**; the `scan` command prints a non-fatal warning if a different version is detected.

## Algorithm overview

```
scan <dir>                       reencode                          finalize
  │  walks dir recursively         │  reads scan CSV                  │  reads reencode CSV
  │  runs ffprobe per file         │  runs ffmpeg per "ok" row         │  per row:
  │  writes video-scan.csv    ───► │  (skips scan errors / too-small   │    below threshold  -> delete encode
  │  (one row per file,            │   files, but records them too)    │    at/above threshold -> move encode
  │   ok or error)                 │  writes reencode-results.csv      │      next to original, suffixed with
  │                                │  (adds output path/size/%,        │      profile id + achieved % savings
  │                                │   ok/error/skip_size/              │    optionally archive original into
  │                                │   skip_scan_error)                 │      ./original_video (sibling dir)
  │                                │                                   │  writes finalize-results.csv
```

No step ever silently drops a row — a file that fails to probe, is skipped for being too small, fails to encode, or doesn't clear the optimization threshold still gets a row in that stage's output CSV explaining what happened, so you can always account for every file that went into `scan`.

All three commands log one line per file to **stdout** as they run (no progress bars), plus a final summary line.

## The fixed encoding profile

Defined once in [`src/profile.ts`](src/profile.ts) as `ENCODING_PROFILE`. Its `id` must change whenever any value below changes — the id is embedded in the `reencode`/`finalize` CSVs and in promoted filenames, so it's how the pipeline tells old encodes apart from new ones.

| Parameter | Value |
|---|---|
| Profile id | `h264-crf20-slow-yuv420p-v2` |
| Video codec | `libx264` |
| Preset | `slow` |
| CRF | `20` |
| Pixel format | `yuv420p` (8-bit, 4:2:0 — fixed regardless of source, for maximum playback compatibility) |
| Container | `mkv` |
| Audio (PCM source) | re-encoded to `aac` @ `256k` |
| Audio (non-PCM source) | stream-copied unchanged (already-compressed audio isn't worth re-encoding for negligible size savings) |
| Subtitles | stream-copied unchanged |
| Metadata / chapters | copied from source (`-map_metadata 0 -map_chapters 0`) |
| Color primaries / transfer / colorspace | explicitly passed through from the source's probed values, when present |
| Resolution / frame rate | preserved from source (no scaling or frame-rate conversion is applied) |

## Commands

### `scan <directory>`

Recursively finds video files (`.mp4 .mkv .mov .avi .wmv .flv .webm .m4v .mpg .mpeg .ts .m2ts .3gp .vob .ogv`) and probes each with `ffprobe`.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <path>` | `./video-scan.csv` | output CSV path |
| `-c, --concurrency <n>` | `4` | concurrent `ffprobe` processes |

```bash
node dist/cli.js scan ~/Videos --output scan.csv --concurrency 8
```

### `reencode`

Reads a `scan` CSV and re-encodes each probeable file **sequentially** (a single `libx264 -preset slow` encode already uses all available cores, so parallel ffmpeg processes would just contend for the same CPU).

| Flag | Default | Meaning |
|---|---|---|
| `-i, --input <path>` | *required* | CSV produced by `scan` |
| `-d, --output-dir <path>` | *required* | directory to write re-encoded `.mkv` files into (created if missing) |
| `-o, --output <path>` | `./reencode-results.csv` | output CSV path |
| `-m, --min-size-bytes <n>` | `0` (disabled) | skip files smaller than this size |

```bash
node dist/cli.js reencode --input scan.csv --output-dir ./encoded --min-size-bytes 10485760
```

### `finalize`

Reads a `reencode` CSV and, per row, either deletes the encode (below threshold) or promotes it next to the original file (at/above threshold).

| Flag | Default | Meaning |
|---|---|---|
| `-i, --input <path>` | *required* | CSV produced by `reencode` |
| `-t, --threshold <percent>` | *required* | minimum % size optimization required to keep an encode |
| `--move-originals` | `false` | also move the original file into a sibling `./original_video/` directory |
| `--dry-run` | `false` | print planned actions without touching the filesystem |
| `-o, --output <path>` | `./finalize-results.csv` | output CSV path |

```bash
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals --dry-run
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals
```

A promoted file is renamed to `<original-basename>.reencoded-<profile-id>-opt<N>pct<encoded-extension>`, e.g.:

```
movie.mp4  ->  movie.reencoded-h264-crf20-slow-yuv420p-v2-opt42pct.mkv
```

## CSV schemas

Each stage's CSV re-emits **every column from its input row** plus its own new columns — the `finalize` CSV alone is a complete audit trail back to the original scan. Because columns accumulate across stages, each stage's own status columns are prefixed with the stage name (`scan_*`, `reencode_*`, `finalize_*`) to avoid ambiguous duplicate headers.

### `scan` output (`video-scan.csv`)

| Column | Meaning |
|---|---|
| `file_path` | absolute path to the source file |
| `file_name` | base filename |
| `file_size_bytes` | source file size |
| `container_format` | ffprobe `format_name` |
| `duration_seconds` | container duration |
| `overall_bit_rate` | container-level bit rate |
| `video_codec` | first video stream's codec name |
| `video_profile` | first video stream's profile (e.g. `High`) |
| `pix_fmt` | first video stream's pixel format |
| `bit_depth` | derived from `pix_fmt` (e.g. `8`, `10`) |
| `chroma_subsampling` | derived from `pix_fmt` (e.g. `4:2:0`) |
| `width` / `height` | video dimensions |
| `frame_rate` | average frame rate, decimal |
| `video_bit_rate` | first video stream's bit rate |
| `color_primaries` / `color_transfer` / `color_space` | color metadata, when present |
| `rotation` | rotation tag/side-data, degrees (`0` if none) |
| `audio_codec` | first audio stream's codec name |
| `audio_is_pcm` | `true`/`false` — whether the first audio stream is a `pcm_*` codec |
| `audio_sample_rate` / `audio_channels` / `audio_bit_rate` | first audio stream's properties |
| `audio_stream_count` / `subtitle_stream_count` | how many audio/subtitle streams the file has |
| `scan_result` | `ok` or `error` |
| `scan_error` | ffprobe error text when `scan_result = error` (metadata columns are blank in that case) |

### `reencode` output (`reencode-results.csv`)

All `scan` columns above, plus:

| Column | Meaning |
|---|---|
| `output_file_path` | path to the re-encoded `.mkv` (blank unless `reencode_result = ok`) |
| `output_file_size_bytes` | re-encoded file size |
| `size_optimization_pct` | `(1 - output_size / input_size) * 100`; can be negative if the encode is larger |
| `profile_id` | `ENCODING_PROFILE.id` used for this encode |
| `reencode_result` | `ok`, `error`, `skip_size` (below `--min-size-bytes`), or `skip_scan_error` (row was already a scan failure) |
| `reencode_error` | ffmpeg error text, or the passed-through `scan_error` for `skip_scan_error` rows |

### `finalize` output (`finalize-results.csv`)

All `reencode` columns above, plus:

| Column | Meaning |
|---|---|
| `finalize_action` | `deleted`, `promoted`, `skip_not_encoded` (row wasn't `reencode_result = ok`), or `error` |
| `finalize_error` | error text if `finalize_action = error` |
| `original_archived` | `true`/`false` — whether `--move-originals` archived the source file for this row |

## Known limitations

- The PCM-vs-copy audio decision and the color-tag passthrough are both based on the **first** audio/video stream only; files with multiple audio streams of mixed codec types are encoded uniformly based on the first one.
- Re-encoding into `.mkv` while stream-copying a subtitle codec that Matroska can't hold (e.g. MP4 `mov_text`) will fail that file with `reencode_result = error` — inspect `reencode_error` and handle such files separately if you hit this.
