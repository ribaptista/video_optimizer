import { mkdir, stat } from "node:fs/promises";
import { readCsv, writeCsv } from "../lib/csv.js";
import { encodeVideo } from "../lib/ffmpeg.js";
import { ENCODING_PROFILE } from "../profile.js";
import { REENCODE_COLUMNS, type ScanRow, type ReencodeRow } from "../types.js";

export interface ReencodeOptions {
  input: string;
  outputDir: string;
  output: string;
  minSizeBytes: number;
}

export async function runReencode(options: ReencodeOptions): Promise<void> {
  const scanRows = await readCsv<ScanRow>(options.input);
  await mkdir(options.outputDir, { recursive: true });

  console.log(`[reencode] processing ${scanRows.length} row(s) from ${options.input}`);

  const results: ReencodeRow[] = [];
  let okCount = 0;
  let errorCount = 0;
  let skipSizeCount = 0;
  let skipScanCount = 0;

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

    console.log(`[reencode] start  ${row.file_path}`);
    const encodeResult = await encodeVideo(row, options.outputDir);
    if (!encodeResult.ok) {
      console.log(`[reencode] error  ${row.file_path}: ${encodeResult.errorSummary}`);
      results.push(passthroughRow(row, "error", encodeResult.errorSummary));
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
      reencode_result: "ok",
      reencode_error: "",
    });
    okCount++;
  }

  await writeCsv(options.output, REENCODE_COLUMNS, results);
  console.log(
    `[reencode] done: ${okCount} ok, ${errorCount} error, ${skipSizeCount} skip_size, ${skipScanCount} skip_scan_error, wrote ${options.output}`,
  );
}

function passthroughRow(
  row: ScanRow,
  result: ReencodeRow["reencode_result"],
  error: string,
): ReencodeRow {
  return {
    ...row,
    output_file_path: "",
    output_file_size_bytes: "",
    size_optimization_pct: "",
    profile_id: "",
    reencode_result: result,
    reencode_error: error,
  };
}
