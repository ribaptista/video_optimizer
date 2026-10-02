import { readCsv } from "../lib/csv.js";
import { probeVideoFile } from "../lib/ffprobe.js";
import type { ReencodeRow } from "../types.js";

export interface ValidateOptions {
  input: string;
  maxDifferenceSeconds: number;
}

export async function runValidate(options: ValidateOptions): Promise<void> {
  if (!Number.isFinite(options.maxDifferenceSeconds) || options.maxDifferenceSeconds < 0) {
    throw new Error("--max-difference-seconds must be a non-negative number");
  }

  const rows = await readCsv<ReencodeRow>(options.input);
  console.log(
    `[validate] processing ${rows.length} row(s) from ${options.input} (maximum difference: ${formatSeconds(options.maxDifferenceSeconds)})`,
  );

  let validCount = 0;
  let mismatchCount = 0;
  let probeErrorCount = 0;
  let nonOkCount = 0;

  for (const row of rows) {
    if (row.reencode_result !== "ok") {
      console.log(
        `[validate] non_ok  ${row.file_path} (${row.reencode_result}${row.reencode_error ? `: ${row.reencode_error}` : ""})`,
      );
      nonOkCount++;
      continue;
    }

    try {
      const [source, output] = await Promise.all([
        probeVideoFile(row.file_path),
        probeVideoFile(row.output_file_path),
      ]);
      const sourceDuration = Number(source.duration_seconds);
      const outputDuration = Number(output.duration_seconds);

      if (!Number.isFinite(sourceDuration) || !Number.isFinite(outputDuration)) {
        throw new Error(
          `ffprobe did not report a numeric duration (source: "${source.duration_seconds}", output: "${output.duration_seconds}")`,
        );
      }

      const difference = outputDuration - sourceDuration;
      const absoluteDifference = Math.abs(difference);
      const result = absoluteDifference > options.maxDifferenceSeconds ? "error" : "ok";
      console.log(
        `[validate] ${result}  ${row.file_path} -> ${row.output_file_path} (source ${formatSeconds(sourceDuration)}, output ${formatSeconds(outputDuration)}, difference ${formatSignedSeconds(difference)})`,
      );

      if (result === "ok") validCount++;
      else mismatchCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[validate] error  ${row.file_path} -> ${row.output_file_path}: ${message}`);
      probeErrorCount++;
    }
  }

  console.log(
    `[validate] done: ${validCount} valid, ${mismatchCount} duration mismatch, ${probeErrorCount} probe error, ${nonOkCount} non-ok`,
  );

  const failureCount = mismatchCount + probeErrorCount;
  if (failureCount > 0) {
    throw new Error(`${failureCount} row(s) failed validation`);
  }
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(3)}s`;
}

function formatSignedSeconds(seconds: number): string {
  return `${seconds >= 0 ? "+" : ""}${formatSeconds(seconds)}`;
}