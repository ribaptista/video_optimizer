import pLimit from "p-limit";
import { findVideoFiles } from "../lib/videoFiles.js";
import { probeVideoFile } from "../lib/ffprobe.js";
import { writeCsv } from "../lib/csv.js";
import { warnIfVersionMismatch } from "../lib/versionCheck.js";
import { SCAN_COLUMNS, type ScanRow } from "../types.js";

export interface ScanOptions {
  directory: string;
  output: string;
  concurrency: number;
}

export async function runScan(options: ScanOptions): Promise<void> {
  await warnIfVersionMismatch();

  const files = await findVideoFiles(options.directory);
  console.log(`[scan] found ${files.length} video file(s) under ${options.directory}`);

  const limit = pLimit(options.concurrency);
  const rows: ScanRow[] = await Promise.all(
    files.map((filePath) =>
      limit(async (): Promise<ScanRow> => {
        try {
          const metadata = await probeVideoFile(filePath);
          console.log(`[scan] ok     ${filePath}`);
          return { ...metadata, scan_result: "ok", scan_error: "" };
        } catch (err) {
          const message = errorMessage(err);
          console.log(`[scan] error  ${filePath}: ${message}`);
          return emptyErrorRow(filePath, message);
        }
      }),
    ),
  );

  await writeCsv(options.output, SCAN_COLUMNS, rows);

  const okCount = rows.filter((r) => r.scan_result === "ok").length;
  console.log(
    `[scan] done: ${okCount} ok, ${rows.length - okCount} error, wrote ${options.output}`,
  );
}

function errorMessage(err: unknown): string {
  const raw =
    err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string" && err.stderr.trim()
      ? err.stderr
      : err instanceof Error
        ? err.message
        : String(err);
  return raw.replace(/\s+/g, " ").trim();
}

function emptyErrorRow(filePath: string, message: string): ScanRow {
  return {
    file_path: filePath,
    file_name: "",
    file_size_bytes: "",
    container_format: "",
    duration_seconds: "",
    overall_bit_rate: "",
    video_codec: "",
    video_profile: "",
    pix_fmt: "",
    bit_depth: "",
    chroma_subsampling: "",
    width: "",
    height: "",
    frame_rate: "",
    video_bit_rate: "",
    color_primaries: "",
    color_transfer: "",
    color_space: "",
    rotation: "",
    audio_codec: "",
    audio_is_pcm: "",
    audio_sample_rate: "",
    audio_channels: "",
    audio_bit_rate: "",
    audio_stream_count: "",
    subtitle_stream_count: "",
    scan_result: "error",
    scan_error: message,
  };
}
