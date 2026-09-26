import { mkdir, stat } from "node:fs/promises";
import { readCsv, writeCsv } from "../lib/csv.js";
import { encodeVideo, getOutputPath } from "../lib/ffmpeg.js";
import { ENCODING_PROFILE } from "../profile.js";
import { REENCODE_COLUMNS, type ScanRow, type ReencodeRow } from "../types.js";

export type OnExisting = "warn" | "skip";

export interface ReencodeOptions {
  input: string;
  outputDir: string;
  output: string;
  minSizeBytes: number;
  onExisting: OnExisting;
}

export async function runReencode(options: ReencodeOptions): Promise<void> {
  if (options.onExisting !== "warn" && options.onExisting !== "skip") {
    throw new Error(`--on-existing must be "warn" or "skip", got "${options.onExisting}"`);
  }

  const scanRows = await readCsv<ScanRow>(options.input);
  await mkdir(options.outputDir, { recursive: true });

  console.log(`[reencode] processing ${scanRows.length} row(s) from ${options.input}`);

  const results: ReencodeRow[] = [];
  let okCount = 0;
  let errorCount = 0;
  let skipSizeCount = 0;
  let skipScanCount = 0;
  let skipExistsCount = 0;

  for (const row of scanRows) {
    if (row.scan_result !== "ok") {
      console.log(`[reencode] skip_scan_error  ${row.file_path}`);
      results.push(passthroughRow(row, "skip_scan_error", row.scan_error));
      skipScanCount++;
      continue;
    }

    const sizeBytes = Number(row.file_size_bytes);
    if (options.minSizeBytes > 0 && sizeBytes < options.minSizeBytes) {
      console.log(`[reencode] skip_size  ${row.file_path} (${sizeBytes} < ${options.minSizeBytes} bytes)`);
      results.push(passthroughRow(row, "skip_size", ""));
      skipSizeCount++;
      continue;
    }

    // The output filename is a deterministic hash of the source path +
    // profile id, so a file already sitting there is exactly what a prior
    // run of this same file/profile would have produced.
    const existingPath = getOutputPath(row, options.outputDir);
    const existingStat = await stat(existingPath).catch(() => null);

    if (existingStat) {
      if (options.onExisting === "skip") {
        const optimizationPct = (1 - existingStat.size / sizeBytes) * 100;
        console.log(
          `[reencode] skip_exists  ${row.file_path} (reusing ${existingPath} from a previous run)`,
        );
        results.push({
          ...row,
          output_file_path: existingPath,
          output_file_size_bytes: String(existingStat.size),
          size_optimization_pct: optimizationPct.toFixed(2),
          profile_id: ENCODING_PROFILE.id,
          ffmpeg_command: "",
          reencode_result: "ok",
          reencode_error: "",
        });
        skipExistsCount++;
        continue;
      }
      console.log(`[reencode] warning  output already exists and will be overwritten: ${existingPath}`);
    }

    console.log(`[reencode] start  ${row.file_path}`);
    const encodeResult = await encodeVideo(row, options.outputDir);
    if (!encodeResult.ok) {
      console.log(`[reencode] error  ${row.file_path}: ${encodeResult.errorSummary}`);
      results.push(passthroughRow(row, "error", encodeResult.errorSummary, encodeResult.command));
      errorCount++;
      continue;
    }

    const outStat = await stat(encodeResult.outputPath);
    const optimizationPct = (1 - outStat.size / sizeBytes) * 100;
    console.log(
      `[reencode] ok  ${row.file_path} -> ${encodeResult.outputPath} (${optimizationPct.toFixed(1)}% smaller)`,
    );
    results.push({
      ...row,
      output_file_path: encodeResult.outputPath,
      output_file_size_bytes: String(outStat.size),
      size_optimization_pct: optimizationPct.toFixed(2),
      profile_id: ENCODING_PROFILE.id,
      ffmpeg_command: encodeResult.command,
      reencode_result: "ok",
      reencode_error: "",
    });
    okCount++;
  }

  await writeCsv(options.output, REENCODE_COLUMNS, results);
  console.log(
    `[reencode] done: ${okCount} ok, ${errorCount} error, ${skipSizeCount} skip_size, ${skipScanCount} skip_scan_error, ${skipExistsCount} skip_exists, wrote ${options.output}`,
  );
}

function passthroughRow(
  row: ScanRow,
  result: ReencodeRow["reencode_result"],
  error: string,
  command = "",
): ReencodeRow {
  return {
    ...row,
    output_file_path: "",
    output_file_size_bytes: "",
    size_optimization_pct: "",
    profile_id: "",
    ffmpeg_command: command,
    reencode_result: result,
    reencode_error: error,
  };
}
