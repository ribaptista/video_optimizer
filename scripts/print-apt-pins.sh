#!/usr/bin/env bash
# Prints the ffmpeg version currently available in the exact Debian trixie
# archive the Dockerfile's pinned base image would see -- the first step
# of the "apt pins going stale" fix procedure in the README's "Releasing"
# section. Run this, then update ARG FFMPEG_VERSION in the Dockerfile to
# match.
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_IMAGE="$(grep -oP '^ARG NODE_IMAGE=\K\S+' Dockerfile)"
if [ -z "$NODE_IMAGE" ]; then
  echo "error: couldn't find 'ARG NODE_IMAGE=...' in Dockerfile" >&2
  exit 1
fi

echo "Querying apt candidates in $NODE_IMAGE ..." >&2
docker run --rm "$NODE_IMAGE" sh -c \
  'apt-get update -qq && apt-cache policy ffmpeg' \
  | grep -E 'ffmpeg|Candidate'
