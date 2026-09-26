import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { readCsv, writeCsv } from "../lib/csv.js";
import { moveFile } from "../lib/moveFile.js";
import { FINALIZE_COLUMNS, type ReencodeRow, type FinalizeRow } from "../types.js";

export interface FinalizeOptions {
  input: string;
  threshold: number;
  moveOriginals: boolean;
  dryRun: boolean;
  output: string;
}

export async function runFinalize(options: FinalizeOptions): Promise<void> {
  const rows = await readCsv<ReencodeRow>(options.input);
  console.log(
    `[finalize] processing ${rows.length} row(s) from ${options.input}${options.dryRun ? " (dry run)" : ""}`,
  );

  const results: FinalizeRow[] = [];
  let deleted = 0;
  let promoted = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of rows) {
    if (row.reencode_result !== "ok") {
      console.log(`[finalize] skip_not_encoded  ${row.file_path}`);
      results.push({
        ...row,
        finalize_action: "skip_not_encoded",
        finalize_error: "",
        original_archived: "false",
      });
      skipped++;
      continue;
    }

    const optimizationPct = Number(row.size_optimization_pct);

    try {
      if (optimizationPct < options.threshold) {
        if (options.dryRun) {
          console.log(
            `[finalize] dry-run would delete  ${row.output_file_path} (${optimizationPct.toFixed(1)}% < ${options.threshold}%)`,
          );
        } else {
          await unlink(row.output_file_path);
          console.log(
            `[finalize] deleted  ${row.output_file_path} (${optimizationPct.toFixed(1)}% < ${options.threshold}%)`,
          );
        }
        results.push({ ...row, finalize_action: "deleted", finalize_error: "", original_archived: "false" });
        deleted++;
        continue;
      }

      const originalDir = path.dirname(row.file_path);
      const baseNameNoExt = path.basename(row.file_path, path.extname(row.file_path));
      const encodedExt = path.extname(row.output_file_path);
      const roundedPct = Math.round(optimizationPct);
      const destPath = path.join(
        originalDir,
        `${baseNameNoExt}.reencoded-${row.profile_id}-opt${roundedPct}pct${encodedExt}`,
      );

      let archived = false;
      if (options.dryRun) {
        console.log(`[finalize] dry-run would promote  ${row.output_file_path} -> ${destPath}`);
        if (options.moveOriginals) {
          const archiveDest = path.join(originalDir, "original_video", path.basename(row.file_path));
          console.log(`[finalize] dry-run would archive original  ${row.file_path} -> ${archiveDest}`);
          archived = true;
        }
      } else {
        await moveFile(row.output_file_path, destPath);
        console.log(`[finalize] promoted  ${row.output_file_path} -> ${destPath}`);
        if (options.moveOriginals) {
          const archiveDir = path.join(originalDir, "original_video");
          await mkdir(archiveDir, { recursive: true });
          const archiveDest = path.join(archiveDir, path.basename(row.file_path));
          await moveFile(row.file_path, archiveDest);
          console.log(`[finalize] archived original  ${row.file_path} -> ${archiveDest}`);
          archived = true;
        }
      }

      results.push({
        ...row,
        finalize_action: "promoted",
        finalize_error: "",
        original_archived: archived ? "true" : "false",
      });
      promoted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[finalize] error  ${row.file_path}: ${message}`);
      results.push({ ...row, finalize_action: "error", finalize_error: message, original_archived: "false" });
      errored++;
    }
  }

  await writeCsv(options.output, FINALIZE_COLUMNS, results);
  console.log(
    `[finalize] done: ${deleted} deleted, ${promoted} promoted, ${skipped} skip_not_encoded, ${errored} error, wrote ${options.output}${
      options.dryRun ? " (dry run — no files were changed)" : ""
    }`,
  );
}
