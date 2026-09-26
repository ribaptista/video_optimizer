import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { ENCODING_PROFILE } from "../profile.js";
import type { ScanRow } from "../types.js";

export interface EncodeResult {
  outputPath: string;
  ok: boolean;
  stderr: string;
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

  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (!ok) {
    await unlink(outputPath).catch(() => {});
  }

  return { outputPath, ok, stderr };
}
