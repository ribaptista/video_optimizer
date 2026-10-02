# syntax=docker/dockerfile:1
#
# video-optimizer CLI image.
#
# Pinning strategy (verified live against upstream registries/archives when this file was
# written -- see the comment above each pin for how):
#   - Base OS/Node runtime: `node:22-trixie-slim`, pinned by both tag *and* content digest, so
#     the base layer can never silently change under a rebuild. Node 22 is current LTS; nothing
#     in this project (plain commander/csv-parse/csv-stringify/p-limit -- no native addons) ties
#     it to a specific Node version.
#   - ffmpeg/ffprobe: installed via `apt-get install ffmpeg=<exact-version>`, pinned to the exact
#     trixie package version confirmed present via https://sources.debian.org/api/src/ffmpeg/ at
#     the time this file was written (7:7.1.5-0+deb13u1 -- a single `ffmpeg` binary package
#     provides both `ffmpeg` and `ffprobe`, confirmed via `dpkg -L ffmpeg`). A version-pinned
#     `apt-get install` fails loudly (not silently drifts) once Debian's trixie archive
#     supersedes it with a newer security update. When that happens, bump ARG FFMPEG_VERSION
#     below to whatever `apt-cache policy ffmpeg` now reports. For a build that must reproduce
#     bit-for-bit far into the future regardless of what's still in the live trixie archive,
#     point `apt-get`'s sources at a fixed https://snapshot.debian.org/archive/debian/
#     <YYYYMMDDTHHMMSSZ>/ snapshot instead of the default mirror.
#   - Node dependencies: pinned by the repository's own committed package-lock.json via
#     `npm ci` (exact, hash-verified versions -- nothing invented here).
#
# Note on src/profile.ts's PINNED_FFMPEG_VERSION ("8.0.1-3ubuntu2"): that constant is the
# version this project's encoding profile was developed/tested against (an Ubuntu build), not a
# hard floor -- `scan` just prints a non-fatal warning when the live ffprobe version differs
# (see src/lib/versionCheck.ts). Debian trixie's pinned 7.1.5 above is a different (older, still
# actively maintained) build than 8.0.1, so every `scan` run in this image prints that warning.
# This is expected and harmless -- see README.md's Docker section -- not a sign the pin below is
# wrong; bumping it to silence the warning would require tracking a non-stable Debian suite
# (trixie doesn't have 8.0.1) or switching the base distro entirely.

ARG NODE_IMAGE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

# ---- deps: install node_modules once, shared by the build and runtime stages ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Every dependency (commander, csv-parse, csv-stringify, p-limit) is pure JS -- `npm ci` never
# needs to compile anything here, on any architecture.
RUN npm ci

# ---- build: compile TypeScript ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: node_modules pruned to production-only, same lockfile ----
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---- runtime: the actual image ----
FROM ${NODE_IMAGE} AS runtime

ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        "ffmpeg=${FFMPEG_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    # Fail the build loudly, not the first `scan`/`reencode` run in production, if the pinned
    # package ever stops providing what video-optimizer actually needs -- both binaries it shells
    # out to (src/lib/ffprobe.ts, src/lib/ffmpeg.ts, src/lib/cropDetect.ts).
    && ffmpeg -version | head -1 \
    && ffprobe -version | head -1

WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Runs as an unprivileged user, not the `node` image's default root -- this only ever touches
# whatever host directory is bind-mounted at runtime (see below) plus its own /app, never needs
# root, and there's no reason to give a mounted video library root-owned access to it.
RUN groupadd --gid 1001 video-optimizer \
    && useradd --uid 1001 --gid video-optimizer --no-user-group --no-create-home \
        --home-dir /app --shell /usr/sbin/nologin video-optimizer \
    && chown -R video-optimizer:video-optimizer /app
USER video-optimizer

# tini as PID 1: forwards SIGINT/SIGTERM to node correctly and reaps the `ffmpeg`/`ffprobe` child
# processes scan/reencode spawn -- without a real init, Ctrl-C (or `docker stop`) during a long
# reencode batch can leave the in-flight ffmpeg process as an orphaned zombie instead of being
# killed along with the container; tini is the standard, correct fix and costs nothing.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli.js"]
# No default subcommand -- video-optimizer is a multi-command CLI (scan/reencode/validate/
# finalize), and guessing one would be wrong for most invocations. `--help` is a safe,
# informative default for `docker run <image>` with no arguments.
CMD ["--help"]

# --- Usage ---
#
# Every command reads and/or writes a video library directory, CSV files, and (for
# `scan --crop-detect`) a crop-preview directory -- all of that needs to persist on the host
# across separate `docker run` invocations (a `scan` CSV feeding a later `reencode`, a
# `reencode --output-dir` the next `finalize` promotes files out of, etc.), so bind-mount a
# directory and point every CLI path at somewhere under it, rather than relying on the
# container's own filesystem:
#
#   docker run --rm -it \
#     --user "$(id -u):$(id -g)" \
#     -v /path/to/your/videos:/data \
#     <image> scan /data --output /data/scan.csv --crop-detect --preview-dir /data/previews
#
#   docker run --rm -it \
#     --user "$(id -u):$(id -g)" \
#     -v /path/to/your/videos:/data \
#     <image> reencode --input /data/scan.csv --output-dir /data/encoded --output /data/reencode-results.csv
#
# `--user "$(id -u):$(id -g)"` is not optional in practice: the image's baked-in
# `video-optimizer` user (uid/gid 1001) almost never matches your bind-mounted directory's actual
# ownership, and without this override every write into it (video-scan.csv, a re-encoded file, a
# crop preview JPEG) fails with EACCES. Overriding `--user` at `docker run` time (rather than
# hardcoding a single uid/gid at build time) is what lets one image work unmodified regardless of
# which host user's directory it's pointed at.
#
# Every command's `-o`/`--output` CSV path defaults to a relative `./*.csv` -- in the container
# that resolves against WORKDIR /app, not your bind mount, so leaving it out fails with EACCES
# under `--user` (/app is owned by the image's own uid 1001, not yours) or silently writes a CSV
# that's thrown away when the container exits. Always pass `-o`/`--output` pointing somewhere
# under /data explicitly, as both examples above do.
