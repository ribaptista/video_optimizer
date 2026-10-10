# video-optimizer

A three-stage CLI for shrinking a video library's storage footprint:
**scan** a directory for video files → **reencode** them with one fixed, versioned encoding profile → **validate** their durations → **finalize** by promoting only the encodes that actually saved enough space (never deleting anything — low-gain encodes are simply left in place).

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

## Docker

The repository's [`Dockerfile`](Dockerfile) builds a self-contained image with the CLI and `ffmpeg`/`ffprobe` already installed and pinned — no separate `npm install`/`apt install` step, and no risk of running against an unexpectedly different ffmpeg build than the one the image was tested with. This is the fastest way to get a fully working `video-optimizer`, including `--crop-detect`, without touching the host at all.

```bash
docker build -t video-optimizer .
```

Every command reads and/or writes a video library directory, CSV files, and (for `scan --crop-detect`) a crop-preview directory — all of that needs to persist on the host across separate `docker run` invocations (a `scan` CSV feeding a later `reencode`, a `reencode --output-dir` the next `finalize` promotes files out of, etc.), so bind-mount a directory and point every CLI path at somewhere under it, rather than relying on the container's own filesystem:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v /path/to/your/videos:/data \
  video-optimizer scan /data --output /data/scan.csv --crop-detect --preview-dir /data/previews

docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v /path/to/your/videos:/data \
  video-optimizer reencode --input /data/scan.csv --output-dir /data/encoded --output /data/reencode-results.csv
```

Two things to not skip:

- **`--user "$(id -u):$(id -g)"` is not optional in practice** — the image runs as its own unprivileged user by default, whose uid/gid essentially never matches an arbitrary bind-mounted host directory's ownership, and every write into it (`video-scan.csv`, a re-encoded file, a crop preview JPEG) fails with a permission error otherwise.
- **Always pass `-o`/`--output` explicitly, pointing somewhere under `/data`.** Every command's output CSV path defaults to a relative `./*.csv`, which in the container resolves against the image's own `WORKDIR /app`, not your bind mount — a default-output run under `--user` fails with `EACCES` (`/app` is owned by the image's baked-in uid, not yours), or (without `--user`) silently writes a CSV that's discarded when the container exits.

The image's `ENTRYPOINT` is the CLI itself, so any subcommand works the same way — e.g. `... video-optimizer validate --input /data/reencode-results.csv` — and running the image with no arguments at all prints `--help`.

The `Dockerfile` pins its base image by content digest and `ffmpeg` by exact Debian package version; see the comments at the top of the file for exactly how those were chosen and how to update them later. One deliberate gap: the pinned Debian package (`7.1.5`) is a different, still-maintained build than the `8.0.1-3ubuntu2` this project's encoding profile was developed against (see above), so every `scan` run in the image prints that version-mismatch warning — expected and harmless, not a sign the Docker pin is wrong (Debian's current stable release doesn't carry 8.0.1 at all).

### Multi-platform (arm64)

The image builds and runs correctly on `linux/arm64` (Apple Silicon, Raspberry Pi, AWS Graviton, etc.), not just `linux/amd64` — confirmed directly: built the actual `Dockerfile` under `docker buildx` with QEMU emulation and ran `scan --crop-detect` and `reencode` against real fixture videos through the resulting image, bind-mounted the same way as the amd64 examples above. Everything the image depends on already publishes arm64 builds: the pinned `node:22-trixie-slim` base is a multi-arch manifest list including `linux/arm64/v8`, and Debian trixie's archive carries the exact same pinned `ffmpeg` package version for `arm64` as for `amd64`. Nothing in `package.json` is a native addon, so there's no prebuilt-binary risk on arm64 the way there would be for something like `better-sqlite3`.

On a machine that's natively arm64 (e.g. Apple Silicon), the plain `docker build` command above already produces a native arm64 image — no extra flags needed. Cross-building arm64 from an amd64 host (or vice versa) needs `docker buildx` plus QEMU emulation registered once per host:

```bash
docker run --rm --privileged tonistiigi/binfmt --install all   # one-time, registers QEMU for all archs
docker buildx create --use                                      # one-time, a build-capable builder

docker buildx build --platform linux/arm64 -t video-optimizer --load .
```

`--load` pulls the built image into the local `docker images` list (as `docker build` does implicitly); omit it (and add `--push`) when building for a registry instead. Emulated cross-builds are meaningfully slower than a native build on that architecture — expect several extra minutes on the `apt-get install` step alone — but produce a working arm64 image either way. To publish one image tag that resolves to the right architecture on either host, build and push a real multi-platform manifest instead of `--load`ing a single arch:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/video-optimizer:latest --push .
```

## Releasing

Pushing a `v*` tag publishes a multi-arch (`linux/amd64` + `linux/arm64`) Docker image to GHCR,
Docker Hub, and ECR Public. Implemented by
[`.github/workflows/release.yml`](.github/workflows/release.yml), which reuses
[`.github/workflows/verify.yml`](.github/workflows/verify.yml) as its gate;
[`.github/workflows/docker-canary.yml`](.github/workflows/docker-canary.yml) is a separate,
unrelated-to-releasing safety net (see "apt pins going stale" below).

### Cutting a release

```bash
npm version minor       # 0.1.0 -> 0.2.0: bumps package.json + package-lock.json, commits, tags v0.2.0
git push --follow-tags  # pushes master AND the tag -> triggers release.yml
```

For a prerelease, `npm version prerelease --preid rc` instead, which produces `v0.2.0-rc.0`. That
tag is still published to every registry, but without the `:latest` tag, and the GitHub Release it
creates is marked as a prerelease.

**`npm version <bump>` is the only supported way to cut a release.** It is what keeps
`package.json`'s `version` and the git tag from ever disagreeing, and `check-version` (the first job
in `release.yml`) enforces that invariant directly: it fails the entire run before anything is built
if `v<package.json version>` doesn't match the tag that was actually pushed. A bare `git tag v9.9.9`
(not produced by `npm version`) is refused the same way. There is no manual "create a release" step
on the repository's web page at any point — the GitHub Release itself is created by the workflow's
own last job, and only after every image has actually landed in every registry, so a release page
can never point at an image that failed to publish.

### Jobs (`release.yml`)

1. **check-version** — the invariant above.
2. **verify** — calls `verify.yml` (the same reusable workflow a pull request runs) as a reusable
   workflow. A release must never publish an image that hasn't passed the exact same checks a PR has
   to pass.
3. **build** — a matrix of `{linux/amd64 on ubuntu-24.04}` / `{linux/arm64 on ubuntu-24.04-arm}`,
   each a native runner (no QEMU emulation). Each pushes its single-platform image **to GHCR only**,
   by digest (`push-by-digest=true`, no tag at this stage at all), and uploads that digest as a build
   artifact.
4. **merge** — downloads both digests, then runs one `docker buildx imagetools create` that
   assembles them into a single multi-arch manifest list and pushes it, under every real tag this
   release gets, to **all three** registries. The per-arch `build` job only ever touches GHCR; tags
   are only ever applied here, once both architectures already exist — so there's never a window
   where a tag points at a single-platform image.
5. **release** — `gh release create --verify-tag`, only after `merge` has succeeded. Adds
   `--prerelease` for a prerelease version, `--latest` otherwise. Never creates the tag itself
   (`--verify-tag` refuses to run if the tag isn't already there) and never runs before the images
   are confirmed live.

### Tag scheme

Given a version `X.Y.Z`, every registry gets `:X.Y.Z` and `:X.Y`. A bare `:X` is added too, but only
once `X > 0` — `:0` would read as meaningless (or actively misleading) for a pre-1.0 package.
`:latest` is added only when the version carries no prerelease suffix, so a bare `docker pull
<image>` can never resolve to an `-rc`/`-beta` build.

### One-time setup (per registry)

None of this is automated — it's done once, by hand, before the first real release.

**Docker Hub** — create the `video-optimizer` repository, and an access token with read/write
scope. Store:

- Repo secret `DOCKERHUB_USERNAME`
- Repo secret `DOCKERHUB_TOKEN` (the access token, not your account password)
- Repo variable `DOCKERHUB_REPO` — the full `<your-dockerhub-username>/video-optimizer` path

**ECR Public** (console/CLI calls below all target `us-east-1`):

```bash
aws ecr-public create-repository --repository-name video-optimizer --region us-east-1
```

Note the registry alias this prints — store it as repo variable `ECR_PUBLIC_ALIAS`. Then, one-time
IAM setup for OIDC:

1. Add an IAM OIDC identity provider for `token.actions.githubusercontent.com` (audience
   `sts.amazonaws.com`), if this AWS account doesn't already have one from another repo.
2. Create an IAM role whose trust policy's `sub` condition is
   `repo:<owner>/video_optimizer:ref:refs/tags/v*` — scoped to tag pushes only, so nothing else in
   this repository's CI can assume it.
3. Grant that role: `ecr-public:GetAuthorizationToken`, `sts:GetServiceBearerToken` (both
   account-wide, ECR Public has no per-repository ARN for these two), and
   `ecr-public:BatchCheckLayerAvailability`, `ecr-public:InitiateLayerUpload`,
   `ecr-public:UploadLayerPart`, `ecr-public:CompleteLayerUpload`, `ecr-public:PutImage` scoped to
   the `video-optimizer` repository's own ARN.
4. Store the role's ARN as repo variable `AWS_ROLE_ARN`.

**GHCR** — nothing to configure beforehand; `release.yml` authenticates with the workflow's own
`GITHUB_TOKEN`. After the very first push, GHCR packages start **private** by default — go to the
package's own settings once and set it to public, and link it to this repository (so it shows up on
the repo's sidebar).

### Known sharp edge: apt pins going stale

The `Dockerfile` pins an exact Debian apt package version for `ffmpeg` (see its own header comment
for the full rationale) — intentional, so a stale pin fails the build loudly instead of silently
drifting. The cost is that a routine Debian trixie security update can break `docker build` with no
release anywhere near it — the first sign would otherwise be a release failing in the `build` job,
mid-release.

**`docker-canary.yml`** runs the same build (amd64 only, no push) every Monday and on manual
dispatch, purely to catch that early. On failure, it opens (or comments on an already-open) issue
titled "Dockerfile apt pins stale", linking the failed run.

**Fix procedure**, once that issue appears:

1. `./scripts/print-apt-pins.sh` — prints the current `apt-cache policy` candidate version for
   `ffmpeg` inside the exact pinned base image (`ARG NODE_IMAGE` in the `Dockerfile`).
2. Bump `ARG FFMPEG_VERSION` in the `Dockerfile` to match.
3. Validate the image itself — build it: `docker build .` (its own `RUN` step already asserts that
   `ffmpeg`/`ffprobe` run), plus a real smoke run — `docker run --rm <image> --help`, and ideally
   `scan`/`reencode` against a small fixture video.
4. Open a PR with the bump (runs `verify.yml` as usual), merge it, then cut a **new** patch release
   (`npm version patch`). Never move, delete, or re-push the tag that failed — it correctly points at
   a commit whose pin was stale; the fix belongs in a new commit and a new tag.

## Algorithm overview

```
scan <dir>                       reencode                          finalize
  │  walks dir recursively         │  reads scan CSV                  │  reads reencode CSV
  │  runs ffprobe per file         │  runs ffmpeg per "ok" row         │  per row:
  │  writes video-scan.csv    ───► │  (skips scan errors / too-small   │    below threshold  -> skip (left as-is)
  │  (one row per file,            │   files, but records them too)    │    at/above threshold -> move encode
  │   ok or error)                 │  writes reencode-results.csv      │      next to original, suffixed with
  │                                │  (adds output path/size/%,        │      profile id + achieved % savings
  │                                │   ok/error/skip_size/              │    optionally archive original into
  │                                │   skip_scan_error)                 │      ./original_video (sibling dir)
  │                                │                                   │  writes finalize-results.csv (never deletes)
```

`reencode` skips re-running ffmpeg on a row whose deterministic output file already exists when `--on-existing skip` is passed (resuming a previous run) — see the `reencode` command below.

No step ever silently drops a row — a file that fails to probe, is skipped for being too small, fails to encode, or doesn't clear the optimization threshold still gets a row in that stage's output CSV explaining what happened, so you can always account for every file that went into `scan`.

All four commands log one line per file to **stdout** as they run (no progress bars), plus a final summary line.

Every command's output CSV is written **progressively** — the header is written immediately, and each row is appended and flushed to disk as soon as that file finishes processing, not buffered up and written all at once at the end. `tail -f video-scan.csv` (or the `reencode`/`finalize` output) while a long batch is running shows rows landing live.

`reencode` additionally prints, after each file it actually re-encodes: how long that encode took, the average throughput (MB of source video processed per second, from the total elapsed time since the run started and the sum of source file sizes gone through so far — including skipped/errored rows, since those still count as "through the batch"), and an ETA to finish the rest (remaining source bytes ÷ that average rate). Reused rows (`--on-existing skip`) don't print these, since no encoding happened for them. In `--sample` mode, all of this — the % comparison and the MB/s & ETA stats — is based on the estimated size of just the sampled slice per file, not the full file (see `--sample` below).

## The fixed encoding profile

Defined once in [`src/profile.ts`](src/profile.ts) as `ENCODING_PROFILE`. Its `id` must change whenever any value below changes — the id is embedded in the `reencode`/`finalize` CSVs and in promoted filenames, so it's how the pipeline tells old encodes apart from new ones.

| Parameter                               | Value                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Profile id                              | `h264-crf20-slow-yuv420p-v2`                                                                           |
| Video codec                             | `libx264`                                                                                              |
| Preset                                  | `slow`                                                                                                 |
| CRF                                     | `20`                                                                                                   |
| Pixel format                            | `yuv420p` (8-bit, 4:2:0 — fixed regardless of source, for maximum playback compatibility)              |
| Container                               | `mkv`                                                                                                  |
| Audio (PCM source)                      | re-encoded to `aac` @ `256k`                                                                           |
| Audio (non-PCM source)                  | stream-copied unchanged (already-compressed audio isn't worth re-encoding for negligible size savings) |
| Subtitles                               | stream-copied unchanged                                                                                |
| Metadata / chapters                     | copied from source (`-map_metadata 0 -map_chapters 0`)                                                 |
| Color primaries / transfer / colorspace | explicitly passed through from the source's probed values, when present                                |
| Resolution / frame rate                 | preserved from source (no scaling or frame-rate conversion is applied)                                 |

## Commands

### `scan <directory>`

Recursively finds video files (`.mp4 .mkv .mov .avi .wmv .flv .webm .m4v .mpg .mpeg .ts .m2ts .3gp .vob .ogv`) and probes each with `ffprobe`.

| Argument / Flag         | Default            | Meaning                                             |
| ----------------------- | ------------------ | --------------------------------------------------- |
| `<directory>`           | _required_         | directory to scan recursively (positional argument) |
| `-o, --output <path>`   | `./video-scan.csv` | output CSV path                                     |
| `-c, --concurrency <n>` | `4`                | concurrent `ffprobe` processes                      |

```bash
node dist/cli.js scan ~/Videos --output scan.csv --concurrency 8
```

#### `--crop-detect`: detecting letterbox/pillarbox crop areas

Passing `--crop-detect` runs ffmpeg's `cropdetect` filter against each file (at a few sample points through its duration) to find the real picture area inside any black letterbox/pillarbox bars, records the result in the CSV, and writes a preview JPEG with the chosen area boxed in green so it can be eyeballed before trusting it. `reencode` then crops to this area automatically (see below) — `scan` itself never modifies anything.

| Flag                                    | Default           | Meaning                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--crop-detect`                         | _(off)_           | enable crop detection; every other `--crop-*`/`--preview-dir` flag requires this to be set                                                                                                                                                                                                                                       |
| `--crop-ignore <top,right,bottom,left>` | `0,0,0,0`         | pixels to pre-crop from each edge **before** running cropdetect, then stretched back out afterward if that edge turns out to have no real padding (see below) — use this to blind cropdetect to a burned-in overlay or timestamp sitting near an edge, which would otherwise make cropdetect think that edge has no bars to crop |
| `--crop-single-axis`                    | _(off)_           | if the detected area crops on both axes (both letterboxed and pillarboxed), keep only the crop on the dominant axis and restore the other axis to the full frame                                                                                                                                                                 |
| `--crop-max-ratio <n>`                  | `0` (disabled)    | if the resulting area's long/short side ratio exceeds this, grow the short side back out (symmetrically, clamped to the frame) until it meets it — e.g. `1.7778` stops a crop from ever going tighter than 16:9                                                                                                                  |
| `--crop-limit <n>`                      | `16`              | forwarded to ffmpeg's `cropdetect=limit=` (black-level threshold)                                                                                                                                                                                                                                                                |
| `--crop-round <n>`                      | `2`               | forwarded to ffmpeg's `cropdetect=round=`; also the tolerance (in pixels) below which a detected edge is treated as "no padding" when deciding whether to stretch back to that edge                                                                                                                                              |
| `--crop-frames <n>`                     | `16`              | frames sampled by cropdetect at each sample point (`-frames:v`)                                                                                                                                                                                                                                                                  |
| `--crop-samples <list>`                 | `0.25,0.5,0.75`   | comma-separated fractions (each in `[0,1)`) of the video's duration to sample; the final area is the union of what's detected at each point, so a region that's only non-black in one sample is still kept                                                                                                                       |
| `--preview-dir <path>`                  | `./crop-previews` | directory the crop-preview JPEGs are written into                                                                                                                                                                                                                                                                                |

**How the final area is computed, in order:** detect at each `--crop-samples` point (within the `--crop-ignore` margins, if any) → union the per-sample results → stretch any edge with no real padding back out to the true frame edge (absorbing its ignore margin) → apply `--crop-single-axis`, if set → apply `--crop-max-ratio`, if set → round to even `x`/`y`/`w`/`h` (required for `yuv420p`).

```bash
node dist/cli.js scan ~/Videos --crop-detect
node dist/cli.js scan ~/Videos --crop-detect --crop-ignore 0,0,40,100   # ignore a bottom-left timestamp overlay
node dist/cli.js scan ~/Videos --crop-detect --crop-max-ratio 1.7778 --preview-dir ./previews
```

### `reencode`

Reads a `scan` CSV and re-encodes each probeable file **sequentially** (a single `libx264 -preset slow` encode already uses all available cores, so parallel ffmpeg processes would just contend for the same CPU).

Each file is encoded into a `.tmp` subdirectory of `--output-dir` first, and only moved into `--output-dir` itself once ffmpeg exits successfully — so a crash or an interrupted run never leaves a partial/corrupt file sitting in the final output directory.

**Output filenames are deterministic**: `sha256(absolute source path + profile id)`, truncated to 16 hex characters, e.g. `1d86e01e58d38184.mkv`. The same source file re-encoded with the same profile always produces the same filename — that's what makes resuming a previous run possible (see `--on-existing` below), and it means changing the profile (which bumps `ENCODING_PROFILE.id`, see [The fixed encoding profile](#the-fixed-encoding-profile)) naturally produces a fresh set of filenames rather than colliding with old ones.

**If the input row has a `crop_rect`** (from `scan --crop-detect`, see above) that actually crops something — i.e. it isn't blank and isn't the full frame — the crop is applied during the encode via `-vf crop=w:h:x:y`, and the crop area is folded into the output filename hash too, so a cropped encode never collides with (or gets mistaken for, under `--on-existing skip`) an uncropped encode of the same file. A blank or full-frame `crop_rect` — including CSVs from before this feature existed — is treated as no crop at all, with no change to the filename hash.

| Flag                         | Default                  | Meaning                                                                                                                                   |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <path>`         | _required_               | CSV produced by `scan`                                                                                                                    |
| `-d, --output-dir <path>`    | _required_               | directory to write re-encoded `.mkv` files into (created if missing)                                                                      |
| `-o, --output <path>`        | `./reencode-results.csv` | output CSV path                                                                                                                           |
| `-m, --min-size-bytes <n>`   | `0` (disabled)           | skip files smaller than this size                                                                                                         |
| `--on-existing <warn\|skip>` | `warn`                   | what to do when a file's deterministic output name already exists in `--output-dir`                                                       |
| `--sample <duration>`        | _(off)_                  | only re-encode a sample clip of this length instead of the full file — for quickly previewing compression before committing to a full run |

`--on-existing warn` (the default) logs a warning and overwrites the existing file — this is the safe default when you're not sure whether previous output is still good. `--on-existing skip` treats an existing output file as a completed prior run and reuses it as-is **without re-running ffmpeg** — this is how you resume an interrupted batch: re-run the same `reencode` command with `--on-existing skip` and only the files that never finished (or are new since the last run) actually get encoded. It trusts that an existing file at that deterministic path is genuinely complete and non-corrupted (e.g. from a run that finished normally last time); it does not re-validate the file's contents.

```bash
node dist/cli.js reencode --input scan.csv --output-dir ./encoded --min-size-bytes 10485760
node dist/cli.js reencode --input scan.csv --output-dir ./encoded --on-existing skip   # resume a previous run
node dist/cli.js reencode --input scan.csv --output-dir ./preview --sample 10s         # quick preview pass
```

#### `--sample`: previewing compression before a full run

`--sample <duration>` accepts a plain number of seconds ("10"), a unit-suffixed value ("10s", "1m30s", "1h"), and re-encodes **only that slice** of each file — taken from the **middle** of the video (not the start), to avoid intros/black frames and get a segment more representative of typical content. This makes it fast to sweep an entire library and eyeball which files are worth a full re-encode, without paying the full encode cost for every one.

- **Fair size comparison**: `size_optimization_pct` on a sample row doesn't compare the sample output against the _whole_ input file size (which would be a wildly inflated, meaningless "% smaller"). Instead it estimates what that slice of the _original_ would have taken up — `video_bit_rate × sample_seconds / 8` (falling back to `overall_bit_rate`, then a plain file-size/duration ratio, if bitrate isn't known) — and compares the real sample output size against that. The MB/s and ETA progress stats are based on this same per-file estimate in `--sample` mode, not full file sizes, since that's the actual amount of work being done per file.
- **Never collides with a full encode**: the output filename hash includes the sample duration, so `--sample 10s` output never overwrites (or gets mistaken for, under `--on-existing skip`) a full-length encode of the same file, and a different `--sample` duration gets its own filename too.
- **`finalize` refuses to act on sample rows** — a row with `sample_seconds` set always gets `finalize_action = skip_sample`, never promoted. Promoting a few seconds of preview footage into place as if it were the real re-encode would be actively destructive (especially combined with `--move-originals`), so re-run `reencode` on a file without `--sample` before finalizing it.
- **A file shorter than the requested sample gets fully encoded, and is treated as a full encode, not a sample.** If `--sample 10s` is used but a file is only 4 seconds long, the whole file is encoded (there's nothing else to trim to), `size_optimization_pct` is computed from the real output size vs. the real input size (not the bitrate estimate), `sample_seconds` is left **blank** for that row, and `finalize` can promote it normally — it genuinely isn't a partial preview for that file, so it isn't labeled or treated as one.
- **Extrapolated full-file projection**: on a genuine sample row (`sample_seconds` non-blank), three extra columns project the sample's observed compression ratio onto the _whole_ file — `extrapolated_reencoded_size_bytes` (estimated full-file output size), `extrapolated_size_optimization_pct` (comes out numerically equal to `size_optimization_pct`, since it's the same ratio just scaled — included so it's there without recomputing it), and `extrapolated_size_optimization_bytes` (estimated bytes saved for the whole file: `file_size_bytes - extrapolated_reencoded_size_bytes`). This assumes the sampled slice is representative of the whole file's compressibility — the same assumption `--sample` is built on. All three are blank for non-sample rows, where the real `size_optimization_pct`/sizes already answer this directly.

**Is 5 seconds enough?** For a fast sanity sweep across a huge library, sure — but for a real go/no-go decision on any individual file, we'd lean toward **10–20 seconds**. A very short clip is more exposed to the encoder's I-frame/lookahead startup behavior and to just being an unrepresentative moment (a static shot vs. a busy action scene), so the ratio it reports can be noisier than what the full file would actually achieve. Since CRF-based encoding (what this profile uses) doesn't do whole-file rate targeting, a mid-video sample is already fairly representative — 10–20s is enough to smooth out that startup noise without costing much more encode time than 5s does.

### `validate`

Reads a `reencode` CSV and uses `ffprobe` to compare the source and output duration for every `reencode_result = ok` row. It prints the source duration, output duration, and signed difference for each row. A row is reported as an error when its absolute difference exceeds the configured limit; after the complete report and summary, the command exits unsuccessfully when there are mismatches or probe failures. Rows that were not successfully re-encoded are reported but not probed.

| Flag                               | Default    | Meaning                                                               |
| ---------------------------------- | ---------- | --------------------------------------------------------------------- |
| `-i, --input <path>`               | _required_ | CSV produced by `reencode`                                            |
| `-t, --max-difference-seconds <n>` | `1`        | maximum allowed absolute source/output duration difference in seconds |

```bash
node dist/cli.js validate --input reencode-results.csv
node dist/cli.js validate --input reencode-results.csv --max-difference-seconds 0.25
```

### `finalize`

Reads a `reencode` CSV and, per row, either promotes the encode next to the original file (at/above threshold) or leaves it exactly where it is (below threshold, or filtered out by `--min-size-bytes`). **`finalize` never deletes anything** — a low-gain encode is simply skipped and left sitting in the `reencode` output directory for you to review or clean up manually.

| Flag                                   | Default                  | Meaning                                                                                                          |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `-i, --input <path>`                   | _required_               | CSV produced by `reencode`                                                                                       |
| `-t, --threshold <percent>`            | _required_               | minimum % size optimization required to promote an encode; below this it's skipped (left untouched), not deleted |
| `-m, --min-size-bytes <n>`             | `0` (disabled)           | skip (leave untouched) rows whose **original** source file — not the encode — is smaller than this size          |
| `--move-originals`                     | `false`                  | also move the original file into a sibling `./original_video/` directory                                         |
| `--dry-run`                            | `false`                  | print planned actions without touching the filesystem                                                            |
| `-o, --output <path>`                  | `./finalize-results.csv` | output CSV path                                                                                                  |
| `--on-existing <ask\|overwrite\|skip>` | `ask`                    | what to do when a promote/archive destination file already exists                                                |

```bash
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals --dry-run
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --move-originals
node dist/cli.js finalize --input reencode-results.csv --threshold 20 --min-size-bytes 10485760   # skip tiny originals too
```

A promoted file is renamed to `<original-basename>.reencoded-<profile-id>-opt<N>pct<encoded-extension>`, e.g.:

```
movie.mp4  ->  movie.reencoded-h264-crf20-slow-yuv420p-v2-opt42pct.mkv
```

**`finalize` is resumable and re-runnable, like `reencode`.** Because the promoted filename and the archived-original path are both fully deterministic (derived from the source path, profile id, and achieved %), re-running `finalize` over the same (or an updated) CSV is safe:

- **Already done, nothing to conflict with** — if the re-encoded output for a promote (or the original for an archive) no longer exists, but the expected destination already exists, it's treated as already completed by a previous run: a warning is printed (even during `--dry-run`), the row is still recorded with `finalize_action = promoted`, and `conflict_resolution` notes `promote:already_done` and/or `archive:already_done`.
- **Genuine conflict** — if the file to move _and_ something already at the destination _both_ exist, `finalize` needs a decision:
  - `--on-existing ask` (the default) prompts interactively, once per conflicting file (`y` overwrites, anything else skips). If stdin isn't an interactive terminal, it logs a warning and defaults to skip rather than hanging. **`--dry-run` never prompts** — it logs what _would_ be asked and treats it as skipped for the preview.
  - `--on-existing overwrite` replaces the destination without asking.
  - `--on-existing skip` leaves both files exactly where they are without asking.
- **Neither exists** — if the file `finalize` would move is gone _and_ nothing is at the destination either (e.g. the source was deleted or moved by something outside this tool), there's genuinely nothing to do: it's not treated as an error, just noted as `promote:missing_both` / `archive:missing_both` in `conflict_resolution`. For a promote this sets `finalize_action = skip_conflict`; an archive's outcome is tracked separately in `original_archived` and never affects `finalize_action` (see below).

A row left unresolved (a genuine conflict declined or `--on-existing skip`, a dry-run "would ask", or the "neither exists" case above) gets `finalize_action = skip_conflict` — the encoded file, if it still exists, is left in place for you to sort out manually or re-run with a decision.

**Archiving the original with `--move-originals` is independent of whether the promote step actually happened this row.** Even when the promote is left unresolved (`skip_conflict` for any reason above), `finalize` still attempts to archive the original into `./original_video/` — the two files are moved separately, so a conflict on one doesn't block the other. `original_archived` in the CSV always reflects the real outcome of the archive attempt for that row, regardless of `finalize_action`.

## CSV schemas

Each stage's CSV re-emits **every column from its input row** plus its own new columns — the `finalize` CSV alone is a complete audit trail back to the original scan. Because columns accumulate across stages, each stage's own status columns are prefixed with the stage name (`scan_*`, `reencode_*`, `finalize_*`) to avoid ambiguous duplicate headers.

### `scan` output (`video-scan.csv`)

| Column                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file_path`                | absolute path to the source file                                                                                                                                                                                                                                                                                                                                                                                                     |
| `file_name`                | base filename                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `file_size_bytes`          | source file size                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `container_format`         | ffprobe `format_name`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `duration_seconds`         | container duration                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `overall_bit_rate`         | container-level bit rate                                                                                                                                                                                                                                                                                                                                                                                                             |
| `video_codec`              | first video stream's codec name                                                                                                                                                                                                                                                                                                                                                                                                      |
| `video_profile`            | first video stream's profile (e.g. `High`)                                                                                                                                                                                                                                                                                                                                                                                           |
| `pix_fmt`                  | first video stream's pixel format                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bit_depth`                | derived from `pix_fmt` (e.g. `8`, `10`)                                                                                                                                                                                                                                                                                                                                                                                              |
| `chroma_subsampling`       | derived from `pix_fmt` (e.g. `4:2:0`)                                                                                                                                                                                                                                                                                                                                                                                                |
| `width`                    | video width, pixels                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `height`                   | video height, pixels                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `frame_rate`               | average frame rate, decimal                                                                                                                                                                                                                                                                                                                                                                                                          |
| `video_bit_rate`           | first video stream's bit rate                                                                                                                                                                                                                                                                                                                                                                                                        |
| `bits_per_pixel_per_frame` | `video_bit_rate / (width × height × frame_rate)` — a standard rough gauge of how heavily a video is already compressed relative to its resolution/frame rate; commonly abbreviated "bppf". Very low values (well under ~0.05–0.1 for H.264) suggest a file is already compressed hard and may not shrink much further. Falls back to `overall_bit_rate` when the video stream doesn't report its own bit rate (common for some mp4s) |
| `color_primaries`          | color primaries tag, when present                                                                                                                                                                                                                                                                                                                                                                                                    |
| `color_transfer`           | color transfer characteristic tag, when present                                                                                                                                                                                                                                                                                                                                                                                      |
| `color_space`              | color space/matrix tag, when present                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rotation`                 | rotation tag/side-data, degrees (`0` if none)                                                                                                                                                                                                                                                                                                                                                                                        |
| `audio_codec`              | first audio stream's codec name                                                                                                                                                                                                                                                                                                                                                                                                      |
| `audio_is_pcm`             | `true`/`false` — whether the first audio stream is a `pcm_*` codec                                                                                                                                                                                                                                                                                                                                                                   |
| `audio_sample_rate`        | first audio stream's sample rate                                                                                                                                                                                                                                                                                                                                                                                                     |
| `audio_channels`           | first audio stream's channel count                                                                                                                                                                                                                                                                                                                                                                                                   |
| `audio_bit_rate`           | first audio stream's bit rate                                                                                                                                                                                                                                                                                                                                                                                                        |
| `audio_stream_count`       | how many audio streams the file has                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subtitle_stream_count`    | how many subtitle streams the file has                                                                                                                                                                                                                                                                                                                                                                                               |
| `scan_result`              | `ok` or `error`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scan_error`               | ffprobe error text when `scan_result = error` (metadata columns are blank in that case)                                                                                                                                                                                                                                                                                                                                              |
| `crop_rect`                | the detected crop area as `wxh+x+y`, when `--crop-detect` was passed and detection succeeded; blank otherwise (including every row when `--crop-detect` wasn't used)                                                                                                                                                                                                                                                                 |
| `crop_preview_path`        | path to the crop-preview JPEG (see `--crop-detect` above); blank unless `crop_rect` is set                                                                                                                                                                                                                                                                                                                                           |
| `crop_error`               | error text if crop detection or preview generation failed; a crop failure never turns `scan_result` into `error` — the row is still `ok`, just without a crop area                                                                                                                                                                                                                                                                   |
| `cli_arguments`            | the full `scan` command line that produced this CSV, quoted for copy-paste; populated **only on the first row written**, blank on every other row (it's the same for the whole run, so repeating it per-row would just be noise)                                                                                                                                                                                                     |

### `reencode` output (`reencode-results.csv`)

All `scan` columns above, plus:

| Column                                 | Meaning                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output_file_path`                     | path to the re-encoded `.mkv` (blank unless `reencode_result = ok`)                                                                                                                                                                                                                                         |
| `output_file_size_bytes`               | re-encoded file size                                                                                                                                                                                                                                                                                        |
| `size_optimization_pct`                | `(1 - output_size / input_size) * 100`; can be negative if the encode is larger                                                                                                                                                                                                                             |
| `profile_id`                           | `ENCODING_PROFILE.id` used for this encode                                                                                                                                                                                                                                                                  |
| `ffmpeg_command`                       | the `ffmpeg` command for this row, quoted for copy-paste — populated for both a fresh encode and a reused one (see `reencode_action`); blank only for `skip_size`/`skip_scan_error` rows, where no encode was ever attempted                                                                                |
| `reencode_action`                      | `reencode` (ffmpeg actually ran this time), `reuse` (output already existed and `--on-existing skip` reused it without running ffmpeg), or blank for `skip_size`/`skip_scan_error` rows                                                                                                                     |
| `reencode_result`                      | `ok`, `error`, `skip_size` (below `--min-size-bytes`), or `skip_scan_error` (row was already a scan failure) — a `reuse` row is still `ok`, since the output file is genuinely complete, just not freshly produced this run                                                                                 |
| `reencode_error`                       | ffmpeg error text, or the passed-through `scan_error` for `skip_scan_error` rows                                                                                                                                                                                                                            |
| `sample_seconds`                       | the `--sample` duration used for this run, e.g. `10`; blank if `--sample` wasn't passed (or the file was shorter than the requested sample — see `--sample` above). A non-blank value here means `output_file_path` is a short preview clip, not a full re-encode — `finalize` refuses to act on these rows |
| `extrapolated_reencoded_size_bytes`    | on a sample row, the estimated full-file output size if the whole file were re-encoded at the same ratio observed in the sample; blank otherwise                                                                                                                                                            |
| `extrapolated_size_optimization_pct`   | on a sample row, the same ratio as `size_optimization_pct` (an extrapolation scales both sides equally, so the percentage doesn't change) — provided alongside the absolute figures below; blank otherwise                                                                                                  |
| `extrapolated_size_optimization_bytes` | on a sample row, the estimated bytes saved for the whole file (`file_size_bytes - extrapolated_reencoded_size_bytes`); blank otherwise                                                                                                                                                                      |

### `finalize` output (`finalize-results.csv`)

All `reencode` columns above, plus:

| Column                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalize_action`     | `promoted`, `skip_not_encoded` (row wasn't `reencode_result = ok`), `skip_sample` (row is a `--sample` preview), `skip_min_size` (original file below `--min-size-bytes`), `skip_below_threshold` (size_optimization_pct below `--threshold` — the encode is left in place, **not deleted**), `skip_conflict` (a destination conflict was left unresolved — see below), or `error`                                                                                                                                                                                                                      |
| `conflict_resolution` | blank on the ordinary happy path (including a plain `skip_below_threshold`, `skip_min_size`, `skip_sample`, or `skip_not_encoded` row); otherwise one or more `step:code` tokens joined by `\| `, e.g. `promote:already_done`, `archive:overwritten_flag`. Steps: `promote`, `archive`. Codes: `already_done`, `missing_both` (neither the file to move nor the destination exists — nothing to do, not an error), `overwritten_flag`/`overwritten_confirmed`, `skipped_flag`/`skipped_declined`/`skipped_dry_run`, `failed` (archive step only, an unexpected error secondary to a successful promote) |
| `finalize_error`      | error text if `finalize_action = error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `original_archived`   | `true`/`false` — whether the source file ended up archived (freshly, or already archived from a previous run) for this row                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Known limitations

- The PCM-vs-copy audio decision and the color-tag passthrough are both based on the **first** audio/video stream only; files with multiple audio streams of mixed codec types are encoded uniformly based on the first one.
- `reencode` maps only video, audio, and subtitle streams (`-map 0:v? -map 0:a? -map 0:s?`) — data/attachment streams some sources embed (e.g. a `tmcd` timecode track written by phones or editing tools) are intentionally dropped, since Matroska can't hold most of them via stream-copy and they carry no playable content anyway.
- Re-encoding into `.mkv` while stream-copying a subtitle codec that Matroska can't hold (e.g. MP4 `mov_text`) will still fail that file with `reencode_result = error` — inspect `reencode_error` and handle such files separately if you hit this.
- `finalize --on-existing ask` prompts one file at a time, in row order, with no "apply to all" shortcut — for a large batch with many conflicts, pass `--on-existing overwrite` or `--on-existing skip` to resolve them all the same way non-interactively instead.
- Neither `--on-existing skip` (in `reencode`) nor `finalize`'s "already done" detection re-validates the existing file's actual contents — they trust that a file sitting at the expected deterministic path is genuinely complete and uncorrupted, e.g. from a run that finished normally.
