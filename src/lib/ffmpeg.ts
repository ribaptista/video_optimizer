import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { ENCODING_PROFILE } from "../profile.js";
import type { ScanRow } from "../types.js";

export interface EncodeResult {
  outputPath: string;
  ok: boolean;
  errorSummary: string;
}

// ffmpeg's stderr mixes real log lines (newline-terminated) with a
// continuously-redrawn "frame=... fps=... speed=..." progress line that
// uses bare '\r' with no trailing '\n'. Naively concatenating raw chunks
// and collapsing all whitespace (as an earlier version of this file did)
// runs unrelated numbers together and can push the actual error out of a
// fixed-length tail slice. This instead: normalizes each '\r'-delimited
// redraw down to its final state, then prefers lines that actually look
// like an error over routine encoder stats, so the CSV's error column is
// meaningful instead of an arbitrary truncated fragment.
function summarizeFfmpegStderr(rawStderr: string): string {
  const normalizedLines = rawStderr
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      return segments[segments.length - 1].trim();
    })
    .filter((line) => line.length > 0);

  const errorLines = normalizedLines.filter((line) =>
    /error|invalid|failed|not supported|no such|unable to|could not/i.test(line),
  );
  const relevant = errorLines.length > 0 ? errorLines : normalizedLines.slice(-10);

  return relevant.join(" | ").slice(-2000);
}

export function buildOutputPath(outputDir: string): string {
  return path.join(outputDir, `${randomUUID()}.${ENCODING_PROFILE.container}`);
}

export async function encodeVideo(row: ScanRow, outputDir: string): Promise<EncodeResult> {
  const outputPath = buildOutputPath(outputDir);
  const args = [
    "-y",
    "-i",
    row.file_path,
    "-map",
    "0",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-c:v",
    ENCODING_PROFILE.video.codec,
    "-preset",
    ENCODING_PROFILE.video.preset,
    "-crf",
    String(ENCODING_PROFILE.video.crf),
    "-pix_fmt",
    ENCODING_PROFILE.video.pixFmt,
  ];

  // Explicitly pass through color tags — a re-encode does not automatically
  // inherit the source's color metadata the way an untouched copy would.
  if (row.color_primaries) args.push("-color_primaries", row.color_primaries);
  if (row.color_transfer) args.push("-color_trc", row.color_transfer);
  if (row.color_space) args.push("-colorspace", row.color_space);

  if (row.audio_is_pcm === "true") {
    args.push("-c:a", ENCODING_PROFILE.audio.pcmReencodeCodec, "-b:a", ENCODING_PROFILE.audio.pcmReencodeBitrate);
  } else {
    args.push("-c:a", "copy");
  }
  args.push("-c:s", "copy");
  args.push(outputPath);

  const stderrChunks: Buffer[] = [];
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("ffmpeg", args);
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

  const rawStderr = Buffer.concat(stderrChunks).toString("utf8");

  if (!ok) {
    await unlink(outputPath).catch(() => {});
  }

  return { outputPath, ok, errorSummary: ok ? "" : summarizeFfmpegStderr(rawStderr) };
}
