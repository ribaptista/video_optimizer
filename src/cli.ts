#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./commands/scan.js";
import { runReencode } from "./commands/reencode.js";
import { runFinalize } from "./commands/finalize.js";

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
  .action(async (opts: { input: string; outputDir: string; output: string; minSizeBytes: string }) => {
    await runReencode({
      input: opts.input,
      outputDir: opts.outputDir,
      output: opts.output,
      minSizeBytes: Number(opts.minSizeBytes),
    });
  });

program
  .command("finalize")
  .description(
    "Using a reencode-results CSV and a % size-optimization threshold, delete low-gain encodes or promote the rest next to their originals",
  )
  .requiredOption("-i, --input <path>", "input CSV produced by the reencode command")
  .requiredOption("-t, --threshold <percent>", "minimum %% size optimization required to keep an encode")
  .option("--move-originals", "also move the original file into a sibling ./original_video directory", false)
  .option("--dry-run", "print planned actions without touching the filesystem", false)
  .option("-o, --output <path>", "output CSV path", "./finalize-results.csv")
  .action(
    async (opts: {
      input: string;
      threshold: string;
      moveOriginals: boolean;
      dryRun: boolean;
      output: string;
    }) => {
      await runFinalize({
        input: opts.input,
        threshold: Number(opts.threshold),
        moveOriginals: opts.moveOriginals,
        dryRun: opts.dryRun,
        output: opts.output,
      });
    },
  );

program.parseAsync(process.argv);
