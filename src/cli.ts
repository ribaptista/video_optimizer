#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { runScan } from "./commands/scan.js";
import { runReencode, type OnExisting } from "./commands/reencode.js";
import { runFinalize, type OnExistingFinalize } from "./commands/finalize.js";
import { parseDurationSeconds } from "./lib/duration.js";

const program = new Command();

program
  .name("video-optimizer")
  .description("Scan, re-encode, and finalize a video library to optimize storage");

program
  .command("scan")
  .description("Recursively scan a directory for video files and record ffprobe metadata to a CSV")
  .argument("<directory>", "directory to scan recursively")
  .option("-o, --output <path>", "output CSV path", "./video-scan.csv")
  .option("-c, --concurrency <n>", "number of concurrent ffprobe processes", "4")
  .action(async (directory: string, opts: { output: string; concurrency: string }) => {
    await runScan({
      directory,
      output: opts.output,
      concurrency: Number(opts.concurrency),
    });
  });

program
  .command("reencode")
  .description("Re-encode each file listed in a scan CSV with the fixed encoding profile")
  .requiredOption("-i, --input <path>", "input CSV produced by the scan command")
  .requiredOption("-d, --output-dir <path>", "directory to write re-encoded files into")
  .option("-o, --output <path>", "output CSV path", "./reencode-results.csv")
  .option("-m, --min-size-bytes <n>", "skip files smaller than this size in bytes", "0")
  .addOption(
    new Option(
      "--on-existing <mode>",
      "what to do when a file's deterministic output name already exists in --output-dir: " +
        "'warn' overwrites it (with a warning); 'skip' reuses it as-is, resuming a previous run",
    )
      .choices(["warn", "skip"])
      .default("warn"),
  )
  .option(
    "--sample <duration>",
    "only re-encode a sample clip of this duration (e.g. 5s, 10s, 1m), taken from the middle of the video, " +
      "instead of the full file — for quickly previewing compression before committing to a full run",
    (value: string) => {
      try {
        return parseDurationSeconds(value);
      } catch (err) {
        throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
      }
    },
  )
  .action(
    async (opts: {
      input: string;
      outputDir: string;
      output: string;
      minSizeBytes: string;
      onExisting: OnExisting;
      sample?: number;
    }) => {
      await runReencode({
        input: opts.input,
        outputDir: opts.outputDir,
        output: opts.output,
        minSizeBytes: Number(opts.minSizeBytes),
        onExisting: opts.onExisting,
        sampleSeconds: opts.sample,
      });
    },
  );

program
  .command("finalize")
  .description(
    "Using a reencode-results CSV and a % size-optimization threshold, delete low-gain encodes or promote the rest next to their originals",
  )
  .requiredOption("-i, --input <path>", "input CSV produced by the reencode command")
  .requiredOption("-t, --threshold <percent>", "minimum % size optimization required to keep an encode")
  .option("--move-originals", "also move the original file into a sibling ./original_video directory", false)
  .option("--dry-run", "print planned actions without touching the filesystem", false)
  .option("-o, --output <path>", "output CSV path", "./finalize-results.csv")
  .addOption(
    new Option(
      "--on-existing <mode>",
      "what to do when a promoted/archived destination file already exists: " +
        "'ask' prompts interactively (default); 'overwrite' replaces it; 'skip' leaves both files as they are",
    )
      .choices(["ask", "overwrite", "skip"])
      .default("ask"),
  )
  .action(
    async (opts: {
      input: string;
      threshold: string;
      moveOriginals: boolean;
      dryRun: boolean;
      output: string;
      onExisting: OnExistingFinalize;
    }) => {
      await runFinalize({
        input: opts.input,
        threshold: Number(opts.threshold),
        moveOriginals: opts.moveOriginals,
        dryRun: opts.dryRun,
        output: opts.output,
        onExisting: opts.onExisting,
      });
    },
  );

program.parseAsync(process.argv);
