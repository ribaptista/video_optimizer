#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { runScan } from "./commands/scan.js";
import { runReencode, type OnExisting } from "./commands/reencode.js";
import { runFinalize, type OnExistingFinalize } from "./commands/finalize.js";
import { runValidate } from "./commands/validate.js";
import { parseDurationSeconds } from "./lib/duration.js";
import { quoteShellArg } from "./lib/ffmpeg.js";
import {
  DEFAULT_CROP_FRAMES,
  DEFAULT_CROP_IGNORE,
  DEFAULT_CROP_LIMIT,
  DEFAULT_CROP_ROUND,
  DEFAULT_CROP_SAMPLES,
  DEFAULT_PREVIEW_DIR,
  parseCropIgnore,
  parseCropSamples,
  type CropIgnore,
} from "./lib/cropDetect.js";

const CROP_OPTION_FLAGS: Record<string, string> = {
  cropIgnore: "--crop-ignore",
  cropSingleAxis: "--crop-single-axis",
  cropMaxRatio: "--crop-max-ratio",
  cropLimit: "--crop-limit",
  cropRound: "--crop-round",
  cropFrames: "--crop-frames",
  cropSamples: "--crop-samples",
  previewDir: "--preview-dir",
};

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
  .option(
    "--crop-detect",
    "detect each video's letterbox/pillarbox crop area with ffmpeg's cropdetect and record it in the CSV " +
      "(does not modify the file; `reencode` applies the recorded crop)",
    false,
  )
  .addOption(
    new Option(
      "--crop-ignore <top,right,bottom,left>",
      "pixels to pre-crop from each edge before running cropdetect, e.g. to ignore a burned-in overlay or " +
        'timestamp near an edge (e.g. "0,0,40,100")',
    )
      .argParser((value: string) => {
        try {
          return parseCropIgnore(value);
        } catch (err) {
          throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
        }
      })
      .default(parseCropIgnore(DEFAULT_CROP_IGNORE), DEFAULT_CROP_IGNORE),
  )
  .option("--crop-single-axis", "crop only the dominant axis (left/right or top/bottom), not both", false)
  .option(
    "--crop-max-ratio <n>",
    "if the detected crop's long/short side ratio exceeds this, grow the short side back out to meet it " +
      "(e.g. 1.7778 for 16:9); 0 disables this",
    "0",
  )
  .option("--crop-limit <n>", "forwarded to ffmpeg's cropdetect=limit=", String(DEFAULT_CROP_LIMIT))
  .option("--crop-round <n>", "forwarded to ffmpeg's cropdetect=round=", String(DEFAULT_CROP_ROUND))
  .option(
    "--crop-frames <n>",
    "number of frames sampled by cropdetect at each sample point (forwarded as -frames:v)",
    String(DEFAULT_CROP_FRAMES),
  )
  .addOption(
    new Option(
      "--crop-samples <list>",
      "comma-separated fractions (each in [0,1)) of the video's duration to sample for crop detection",
    )
      .argParser((value: string) => {
        try {
          return parseCropSamples(value);
        } catch (err) {
          throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
        }
      })
      .default(parseCropSamples(DEFAULT_CROP_SAMPLES), DEFAULT_CROP_SAMPLES),
  )
  .option("--preview-dir <path>", "directory to write crop-preview JPEGs into", DEFAULT_PREVIEW_DIR)
  .action(
    async (
      directory: string,
      opts: {
        output: string;
        concurrency: string;
        cropDetect: boolean;
        cropIgnore: CropIgnore;
        cropSingleAxis: boolean;
        cropMaxRatio: string;
        cropLimit: string;
        cropRound: string;
        cropFrames: string;
        cropSamples: number[];
        previewDir: string;
      },
      command: Command,
    ) => {
      if (!opts.cropDetect) {
        const explicitKey = Object.keys(CROP_OPTION_FLAGS).find(
          (key) => command.getOptionValueSource(key) === "cli",
        );
        if (explicitKey) {
          throw new Error(`${CROP_OPTION_FLAGS[explicitKey]} requires --crop-detect to be enabled`);
        }
      }

      await runScan({
        directory,
        output: opts.output,
        concurrency: Number(opts.concurrency),
        cliArguments: process.argv.slice(2).map(quoteShellArg).join(" "),
        crop: opts.cropDetect
          ? {
              ignore: opts.cropIgnore,
              singleAxis: opts.cropSingleAxis,
              maxRatio: Number(opts.cropMaxRatio),
              limit: Number(opts.cropLimit),
              round: Number(opts.cropRound),
              frames: Number(opts.cropFrames),
              samples: opts.cropSamples,
              previewDir: opts.previewDir,
            }
          : undefined,
      });
    },
  );

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
  .command("validate")
  .description("Compare ffprobe durations for successful re-encoded videos and their sources")
  .requiredOption("-i, --input <path>", "input CSV produced by the reencode command")
  .option(
    "-t, --max-difference-seconds <n>",
    "maximum allowed absolute source/output duration difference in seconds",
    "1",
  )
  .action(async (opts: { input: string; maxDifferenceSeconds: string }) => {
    await runValidate({
      input: opts.input,
      maxDifferenceSeconds: Number(opts.maxDifferenceSeconds),
    });
  });

program
  .command("finalize")
  .description(
    "Using a reencode-results CSV and a % size-optimization threshold, promote encodes that clear it next to their originals (never deletes anything; low-gain encodes are just skipped and left in place)",
  )
  .requiredOption("-i, --input <path>", "input CSV produced by the reencode command")
  .requiredOption("-t, --threshold <percent>", "minimum % size optimization required to promote an encode; below this it's skipped, not deleted")
  .option("-m, --min-size-bytes <n>", "skip (leave untouched) rows whose original source file is smaller than this size in bytes", "0")
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
      minSizeBytes: string;
      moveOriginals: boolean;
      dryRun: boolean;
      output: string;
      onExisting: OnExistingFinalize;
    }) => {
      await runFinalize({
        input: opts.input,
        threshold: Number(opts.threshold),
        minSizeBytes: Number(opts.minSizeBytes),
        moveOriginals: opts.moveOriginals,
        dryRun: opts.dryRun,
        output: opts.output,
        onExisting: opts.onExisting,
      });
    },
  );

program.parseAsync(process.argv);
