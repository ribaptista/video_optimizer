import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { moveFile } from "./moveFile.js";
import { ENCODING_PROFILE } from "../profile.js";
import type { ScanRow } from "../types.js";

export interface EncodeResult {
  outputPath: string;
  ok: boolean;
  errorSummary: string;
  command: string;
}

// Quotes an argument for display/copy-paste as a bash command line. Not
// used to actually execute anything (ffmpeg is always spawned with an argv
// array, never a shell string), only to populate the CSV's audit column.
function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteShellArg).join(" ");
}

// ffmpeg's stderr mixes real log lines (newline-terminated) with a
// continuously-redrawn "frame=... fps=... speed=..." progress line that
// uses bare '\r' with no trailing '\n'. Naively concatenating raw chunks
// and collapsing all whitespace (as an earlier version of this file did)
// runs unrelated numbers together and can push the actual error out of a
// fixed-length tail slice. This instead: normalizes each '\r'-delimited
// redraw down to its final state, then prefers lines that actually look
// like an error over routine encoder stats, so the CSV's error column is
// meaningful instead of an arbitrary truncated fragment.
function summarizeFfmpegStderr(rawStderr: string): string {
  const normalizedLines = rawStderr
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      return segments[segments.length - 1].trim();
    })
    .filter((line) => line.length > 0);

  const errorLines = normalizedLines.filter((line) =>
    /error|invalid|failed|not supported|no such|unable to|could not/i.test(line),
  );
  const relevant = errorLines.length > 0 ? errorLines : normalizedLines.slice(-10);

  return relevant.join(" | ").slice(-2000);
}

// Deterministic filename: sha256(absolute source path + profile id). Same
// source file + same profile always produces the same output filename,
// which is what makes --on-existing skip a safe "resume" mechanism — a
// second run recognizes exactly the file a prior run would have produced,
// without needing any separate state tracking.
export function getOutputFileName(row: ScanRow): string {
  const hash = createHash("sha256").update(`${row.file_path}::${ENCODING_PROFILE.id}`).digest("hex").slice(0, 16);
  return `${hash}.${ENCODING_PROFILE.container}`;
}

export function getOutputPath(row: ScanRow, outputDir: string): string {
  return path.join(outputDir, getOutputFileName(row));
}

// Builds the ffmpeg argv for encoding `row` to `outputPath`, without the
// leading "-y" input/output framing being tied to any particular temp vs.
// final path. Shared by encodeVideo (execution) and buildFfmpegCommand
// (audit-trail display for rows that reuse an existing output instead of
// re-running ffmpeg).
function buildEncodeArgs(row: ScanRow, outputPath: string): string[] {
  const args = [
    "-y",
    "-i",
    row.file_path,
    // Map video/audio/subtitle streams explicitly (each with "?" so a
    // source lacking that stream type doesn't fail the whole map) rather
    // than a blanket "-map 0". Some sources carry extra data/attachment
    // streams (e.g. a "tmcd" timecode track written by phones/editors,
    // or embedded thumbnail attachments) that Matroska can't hold via
    // stream-copy and that fail the entire encode with a generic
    // "Could not write header" error — none of that is meaningful video
    // content anyway, so it's dropped rather than carried over.
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-c:v",
    ENCODING_PROFILE.video.codec,
    "-preset",
    ENCODING_PROFILE.video.preset,
    "-crf",
    String(ENCODING_PROFILE.video.crf),
    "-pix_fmt",
    ENCODING_PROFILE.video.pixFmt,
  ];

  // Explicitly pass through color tags — a re-encode does not automatically
  // inherit the source's color metadata the way an untouched copy would.
  if (row.color_primaries) args.push("-color_primaries", row.color_primaries);
  if (row.color_transfer) args.push("-color_trc", row.color_transfer);
  if (row.color_space) args.push("-colorspace", row.color_space);

  if (row.audio_is_pcm === "true") {
    args.push("-c:a", ENCODING_PROFILE.audio.pcmReencodeCodec, "-b:a", ENCODING_PROFILE.audio.pcmReencodeBitrate);
  } else {
    args.push("-c:a", "copy");
  }
  args.push("-c:s", "copy", outputPath);
  return args;
}

// The command as it would look writing straight to the final path in
// outputDir — used both for the audit-trail column on a fresh encode and,
// unexecuted, for a row that reuses a previous run's output.
export function buildFfmpegCommand(row: ScanRow, outputDir: string): string {
  return formatCommand("ffmpeg", buildEncodeArgs(row, getOutputPath(row, outputDir)));
}

export async function encodeVideo(row: ScanRow, outputDir: string): Promise<EncodeResult> {
  // Encode into a temp subdirectory of outputDir first, and only move the
  // result into outputDir itself once ffmpeg has actually finished
  // successfully — so a crash or an interrupted run never leaves a
  // partial/corrupt file sitting in the final output directory.
  const tempDir = path.join(outputDir, ".tmp");
  await mkdir(tempDir, { recursive: true });

  const fileName = getOutputFileName(row);
  const tempOutputPath = path.join(tempDir, fileName);
  const finalOutputPath = path.join(outputDir, fileName);

  // Record the command as it would look writing straight to the final
  // path — the temp-dir staging is an internal implementation detail that
  // shouldn't leak into the audit trail a user might copy-paste to
  // reproduce this encode.
  const command = formatCommand("ffmpeg", buildEncodeArgs(row, finalOutputPath));
  const args = buildEncodeArgs(row, tempOutputPath);

  const stderrChunks: Buffer[] = [];
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("ffmpeg", args);
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

  const rawStderr = Buffer.concat(stderrChunks).toString("utf8");

  if (!ok) {
    await unlink(tempOutputPath).catch(() => {});
    return { outputPath: finalOutputPath, ok, errorSummary: summarizeFfmpegStderr(rawStderr), command };
  }

  await moveFile(tempOutputPath, finalOutputPath);
  return { outputPath: finalOutputPath, ok, errorSummary: "", command };
}
