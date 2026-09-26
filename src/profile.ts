// Single source of truth for the fixed re-encode profile.
// The `id` must change whenever ANY value below changes — never mutate a
// value in place while keeping the same id. Downstream CSVs and the
// `finalize` command's output filename suffix embed this id, so an id
// change is how the pipeline tells old encodes apart from new ones.
export const ENCODING_PROFILE = {
  id: "h264-crf20-slow-yuv420p-v1",
  video: {
    codec: "libx264",
    preset: "slow",
    crf: 20,
    pixFmt: "yuv420p",
  },
  audio: {
    pcmReencodeCodec: "aac",
    pcmReencodeBitrate: "192k",
  },
  container: "mkv",
} as const;

// Pinned to the ffprobe/ffmpeg version found on the machine this profile
// was designed against. A mismatch doesn't stop the tool, only warns,
// since ffprobe's JSON field set can shift subtly across versions.
export const PINNED_FFMPEG_VERSION = "8.0.1";
