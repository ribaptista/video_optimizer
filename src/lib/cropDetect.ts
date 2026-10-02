import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ScanRow } from "../types.js";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropIgnore {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropDetectOptions {
  ignore: CropIgnore;
  singleAxis: boolean;
  maxRatio: number;
  limit: number;
  round: number;
  frames: number;
  samples: number[];
  ffmpegPath?: string;
}

export const DEFAULT_CROP_IGNORE = "0,0,0,0";
export const DEFAULT_CROP_SAMPLES = "0.25,0.5,0.75";
export const DEFAULT_CROP_LIMIT = 16;
export const DEFAULT_CROP_ROUND = 2;
export const DEFAULT_CROP_FRAMES = 16;
export const DEFAULT_PREVIEW_DIR = "./crop-previews";

// --- Parsing / formatting -------------------------------------------------

export function parseCropIgnore(input: string): CropIgnore {
  const parts = input.split(",").map((s) => s.trim());
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(
      `invalid --crop-ignore "${input}" — expected 4 non-negative integers "top,right,bottom,left" (e.g. "0,0,40,100")`,
    );
  }
  const [top, right, bottom, left] = parts.map(Number);
  return { top, right, bottom, left };
}

export function parseCropSamples(input: string): number[] {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(
      `invalid --crop-samples "${input}" — expected a comma-separated list of fractions, e.g. "0.25,0.5,0.75"`,
    );
  }
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n >= 1) {
      throw new Error(`invalid --crop-samples value "${p}" — each fraction must be in the range [0, 1)`);
    }
    return n;
  });
}

export function formatCropRect(rect: CropRect): string {
  return `${rect.w}x${rect.h}+${rect.x}+${rect.y}`;
}

export function parseCropRect(input: string | undefined): CropRect | null {
  if (!input) return null;
  const match = input.trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  if (!match) return null;
  return { w: Number(match[1]), h: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

// ffmpeg auto-rotates the decoded frame according to the stream's rotation
// metadata before any `-vf` filter sees it (both when cropdetect runs and
// when the eventual crop is applied during reencode), so a rect computed in
// ffprobe's raw (unrotated) width/height would be wrong for a ±90°-rotated
// source. This swaps width/height whenever the rotation implies the
// displayed frame is actually portrait/landscape-flipped from the stored
// dimensions.
export function displayDimensions(row: Pick<ScanRow, "width" | "height" | "rotation">): {
  width: number;
  height: number;
} {
  const width = Number(row.width) || 0;
  const height = Number(row.height) || 0;
  const rotation = Number(row.rotation) || 0;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const swapped = normalizedRotation === 90 || normalizedRotation === 270;
  return swapped ? { width: height, height: width } : { width, height };
}

export function isFullFrame(rect: CropRect, frameWidth: number, frameHeight: number): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === frameWidth && rect.h === frameHeight;
}

// --- Pure rect math --------------------------------------------------------

// Combines per-sample detections by taking, per edge, the rect that reaches
// furthest toward that edge — i.e. the smallest crop any sample detected on
// each side. This is deliberately conservative: a frame that only briefly
// shows content near an edge (e.g. a single bright flash) still keeps that
// content in the union, rather than one dim/black sample cropping it away.
export function unionCrops(crops: CropRect[]): CropRect {
  if (crops.length === 0) {
    throw new Error("unionCrops requires at least one rect");
  }
  const x = Math.min(...crops.map((c) => c.x));
  const y = Math.min(...crops.map((c) => c.y));
  const right = Math.max(...crops.map((c) => c.x + c.w));
  const bottom = Math.max(...crops.map((c) => c.y + c.h));
  return { x, y, w: right - x, h: bottom - y };
}

// Translates a rect detected in pre-cropped (ignore-margin-stripped)
// coordinates back into full-frame coordinates, and — for each edge where
// cropdetect found essentially no padding (within `round` pixels of that
// edge of the pre-cropped frame) — stretches the rect out to the true frame
// edge, absorbing that edge's ignore margin back in. This mirrors the
// reference script's adjustCrop, generalized from left/bottom-only to all
// four edges.
export function adjustCrop(
  rect: CropRect,
  ignore: CropIgnore,
  round: number,
  frameWidth: number,
  frameHeight: number,
): CropRect {
  const preWidth = frameWidth - ignore.left - ignore.right;
  const preHeight = frameHeight - ignore.top - ignore.bottom;

  const topPad = rect.y;
  const leftPad = rect.x;
  const rightPad = preWidth - rect.x - rect.w;
  const bottomPad = preHeight - rect.y - rect.h;

  let x = rect.x + ignore.left;
  let y = rect.y + ignore.top;
  let w = rect.w;
  let h = rect.h;

  const tolerance = Math.max(round, 0);

  if (topPad <= tolerance) {
    h += y;
    y = 0;
  }
  if (leftPad <= tolerance) {
    w += x;
    x = 0;
  }
  if (rightPad <= tolerance) {
    w = frameWidth - x;
  }
  if (bottomPad <= tolerance) {
    h = frameHeight - y;
  }

  return { x, y, w, h };
}

// When a source crops on both axes (e.g. both letterboxed and
// pillarboxed), keeps only the crop on the dominant axis — the one implied
// by the resulting rect's own orientation — and restores the other axis to
// the full frame. A vertical (taller-than-wide) rect keeps its left/right
// crop and restores full height; a horizontal/square rect keeps its
// top/bottom crop and restores full width.
export function restrictToSingleAxis(rect: CropRect, frameWidth: number, frameHeight: number): CropRect {
  const cropsHorizontally = rect.x > 0 || rect.w < frameWidth;
  const cropsVertically = rect.y > 0 || rect.h < frameHeight;
  if (!cropsHorizontally || !cropsVertically) return rect;

  if (rect.h > rect.w) {
    return { x: rect.x, y: 0, w: rect.w, h: frameHeight };
  }
  return { x: 0, y: rect.y, w: frameWidth, h: rect.h };
}

// Ensures the rect's long/short side ratio doesn't exceed `maxRatio` by
// growing the short side symmetrically (e.g. widening a too-narrow
// vertical crop, or heightening a too-short horizontal crop), clamped to
// the available space on each side so it never grows past the frame.
export function enforceMaxRatio(
  rect: CropRect,
  maxRatio: number,
  frameWidth: number,
  frameHeight: number,
): CropRect {
  if (maxRatio <= 0) return rect;

  const isVertical = rect.h > rect.w;
  const long = isVertical ? rect.h : rect.w;
  const short = isVertical ? rect.w : rect.h;
  if (short <= 0 || long / short <= maxRatio) return rect;

  const targetShort = long / maxRatio;
  const grow = targetShort - short;
  if (grow <= 0) return rect;

  if (isVertical) {
    const availLeft = rect.x;
    const availRight = frameWidth - (rect.x + rect.w);
    let left = grow / 2;
    let right = grow / 2;
    if (left > availLeft) {
      right += left - availLeft;
      left = availLeft;
    }
    if (right > availRight) {
      left += right - availRight;
      right = availRight;
    }
    left = Math.max(0, Math.min(left, availLeft));
    right = Math.max(0, Math.min(right, availRight));
    return { x: rect.x - left, y: rect.y, w: rect.w + left + right, h: rect.h };
  }

  const availTop = rect.y;
  const availBottom = frameHeight - (rect.y + rect.h);
  let top = grow / 2;
  let bottom = grow / 2;
  if (top > availTop) {
    bottom += top - availTop;
    top = availTop;
  }
  if (bottom > availBottom) {
    top += bottom - availBottom;
    bottom = availBottom;
  }
  top = Math.max(0, Math.min(top, availTop));
  bottom = Math.max(0, Math.min(bottom, availBottom));
  return { x: rect.x, y: rect.y - top, w: rect.w, h: rect.h + top + bottom };
}

function floorEven(n: number): number {
  return n - (n % 2);
}

function ceilEven(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

// libx264 (and yuv420p chroma subsampling generally) requires even output
// dimensions, so the final rect's width/height — and, for clean chroma
// alignment, its x/y offset too — are rounded to even values, expanding
// outward (never cropping further) and then clamped back within the frame.
export function normalizeEven(rect: CropRect, frameWidth: number, frameHeight: number): CropRect {
  let x = floorEven(rect.x);
  let w = ceilEven(rect.w + (rect.x - x));
  let y = floorEven(rect.y);
  let h = ceilEven(rect.h + (rect.y - y));

  if (x + w > frameWidth) x = Math.max(0, frameWidth - w);
  if (y + h > frameHeight) y = Math.max(0, frameHeight - h);
  w = floorEven(Math.min(w, frameWidth - x));
  h = floorEven(Math.min(h, frameHeight - y));

  return { x, y, w, h };
}

// --- ffmpeg invocation ------------------------------------------------------

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", () => resolve({ stdout: "", stderr: "", code: null }));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
      });
    });
  });
}

function buildIgnoreFilter(ignore: CropIgnore): string | null {
  if (!ignore.top && !ignore.right && !ignore.bottom && !ignore.left) return null;
  return `crop=iw-${ignore.left + ignore.right}:ih-${ignore.top + ignore.bottom}:${ignore.left}:${ignore.top}`;
}

async function detectCropAtTimestamp(
  filePath: string,
  timestamp: number,
  opts: CropDetectOptions,
): Promise<CropRect> {
  const ignoreFilter = buildIgnoreFilter(opts.ignore);
  const cropdetectFilter = `cropdetect=limit=${opts.limit}:round=${opts.round}:reset=0`;
  const filter = ignoreFilter ? `${ignoreFilter},${cropdetectFilter}` : cropdetectFilter;

  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-ss",
    String(Math.max(0, timestamp)),
    "-i",
    filePath,
    "-an",
    "-sn",
    "-vf",
    filter,
    "-frames:v",
    String(opts.frames),
    "-f",
    "null",
    "-",
  ];

  const { stdout, stderr } = await runFfmpeg(opts.ffmpegPath ?? "ffmpeg", args);
  const output = `${stdout}\n${stderr}`;
  const matches = [...output.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];

  if (!matches.length) {
    throw new Error(`cropdetect produced no result at ${timestamp.toFixed(2)}s`);
  }

  const match = matches[matches.length - 1];
  return { w: Number(match[1]), h: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

// Runs cropdetect across the configured sample points, unions the results,
// and applies the ignore-margin adjustment, single-axis restriction, and
// max-ratio enforcement (in that order) to arrive at a final, even-aligned
// crop rect in full-frame coordinates.
export async function detectCrop(
  row: Pick<ScanRow, "file_path" | "duration_seconds" | "width" | "height" | "rotation">,
  opts: CropDetectOptions,
): Promise<CropRect> {
  const { width: frameWidth, height: frameHeight } = displayDimensions(row);
  const duration = Number(row.duration_seconds) || 0;

  if (frameWidth <= 0 || frameHeight <= 0) {
    throw new Error("unknown video dimensions");
  }
  if (duration <= 0) {
    throw new Error("unknown video duration");
  }
  if (opts.samples.length === 0) {
    throw new Error("no crop samples configured");
  }

  const sampleRects: CropRect[] = [];
  for (const fraction of opts.samples) {
    const timestamp = fraction * duration;
    sampleRects.push(await detectCropAtTimestamp(row.file_path, timestamp, opts));
  }

  const unioned = unionCrops(sampleRects);
  let rect = adjustCrop(unioned, opts.ignore, opts.round, frameWidth, frameHeight);
  if (opts.singleAxis) rect = restrictToSingleAxis(rect, frameWidth, frameHeight);
  rect = enforceMaxRatio(rect, opts.maxRatio, frameWidth, frameHeight);
  rect = normalizeEven(rect, frameWidth, frameHeight);
  return rect;
}

// Deterministic preview filename: <basename>-<hash of absolute source
// path>.jpg. The hash suffix keeps same-named files from different
// subdirectories of a recursive scan from overwriting each other's preview.
export function getCropPreviewPath(row: Pick<ScanRow, "file_path">, previewDir: string): string {
  const hash = createHash("sha256").update(row.file_path).digest("hex").slice(0, 8);
  const base = path.basename(row.file_path, path.extname(row.file_path));
  return path.join(previewDir, `${base}-${hash}.jpg`);
}

// Generates a single JPEG frame, taken from the middle of the video, with a
// thin green box drawn around the chosen crop rect — so the detected area
// can be sanity-checked by eye.
export async function generateCropPreview(
  row: Pick<ScanRow, "file_path" | "duration_seconds">,
  rect: CropRect,
  previewDir: string,
  ffmpegPath = "ffmpeg",
): Promise<string> {
  const duration = Number(row.duration_seconds) || 0;
  const timestamp = duration * 0.5;
  const outputPath = getCropPreviewPath(row, previewDir);

  const filter = `drawbox=x=${rect.x}:y=${rect.y}:w=${rect.w}:h=${rect.h}:color=green@1:t=1`;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(Math.max(0, timestamp)),
    "-i",
    row.file_path,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outputPath,
  ];

  const result = await runFfmpeg(ffmpegPath, args);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-5).join(" | ");
    throw new Error(`ffmpeg preview generation failed: ${tail || "unknown error"}`);
  }

  return outputPath;
}
