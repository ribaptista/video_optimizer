import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readCsv, CsvWriter } from "../lib/csv.js";
import { moveFile } from "../lib/moveFile.js";
import { FINALIZE_COLUMNS, type ReencodeRow, type FinalizeRow } from "../types.js";

export type OnExistingFinalize = "ask" | "overwrite" | "skip";

export interface FinalizeOptions {
  input: string;
  threshold: number;
  minSizeBytes: number;
  moveOriginals: boolean;
  dryRun: boolean;
  output: string;
  onExisting: OnExistingFinalize;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(
      `[finalize] warning  no interactive terminal available to answer "${question}" — defaulting to skip. Pass --on-existing overwrite|skip to decide this non-interactively.`,
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`[finalize] ${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

type ConflictKind = "proceed" | "skip" | "already_done";

// `code` is the short, structured token recorded in the CSV's
// conflict_resolution column; `message` is the fuller sentence printed to
// the console (undefined when there was no conflict at all, i.e. the
// ordinary happy path with no pre-existing destination).
interface ConflictOutcome {
  kind: ConflictKind;
  code:
    | "none"
    | "already_done"
    | "missing_both"
    | "overwritten_flag"
    | "overwritten_confirmed"
    | "skipped_flag"
    | "skipped_declined"
    | "skipped_dry_run";
  message?: string;
}

// Shared decision for both the promote-destination move and the
// archive-original move: what to do given whether the thing we'd move
// still exists, and whether something is already sitting at the
// destination.
async function resolveConflict(opts: {
  sourceExists: boolean;
  destExists: boolean;
  onExisting: OnExistingFinalize;
  dryRun: boolean;
  sourceLabel: string;
  destLabel: string;
}): Promise<ConflictOutcome> {
  if (!opts.destExists) {
    if (!opts.sourceExists) {
      return {
        kind: "skip",
        code: "missing_both",
        message: `neither ${opts.sourceLabel} nor ${opts.destLabel} exists — nothing to do here (the source may have been deleted, moved elsewhere, or never produced)`,
      };
    }
    return { kind: "proceed", code: "none" };
  }
  if (!opts.sourceExists) {
    return {
      kind: "already_done",
      code: "already_done",
      message: `${opts.sourceLabel} no longer exists, but ${opts.destLabel} already exists — treating as already done from a previous run`,
    };
  }

  // Both exist: a genuine conflict that needs a decision.
  if (opts.onExisting === "overwrite") {
    return {
      kind: "proceed",
      code: "overwritten_flag",
      message: `${opts.destLabel} already existed — overwriting it (--on-existing overwrite)`,
    };
  }
  if (opts.onExisting === "skip") {
    return {
      kind: "skip",
      code: "skipped_flag",
      message: `${opts.destLabel} already existed — skipping (--on-existing skip)`,
    };
  }
  if (opts.dryRun) {
    return {
      kind: "skip",
      code: "skipped_dry_run",
      message: `${opts.destLabel} already exists — would prompt to overwrite it with ${opts.sourceLabel} (dry run; pass --on-existing overwrite|skip to decide non-interactively)`,
    };
  }
  const overwrite = await promptYesNo(
    `${opts.destLabel} already exists. Overwrite it with ${opts.sourceLabel}?`,
  );
  return overwrite
    ? {
        kind: "proceed",
        code: "overwritten_confirmed",
        message: `${opts.destLabel} already existed — overwritten (confirmed interactively)`,
      }
    : {
        kind: "skip",
        code: "skipped_declined",
        message: `${opts.destLabel} already existed — skipped (declined interactively)`,
      };
}

export async function runFinalize(options: FinalizeOptions): Promise<void> {
  const rows = await readCsv<ReencodeRow>(options.input);
  console.log(
    `[finalize] processing ${rows.length} row(s) from ${options.input}${options.dryRun ? " (dry run)" : ""}`,
  );

  const writer = new CsvWriter<FinalizeRow>(options.output, FINALIZE_COLUMNS);
  let promoted = 0;
  let skipConflict = 0;
  let skipped = 0;
  let skipSample = 0;
  let skipMinSize = 0;
  let skipBelowThreshold = 0;
  let errored = 0;

  for (const row of rows) {
    if (row.reencode_result !== "ok") {
      console.log(`[finalize] skip_not_encoded  ${row.file_path}`);
      writer.writeRow({
        ...row,
        finalize_action: "skip_not_encoded",
        conflict_resolution: "",
        finalize_error: "",
        original_archived: "false",
      });
      skipped++;
      continue;
    }

    // A --sample row is a short preview clip, not a full re-encode — never
    // let it flow into the promote logic below, since "promoting" it
    // would rename a few seconds of preview footage into place as if it
    // were the real re-encoded file. Re-run reencode on this file without
    // --sample first.
    if (row.sample_seconds) {
      console.log(
        `[finalize] skip_sample  ${row.file_path} (this is a ${row.sample_seconds}s sample preview, not a full re-encode)`,
      );
      writer.writeRow({
        ...row,
        finalize_action: "skip_sample",
        conflict_resolution: "",
        finalize_error: "",
        original_archived: "false",
      });
      skipSample++;
      continue;
    }

    // Filters by the ORIGINAL source file's size (not the encode) — skip
    // finalizing anything that was never big enough to bother with in the
    // first place, mirroring reencode's own --min-size-bytes.
    const fullSizeBytes = Number(row.file_size_bytes) || 0;
    if (options.minSizeBytes > 0 && fullSizeBytes < options.minSizeBytes) {
      console.log(
        `[finalize] skip_min_size  ${row.file_path} (${fullSizeBytes} < ${options.minSizeBytes} bytes)`,
      );
      writer.writeRow({
        ...row,
        finalize_action: "skip_min_size",
        conflict_resolution: "",
        finalize_error: "",
        original_archived: "false",
      });
      skipMinSize++;
      continue;
    }

    const optimizationPct = Number(row.size_optimization_pct);

    try {
      if (optimizationPct < options.threshold) {
        // Below the threshold: leave the encoded file exactly where it
        // is — finalize never deletes anything. The row is simply
        // skipped, so a low-value encode sits untouched in the reencode
        // output directory for you to review or clean up manually.
        console.log(
          `[finalize] skip_below_threshold  ${row.output_file_path} (${optimizationPct.toFixed(1)}% < ${options.threshold}%)`,
        );
        writer.writeRow({
          ...row,
          finalize_action: "skip_below_threshold",
          conflict_resolution: "",
          finalize_error: "",
          original_archived: "false",
        });
        skipBelowThreshold++;
        continue;
      }

      // Promote branch.
      const originalDir = path.dirname(row.file_path);
      const baseNameNoExt = path.basename(row.file_path, path.extname(row.file_path));
      const encodedExt = path.extname(row.output_file_path);
      const roundedPct = Math.round(optimizationPct);
      const destPath = path.join(
        originalDir,
        `${baseNameNoExt}.reencoded-${row.profile_id}-opt${roundedPct}pct${encodedExt}`,
      );

      const conflictCodes: string[] = [];

      const sourceExists = await pathExists(row.output_file_path);
      const destExists = await pathExists(destPath);
      const conflict = await resolveConflict({
        sourceExists,
        destExists,
        onExisting: options.onExisting,
        dryRun: options.dryRun,
        sourceLabel: row.output_file_path,
        destLabel: destPath,
      });
      if (conflict.message) console.log(`[finalize] warning  ${conflict.message}`);
      if (conflict.code !== "none") conflictCodes.push(`promote:${conflict.code}`);

      let promotedThisRow = false;
      if (conflict.kind === "already_done") {
        promotedThisRow = true;
      } else if (conflict.kind === "proceed") {
        if (options.dryRun) {
          console.log(`[finalize] dry-run would promote  ${row.output_file_path} -> ${destPath}`);
        } else {
          await moveFile(row.output_file_path, destPath);
          console.log(`[finalize] promoted  ${row.output_file_path} -> ${destPath}`);
        }
        promotedThisRow = true;
      }
      // conflict.kind === "skip": leave both files where they are.

      // Archiving the original is independent of whether the promote above
      // actually happened this run — even if the encode was left in place
      // due to a conflict (declined, --on-existing skip, missing_both,
      // dry-run), --move-originals still tucks the original away.
      let archived = false;
      if (options.moveOriginals) {
        try {
          const archiveDir = path.join(originalDir, "original_video");
          const archiveDest = path.join(archiveDir, path.basename(row.file_path));
          const origSourceExists = await pathExists(row.file_path);
          const origDestExists = await pathExists(archiveDest);
          const origConflict = await resolveConflict({
            sourceExists: origSourceExists,
            destExists: origDestExists,
            onExisting: options.onExisting,
            dryRun: options.dryRun,
            sourceLabel: row.file_path,
            destLabel: archiveDest,
          });
          if (origConflict.message) console.log(`[finalize] warning  ${origConflict.message}`);
          if (origConflict.code !== "none") conflictCodes.push(`archive:${origConflict.code}`);

          if (origConflict.kind === "already_done") {
            archived = true;
          } else if (origConflict.kind === "proceed") {
            if (options.dryRun) {
              console.log(
                `[finalize] dry-run would archive original  ${row.file_path} -> ${archiveDest}`,
              );
            } else {
              await mkdir(archiveDir, { recursive: true });
              await moveFile(row.file_path, archiveDest);
              console.log(`[finalize] archived original  ${row.file_path} -> ${archiveDest}`);
            }
            archived = true;
          }
          // origConflict.kind === "skip": leave the original where it is.
        } catch (err) {
          // A failure archiving the original never demotes the row's
          // primary finalize_action (deleted/promoted/skip_conflict) —
          // note it in conflict_resolution instead.
          const message = err instanceof Error ? err.message : String(err);
          console.log(
            `[finalize] warning  failed to archive original ${row.file_path}: ${message}`,
          );
          conflictCodes.push("archive:failed");
          archived = false;
        }
      }

      const rowAction: FinalizeRow["finalize_action"] = promotedThisRow
        ? "promoted"
        : "skip_conflict";
      writer.writeRow({
        ...row,
        finalize_action: rowAction,
        conflict_resolution: conflictCodes.join(" | "),
        finalize_error: "",
        original_archived: archived ? "true" : "false",
      });
      if (rowAction === "promoted") promoted++;
      else skipConflict++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[finalize] error  ${row.file_path}: ${message}`);
      writer.writeRow({
        ...row,
        finalize_action: "error",
        conflict_resolution: "",
        finalize_error: message,
        original_archived: "false",
      });
      errored++;
    }
  }

  await writer.close();
  console.log(
    `[finalize] done: ${promoted} promoted, ${skipBelowThreshold} skip_below_threshold, ${skipMinSize} skip_min_size, ${skipConflict} skip_conflict, ${skipped} skip_not_encoded, ${skipSample} skip_sample, ${errored} error, wrote ${options.output}${
      options.dryRun ? " (dry run — no files were changed)" : ""
    }`,
  );
}
