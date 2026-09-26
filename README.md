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

`reencode` skips re-running ffmpeg on a row whose deterministic output file already exists when `--on-existing skip` is passed (resuming a previous run) — see the `reencode` command below.

No step ever silently drops a row — a file that fails to probe, is skipped for being too small, fails to encode, or doesn't clear the optimization threshold still gets a row in that stage's output CSV explaining what happened, so you can always account for every file that went into `scan`.

All three commands log one line per file to **stdout** as they run (no progress bars), plus a final summary line.

Every command's output CSV is written **progressively** — the header is written immediately, and each row is appended and flushed to disk as soon as that file finishes processing, not buffered up and written all at once at the end. `tail -f video-scan.csv` (or the `reencode`/`finalize` output) while a long batch is running shows rows landing live.

`reencode` additionally prints, after each file it actually re-encodes: how long that encode took, the average throughput (MB of source video processed per second, from the total elapsed time since the run started and the sum of source file sizes gone through so far — including skipped/errored rows, since those still count as "through the batch"), and an ETA to finish the rest (remaining source bytes ÷ that average rate). Reused rows (`--on-existing skip`) don't print these, since no encoding happened for them. In `--sample` mode, all of this — the % comparison and the MB/s & ETA stats — is based on the estimated size of just the sampled slice per file, not the full file (see `--sample` below).

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

| Argument / Flag | Default | Meaning |
|---|---|---|
| `<directory>` | *required* | directory to scan recursively (positional argument) |
| `-o, --output <path>` | `./video-scan.csv` | output CSV path |
| `-c, --concurrency <n>` | `4` | concurrent `ffprobe` processes |

```bash
node dist/cli.js scan ~/Videos --output scan.csv --concurrency 8
```

### `reencode`

Reads a `scan` CSV and re-encodes each probeable file **sequentially** (a single `libx264 -preset slow` encode already uses all available cores, so parallel ffmpeg processes would just contend for the same CPU).

Each file is encoded into a `.tmp` subdirectory of `--output-dir` first, and only moved into `--output-dir` itself once ffmpeg exits successfully — so a crash or an interrupted run never leaves a partial/corrupt file sitting in the final output directory.

**Output filenames are deterministic**: `sha256(absolute source path + profile id)`, truncated to 16 hex characters, e.g. `1d86e01e58d38184.mkv`. The same source file re-encoded with the same profile always produces the same filename — that's what makes resuming a previous run possible (see `--on-existing` below), and it means changing the profile (which bumps `ENCODING_PROFILE.id`, see [The fixed encoding profile](#the-fixed-encoding-profile)) naturally produces a fresh set of filenames rather than colliding with old ones.

| Flag | Default | Meaning |
|---|---|---|
| `-i, --input <path>` | *required* | CSV produced by `scan` |
| `-d, --output-dir <path>` | *required* | directory to write re-encoded `.mkv` files into (created if missing) |
| `-o, --output <path>` | `./reencode-results.csv` | output CSV path |
| `-m, --min-size-bytes <n>` | `0` (disabled) | skip files smaller than this size |
| `--on-existing <warn\|skip>` | `warn` | what to do when a file's deterministic output name already exists in `--output-dir` |
| `--sample <duration>` | *(off)* | only re-encode a sample clip of this length instead of the full file — for quickly previewing compression before committing to a full run |

`--on-existing warn` (the default) logs a warning and overwrites the existing file — this is the safe default when you're not sure whether previous output is still good. `--on-existing skip` treats an existing output file as a completed prior run and reuses it as-is **without re-running ffmpeg** — this is how you resume an interrupted batch: re-run the same `reencode` command with `--on-existing skip` and only the files that never finished (or are new since the last run) actually get encoded. It trusts that an existing file at that deterministic path is genuinely complete and non-corrupted (e.g. from a run that finished normally last time); it does not re-validate the file's contents.

```bash
node dist/cli.js reencode --input scan.csv --output-dir ./encoded --min-size-bytes 10485760
node dist/cli.js reencode --input scan.csv --output-dir ./encoded --on-existing skip   # resume a previous run
node dist/cli.js reencode --input scan.csv --output-dir ./preview --sample 10s         # quick preview pass
```

#### `--sample`: previewing compression before a full run

`--sample <duration>` accepts a plain number of seconds ("10"), a unit-suffixed value ("10s", "1m30s", "1h"), and re-encodes **only that slice** of each file — taken from the **middle** of the video (not the start), to avoid intros/black frames and get a segment more representative of typical content. This makes it fast to sweep an entire library and eyeball which files are worth a full re-encode, without paying the full encode cost for every one.

- **Fair size comparison**: `size_optimization_pct` on a sample row doesn't compare the sample output against the *whole* input file size (which would be a wildly inflated, meaningless "% smaller"). Instead it estimates what that slice of the *original* would have taken up — `video_bit_rate × sample_seconds / 8` (falling back to `overall_bit_rate`, then a plain file-size/duration ratio, if bitrate isn't known) — and compares the real sample output size against that. The MB/s and ETA progress stats are based on this same per-file estimate in `--sample` mode, not full file sizes, since that's the actual amount of work being done per file.
- **Never collides with a full encode**: the output filename hash includes the sample duration, so `--sample 10s` output never overwrites (or gets mistaken for, under `--on-existing skip`) a full-length encode of the same file, and a different `--sample` duration gets its own filename too.
- **`finalize` refuses to act on sample rows** — a row with `sample_seconds` set always gets `finalize_action = skip_sample`, never deleted or promoted. Promoting a few seconds of preview footage into place as if it were the real re-encode would be actively destructive (especially combined with `--move-originals`), so re-run `reencode` on a file without `--sample` before finalizing it.
- **A file shorter than the requested sample gets fully encoded, and is treated as a full encode, not a sample.** If `--sample 10s` is used but a file is only 4 seconds long, the whole file is encoded (there's nothing else to trim to), `size_optimization_pct` is computed from the real output size vs. the real input size (not the bitrate estimate), `sample_seconds` is left **blank** for that row, and `finalize` can promote it normally — it genuinely isn't a partial preview for that file, so it isn't labeled or treated as one.
- **Extrapolated full-file projection**: on a genuine sample row (`sample_seconds` non-blank), three extra columns project the sample's observed compression ratio onto the *whole* file — `extrapolated_reencoded_size_bytes` (estimated full-file output size), `extrapolated_size_optimization_pct` (comes out numerically equal to `size_optimization_pct`, since it's the same ratio just scaled — included so it's there without recomputing it), and `extrapolated_size_optimization_bytes` (estimated bytes saved for the whole file: `file_size_bytes - extrapolated_reencoded_size_bytes`). This assumes the sampled slice is representative of the whole file's compressibility — the same assumption `--sample` is built on. All three are blank for non-sample rows, where the real `size_optimization_pct`/sizes already answer this directly.

**Is 5 seconds enough?** For a fast sanity sweep across a huge library, sure — but for a real go/no-go decision on any individual file, we'd lean toward **10–20 seconds**. A very short clip is more exposed to the encoder's I-frame/lookahead startup behavior and to just being an unrepresentative moment (a static shot vs. a busy action scene), so the ratio it reports can be noisier than what the full file would actually achieve. Since CRF-based encoding (what this profile uses) doesn't do whole-file rate targeting, a mid-video sample is already fairly representative — 10–20s is enough to smooth out that startup noise without costing much more encode time than 5s does.

### `finalize`

Reads a `reencode` CSV and, per row, either deletes the encode (below threshold) or promotes it next to the original file (at/above threshold).

| Flag | Default | Meaning |
|---|---|---|
| `-i, --input <path>` | *required* | CSV produced by `reencode` |
| `-t, --threshold <percent>` | *required* | minimum % size optimization required to keep an encode |
| `--move-originals` | `false` | also move the original file into a sibling `./original_video/` directory |
| `--dry-run` | `false` | print planned actions without touching the filesystem |
| `-o, --output <path>` | `./finalize-results.csv` | output CSV path |
| `--on-existing <ask\|overwrite\|skip>` | `ask` | what to do when a promote/archive destination file already exists |

```bash
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals --dry-run
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals
```

A promoted file is renamed to `<original-basename>.reencoded-<profile-id>-opt<N>pct<encoded-extension>`, e.g.:

```
movie.mp4  ->  movie.reencoded-h264-crf20-slow-yuv420p-v2-opt42pct.mkv
```

**`finalize` is resumable and re-runnable, like `reencode`.** Because the promoted filename and the archived-original path are both fully deterministic (derived from the source path, profile id, and achieved %), re-running `finalize` over the same (or an updated) CSV is safe:

- **Already done, nothing to conflict with** — if the file `finalize` would move (the re-encoded output for a promote, or the original for an archive) no longer exists, but the expected destination already exists, it's treated as already completed by a previous run: a warning is printed (even during `--dry-run`), the row is still recorded with its normal `finalize_action` (`deleted`/`promoted`), and `conflict_resolution` notes `promote:already_done`, `archive:already_done`, or `delete:already_done`.
- **Genuine conflict** — if the file to move *and* something already at the destination *both* exist, `finalize` needs a decision:
  - `--on-existing ask` (the default) prompts interactively, once per conflicting file (`y` overwrites, anything else skips). If stdin isn't an interactive terminal, it logs a warning and defaults to skip rather than hanging. **`--dry-run` never prompts** — it logs what *would* be asked and treats it as skipped for the preview.
  - `--on-existing overwrite` replaces the destination without asking.
  - `--on-existing skip` leaves both files exactly where they are without asking.
- **Neither exists** — if the file `finalize` would move is gone *and* nothing is at the destination either (e.g. the source was deleted or moved by something outside this tool), there's genuinely nothing to do: it's not treated as an error, just noted as `promote:missing_both` / `archive:missing_both` in `conflict_resolution`. For a promote this sets `finalize_action = skip_conflict`; an archive's outcome is tracked separately in `original_archived` and never affects `finalize_action` (see below).

A row left unresolved (a genuine conflict declined or `--on-existing skip`, a dry-run "would ask", or the "neither exists" case above) gets `finalize_action = skip_conflict` — the encoded file, if it still exists, is left in place for you to sort out manually or re-run with a decision.

**Archiving the original with `--move-originals` is independent of whether the promote step actually happened this row.** Even when the promote is left unresolved (`skip_conflict` for any reason above), `finalize` still attempts to archive the original into `./original_video/` — the two files are moved separately, so a conflict on one doesn't block the other. `original_archived` in the CSV always reflects the real outcome of the archive attempt for that row, regardless of `finalize_action`.

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
| `width` | video width, pixels |
| `height` | video height, pixels |
| `frame_rate` | average frame rate, decimal |
| `video_bit_rate` | first video stream's bit rate |
| `bits_per_pixel_per_frame` | `video_bit_rate / (width × height × frame_rate)` — a standard rough gauge of how heavily a video is already compressed relative to its resolution/frame rate; commonly abbreviated "bppf". Very low values (well under ~0.05–0.1 for H.264) suggest a file is already compressed hard and may not shrink much further. Falls back to `overall_bit_rate` when the video stream doesn't report its own bit rate (common for some mp4s) |
| `color_primaries` | color primaries tag, when present |
| `color_transfer` | color transfer characteristic tag, when present |
| `color_space` | color space/matrix tag, when present |
| `rotation` | rotation tag/side-data, degrees (`0` if none) |
| `audio_codec` | first audio stream's codec name |
| `audio_is_pcm` | `true`/`false` — whether the first audio stream is a `pcm_*` codec |
| `audio_sample_rate` | first audio stream's sample rate |
| `audio_channels` | first audio stream's channel count |
| `audio_bit_rate` | first audio stream's bit rate |
| `audio_stream_count` | how many audio streams the file has |
| `subtitle_stream_count` | how many subtitle streams the file has |
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
| `ffmpeg_command` | the `ffmpeg` command for this row, quoted for copy-paste — populated for both a fresh encode and a reused one (see `reencode_action`); blank only for `skip_size`/`skip_scan_error` rows, where no encode was ever attempted |
| `reencode_action` | `reencode` (ffmpeg actually ran this time), `reuse` (output already existed and `--on-existing skip` reused it without running ffmpeg), or blank for `skip_size`/`skip_scan_error` rows |
| `reencode_result` | `ok`, `error`, `skip_size` (below `--min-size-bytes`), or `skip_scan_error` (row was already a scan failure) — a `reuse` row is still `ok`, since the output file is genuinely complete, just not freshly produced this run |
| `reencode_error` | ffmpeg error text, or the passed-through `scan_error` for `skip_scan_error` rows |
| `sample_seconds` | the `--sample` duration used for this run, e.g. `10`; blank if `--sample` wasn't passed (or the file was shorter than the requested sample — see `--sample` above). A non-blank value here means `output_file_path` is a short preview clip, not a full re-encode — `finalize` refuses to act on these rows |
| `extrapolated_reencoded_size_bytes` | on a sample row, the estimated full-file output size if the whole file were re-encoded at the same ratio observed in the sample; blank otherwise |
| `extrapolated_size_optimization_pct` | on a sample row, the same ratio as `size_optimization_pct` (an extrapolation scales both sides equally, so the percentage doesn't change) — provided alongside the absolute figures below; blank otherwise |
| `extrapolated_size_optimization_bytes` | on a sample row, the estimated bytes saved for the whole file (`file_size_bytes - extrapolated_reencoded_size_bytes`); blank otherwise |

### `finalize` output (`finalize-results.csv`)

All `reencode` columns above, plus:

| Column | Meaning |
|---|---|
| `finalize_action` | `deleted`, `promoted`, `skip_not_encoded` (row wasn't `reencode_result = ok`), `skip_conflict` (a destination conflict was left unresolved — see below), `skip_sample` (row is a `--sample` preview, never deleted or promoted), or `error` |
| `conflict_resolution` | blank on the ordinary happy path; otherwise one or more `step:code` tokens joined by `\| `, e.g. `promote:already_done`, `archive:overwritten_flag`. Steps: `delete`, `promote`, `archive`. Codes: `already_done`, `missing_both` (neither the file to move nor the destination exists — nothing to do, not an error), `overwritten_flag`/`overwritten_confirmed`, `skipped_flag`/`skipped_declined`/`skipped_dry_run`, `failed` (archive step only, an unexpected error secondary to a successful promote) |
| `finalize_error` | error text if `finalize_action = error` |
| `original_archived` | `true`/`false` — whether the source file ended up archived (freshly, or already archived from a previous run) for this row |

## Known limitations

- The PCM-vs-copy audio decision and the color-tag passthrough are both based on the **first** audio/video stream only; files with multiple audio streams of mixed codec types are encoded uniformly based on the first one.
- `reencode` maps only video, audio, and subtitle streams (`-map 0:v? -map 0:a? -map 0:s?`) — data/attachment streams some sources embed (e.g. a `tmcd` timecode track written by phones or editing tools) are intentionally dropped, since Matroska can't hold most of them via stream-copy and they carry no playable content anyway.
- Re-encoding into `.mkv` while stream-copying a subtitle codec that Matroska can't hold (e.g. MP4 `mov_text`) will still fail that file with `reencode_result = error` — inspect `reencode_error` and handle such files separately if you hit this.
- `finalize --on-existing ask` prompts one file at a time, in row order, with no "apply to all" shortcut — for a large batch with many conflicts, pass `--on-existing overwrite` or `--on-existing skip` to resolve them all the same way non-interactively instead.
- Neither `--on-existing skip` (in `reencode`) nor `finalize`'s "already done" detection re-validates the existing file's actual contents — they trust that a file sitting at the expected deterministic path is genuinely complete and uncorrupted, e.g. from a run that finished normally.
