import { mkdir } from "node:fs/promises";
import pLimit from "p-limit";
import { findVideoFiles } from "../lib/videoFiles.js";
import { probeVideoFile } from "../lib/ffprobe.js";
import { CsvWriter } from "../lib/csv.js";
import { warnIfVersionMismatch } from "../lib/versionCheck.js";
import {
  detectCrop,
  formatCropRect,
  generateCropPreview,
  type CropIgnore,
} from "../lib/cropDetect.js";
import { SCAN_COLUMNS, type ScanRow } from "../types.js";

export interface CropOptions {
  ignore: CropIgnore;
  singleAxis: boolean;
  maxRatio: number;
  limit: number;
  round: number;
  frames: number;
  samples: number[];
  previewDir: string;
}

export interface ScanOptions {
  directory: string;
  output: string;
  concurrency: number;
  cliArguments: string;
  crop?: CropOptions;
}

export async function runScan(options: ScanOptions): Promise<void> {
  await warnIfVersionMismatch();

  const files = await findVideoFiles(options.directory);
  console.log(`[scan] found ${files.length} video file(s) under ${options.directory}`);

  if (options.crop) {
    await mkdir(options.crop.previewDir, { recursive: true });
  }

  const writer = new CsvWriter<ScanRow>(options.output, SCAN_COLUMNS);
  let okCount = 0;
  let errorCount = 0;
  let cropErrorCount = 0;

  // The `cli_arguments` column is only meaningful once per file (it's the
  // same for every row in a run), so it's recorded on the first row written
  // and left blank on the rest rather than repeated on every line.
  let cliArgumentsRemaining = options.cliArguments;
  function takeCliArguments(): string {
    const value = cliArgumentsRemaining;
    cliArgumentsRemaining = "";
    return value;
  }

  const limit = pLimit(options.concurrency);
  await Promise.all(
    files.map((filePath) =>
      limit(async (): Promise<void> => {
        try {
          const metadata = await probeVideoFile(filePath);
          console.log(`[scan] ok     ${filePath}`);

          let cropRect = "";
          let cropPreviewPath = "";
          let cropError = "";

          if (options.crop) {
            try {
              const rect = await detectCrop(metadata, {
                ignore: options.crop.ignore,
                singleAxis: options.crop.singleAxis,
                maxRatio: options.crop.maxRatio,
                limit: options.crop.limit,
                round: options.crop.round,
                frames: options.crop.frames,
                samples: options.crop.samples,
              });
              cropRect = formatCropRect(rect);
              console.log(`[scan]   crop ${cropRect}`);
              cropPreviewPath = await generateCropPreview(metadata, rect, options.crop.previewDir);
            } catch (err) {
              cropError = errorMessage(err);
              console.log(`[scan]   crop error  ${filePath}: ${cropError}`);
              cropErrorCount++;
            }
          }

          writer.writeRow({
            ...metadata,
            scan_result: "ok",
            scan_error: "",
            crop_rect: cropRect,
            crop_preview_path: cropPreviewPath,
            crop_error: cropError,
            cli_arguments: takeCliArguments(),
          });
          okCount++;
        } catch (err) {
          const message = errorMessage(err);
          console.log(`[scan] error  ${filePath}: ${message}`);
          writer.writeRow(emptyErrorRow(filePath, message, takeCliArguments()));
          errorCount++;
        }
      }),
    ),
  );

  await writer.close();

  console.log(
    `[scan] done: ${okCount} ok, ${errorCount} error` +
      (options.crop ? `, ${cropErrorCount} crop_error` : "") +
      `, wrote ${options.output}`,
  );
}

function errorMessage(err: unknown): string {
  const raw =
    err &&
    typeof err === "object" &&
    "stderr" in err &&
    typeof err.stderr === "string" &&
    err.stderr.trim()
      ? err.stderr
      : err instanceof Error
        ? err.message
        : String(err);
  return raw.replace(/\s+/g, " ").trim();
}

function emptyErrorRow(filePath: string, message: string, cliArguments: string): ScanRow {
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
    bits_per_pixel_per_frame: "",
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
    crop_rect: "",
    crop_preview_path: "",
    crop_error: "",
    cli_arguments: cliArguments,
  };
}
