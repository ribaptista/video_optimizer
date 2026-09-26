import { mkdir, stat } from "node:fs/promises";
import { readCsv, CsvWriter } from "../lib/csv.js";
import { buildFfmpegCommand, encodeVideo, getOutputPath } from "../lib/ffmpeg.js";
import { ENCODING_PROFILE } from "../profile.js";
import { REENCODE_COLUMNS, type ScanRow, type ReencodeRow } from "../types.js";

export type OnExisting = "warn" | "skip";

export interface ReencodeOptions {
  input: string;
  outputDir: string;
  output: string;
  minSizeBytes: number;
  onExisting: OnExisting;
  sampleSeconds?: number;
}

// The size a `sampleSeconds`-long slice of the source would be expected to
// take up, from the source's own video bitrate: video_bit_rate * seconds
// / 8. Comparing the sample's real re-encoded size against this — instead
// of against the whole file's size — is what makes size_optimization_pct
// on a sample row a fair preview of the ratio a full re-encode would
// achieve. This same estimate is also what --sample mode's progress
// stats (MB/s, ETA, remaining MB) are based on, since in that mode the
// actual work being done per file is just this slice, not the full file.
// Falls back to the container's overall bit rate when the video stream
// didn't report its own (common for some mp4s), and to a plain
// file-size/duration ratio as a last resort when neither is known.
function estimateSampleBytes(row: ScanRow, sampleSeconds: number): number {
  const duration = Number(row.duration_seconds) || 0;
  const effectiveSample = duration > 0 ? Math.min(sampleSeconds, duration) : sampleSeconds;

  const videoBitRate = Number(row.video_bit_rate) || 0;
  if (videoBitRate > 0) return (videoBitRate * effectiveSample) / 8;

  const overallBitRate = Number(row.overall_bit_rate) || 0;
  if (overallBitRate > 0) return (overallBitRate * effectiveSample) / 8;

  const fileSize = Number(row.file_size_bytes) || 0;
  return duration > 0 ? fileSize * (effectiveSample / duration) : fileSize;
}

// The size counted toward this row's progress: the full file size in a
// normal run, or the estimated sample-slice size in --sample mode.
function rowProgressBytes(row: ScanRow, sampleSeconds: number | undefined): number {
  if (sampleSeconds === undefined) return Number(row.file_size_bytes) || 0;
  return estimateSampleBytes(row, sampleSeconds);
}

// A source shorter than the requested --sample duration gets fully
// encoded anyway (the -ss/-t offset math clamps to the real duration),
// so treat that row as a genuine full encode rather than a sample: use
// the real file size for size_optimization_pct (accurate, not an
// estimate) and leave sample_seconds blank, so finalize can promote it
// like any other complete encode instead of refusing it as a preview
// clip it never actually was.
function effectiveSampleSeconds(row: ScanRow, sampleSeconds: number | undefined): number | undefined {
  if (sampleSeconds === undefined) return undefined;
  const duration = Number(row.duration_seconds) || 0;
  if (duration > 0 && sampleSeconds >= duration) return undefined;
  return sampleSeconds;
}

export async function runReencode(options: ReencodeOptions): Promise<void> {
  if (options.onExisting !== "warn" && options.onExisting !== "skip") {
    throw new Error(`--on-existing must be "warn" or "skip", got "${options.onExisting}"`);
  }

  const scanRows = await readCsv<ScanRow>(options.input);
  await mkdir(options.outputDir, { recursive: true });

  console.log(
    `[reencode] processing ${scanRows.length} row(s) from ${options.input}${
      options.sampleSeconds !== undefined ? ` (--sample ${options.sampleSeconds}s: preview only, not a full encode)` : ""
    }`,
  );

  // Progress tracking is meant to answer "how far through the whole batch
  // am I", so a skip/error still counts as "processed" for the purpose of
  // the remaining-bytes estimate. In --sample mode this is based on the
  // estimated sample-slice size per file (rowProgressBytes), not the full
  // file size, since that's the actual amount of work being done per file
  // — except for a file shorter than the sample duration, which gets
  // fully encoded anyway (see effectiveSampleSeconds).
  const totalBytes = scanRows.reduce(
    (sum, r) => sum + rowProgressBytes(r, effectiveSampleSeconds(r, options.sampleSeconds)),
    0,
  );
  const runStart = Date.now();
  let processedBytes = 0;

  const writer = new CsvWriter<ReencodeRow>(options.output, REENCODE_COLUMNS);
  let okCount = 0;
  let errorCount = 0;
  let skipSizeCount = 0;
  let skipScanCount = 0;
  let skipExistsCount = 0;

  for (const row of scanRows) {
    // The min-size-bytes check always applies to the real full file size,
    // regardless of --sample; progressBytes is what's actually counted as
    // "this row's share of the work" (full size normally, estimated
    // sample-slice size in --sample mode) for both the running MB/s & ETA
    // stats and the size_optimization_pct comparison below.
    const fullSizeBytes = Number(row.file_size_bytes) || 0;
    // A file shorter than --sample gets fully encoded regardless (see
    // effectiveSampleSeconds), so it's treated as a plain full encode for
    // filename hashing, comparison, and the sample_seconds column — not
    // as a (misleadingly-labeled) sample.
    const rowSample = effectiveSampleSeconds(row, options.sampleSeconds);
    const progressBytes = rowProgressBytes(row, rowSample);

    if (row.scan_result !== "ok") {
      console.log(`[reencode] skip_scan_error  ${row.file_path}`);
      writer.writeRow(passthroughRow(row, "skip_scan_error", row.scan_error, "", "", rowSample));
      skipScanCount++;
      processedBytes += progressBytes;
      continue;
    }

    if (options.minSizeBytes > 0 && fullSizeBytes < options.minSizeBytes) {
      console.log(`[reencode] skip_size  ${row.file_path} (${fullSizeBytes} < ${options.minSizeBytes} bytes)`);
      writer.writeRow(passthroughRow(row, "skip_size", "", "", "", rowSample));
      skipSizeCount++;
      processedBytes += progressBytes;
      continue;
    }

    // The output filename is a deterministic hash of the source path +
    // profile id (+ sample duration, if any), so a file already sitting
    // there is exactly what a prior run of this same file/profile/sample
    // would have produced.
    const existingPath = getOutputPath(row, options.outputDir, rowSample);
    const existingStat = await stat(existingPath).catch(() => null);

    if (existingStat) {
      if (options.onExisting === "skip") {
        const optimizationPct = (1 - existingStat.size / progressBytes) * 100;
        console.log(
          `[reencode] skip_exists  ${row.file_path} (reusing ${existingPath} from a previous run)`,
        );
        writer.writeRow({
          ...row,
          output_file_path: existingPath,
          output_file_size_bytes: String(existingStat.size),
          size_optimization_pct: optimizationPct.toFixed(2),
          profile_id: ENCODING_PROFILE.id,
          ffmpeg_command: buildFfmpegCommand(row, options.outputDir, rowSample),
          reencode_action: "reuse",
          reencode_result: "ok",
          reencode_error: "",
          sample_seconds: rowSample !== undefined ? String(rowSample) : "",
        });
        skipExistsCount++;
        processedBytes += progressBytes;
        continue;
      }
      console.log(`[reencode] warning  output already exists and will be overwritten: ${existingPath}`);
    }

    console.log(`[reencode] start  ${row.file_path}`);
    const rowStart = Date.now();
    const encodeResult = await encodeVideo(row, options.outputDir, rowSample);
    if (!encodeResult.ok) {
      console.log(`[reencode] error  ${row.file_path}: ${encodeResult.errorSummary}`);
      writer.writeRow(
        passthroughRow(row, "error", encodeResult.errorSummary, encodeResult.command, "reencode", rowSample),
      );
      errorCount++;
      processedBytes += progressBytes;
      continue;
    }

    const rowDurationSeconds = (Date.now() - rowStart) / 1000;
    const outStat = await stat(encodeResult.outputPath);
    const optimizationPct = (1 - outStat.size / progressBytes) * 100;
    console.log(
      `[reencode] ok  ${row.file_path} -> ${encodeResult.outputPath} (${optimizationPct.toFixed(1)}% smaller)`,
    );
    console.log(`[reencode]   took ${formatDuration(rowDurationSeconds)}`);

    processedBytes += progressBytes;
    const elapsedSeconds = (Date.now() - runStart) / 1000;
    const avgMBps = elapsedSeconds > 0 ? bytesToMB(processedBytes) / elapsedSeconds : 0;
    console.log(`[reencode]   avg ${avgMBps.toFixed(2)} MB/s since the start of this run`);

    const remainingBytes = Math.max(totalBytes - processedBytes, 0);
    if (remainingBytes > 0 && avgMBps > 0) {
      const etaSeconds = bytesToMB(remainingBytes) / avgMBps;
      console.log(
        `[reencode]   ${bytesToMB(remainingBytes).toFixed(1)} MB remaining, estimated time to complete: ${formatDuration(etaSeconds)}`,
      );
    }

    writer.writeRow({
      ...row,
      output_file_path: encodeResult.outputPath,
      output_file_size_bytes: String(outStat.size),
      size_optimization_pct: optimizationPct.toFixed(2),
      profile_id: ENCODING_PROFILE.id,
      ffmpeg_command: encodeResult.command,
      reencode_action: "reencode",
      reencode_result: "ok",
      reencode_error: "",
      sample_seconds: rowSample !== undefined ? String(rowSample) : "",
    });
    okCount++;
  }

  await writer.close();
  console.log(
    `[reencode] done: ${okCount} ok, ${errorCount} error, ${skipSizeCount} skip_size, ${skipScanCount} skip_scan_error, ${skipExistsCount} skip_exists, wrote ${options.output}`,
  );
}

function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`;
}

function passthroughRow(
  row: ScanRow,
  result: ReencodeRow["reencode_result"],
  error: string,
  command = "",
  action: ReencodeRow["reencode_action"] = "",
  sampleSeconds?: number,
): ReencodeRow {
  return {
    ...row,
    output_file_path: "",
    output_file_size_bytes: "",
    size_optimization_pct: "",
    profile_id: "",
    ffmpeg_command: command,
    reencode_action: action,
    reencode_result: result,
    reencode_error: error,
    sample_seconds: sampleSeconds !== undefined ? String(sampleSeconds) : "",
  };
}
