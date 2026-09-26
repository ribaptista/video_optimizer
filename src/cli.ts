#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./commands/scan.js";

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

program.parseAsync(process.argv);
