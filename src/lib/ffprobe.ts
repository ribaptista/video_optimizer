import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { ScanRow } from "../types.js";

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

// Maps common pix_fmt names to (bit depth, chroma subsampling). Falls back
// to "unknown" for formats outside this common set rather than guessing.
const PIX_FMT_INFO: Record<string, { bitDepth: string; chroma: string }> = {
  yuv420p: { bitDepth: "8", chroma: "4:2:0" },
  yuvj420p: { bitDepth: "8", chroma: "4:2:0" },
  yuv420p10le: { bitDepth: "10", chroma: "4:2:0" },
  yuv420p12le: { bitDepth: "12", chroma: "4:2:0" },
  yuv422p: { bitDepth: "8", chroma: "4:2:2" },
  yuv422p10le: { bitDepth: "10", chroma: "4:2:2" },
  yuv444p: { bitDepth: "8", chroma: "4:4:4" },
  yuv444p10le: { bitDepth: "10", chroma: "4:4:4" },
  nv12: { bitDepth: "8", chroma: "4:2:0" },
  p010le: { bitDepth: "10", chroma: "4:2:0" },
};

function parseFrameRate(rate: string | undefined): string {
  if (!rate) return "";
  const [num, den] = rate.split("/").map(Number);
  if (!den) return "";
  return (num / den).toFixed(3);
}

// Bits per pixel per frame: video_bit_rate / (width * height * frame_rate).
// A standard rough gauge of how heavily a video is already compressed
// relative to its resolution/frame rate — very low bppf (e.g. well under
// 0.05-0.1 for H.264) suggests it's already compressed hard and may not
// be worth re-encoding further. Falls back to the container's overall
// bit rate when the video stream doesn't report its own (common for some
// mp4s), which slightly overstates bppf by including audio's share.
function computeBppf(
  bitRateBitsPerSec: number,
  width: number,
  height: number,
  frameRate: number,
): string {
  if (bitRateBitsPerSec <= 0 || width <= 0 || height <= 0 || frameRate <= 0) return "";
  return (bitRateBitsPerSec / (width * height * frameRate)).toFixed(4);
}

function parseRotation(stream: FfprobeStream): string {
  const tagRotate = stream.tags?.rotate;
  if (tagRotate) return tagRotate;
  const sideData = stream.side_data_list?.find(
    (sd) => typeof sd.rotation === "number" || typeof sd.rotation === "string",
  );
  if (sideData && sideData.rotation !== undefined) return String(sideData.rotation);
  return "0";
}

export async function probeVideoFile(
  filePath: string,
): Promise<
  Omit<
    ScanRow,
    | "scan_result"
    | "scan_error"
    | "crop_rect"
    | "crop_preview_path"
    | "crop_error"
    | "cli_arguments"
  >
> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as FfprobeOutput;

  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStreams = data.streams?.filter((s) => s.codec_type === "audio") ?? [];
  const subtitleStreams = data.streams?.filter((s) => s.codec_type === "subtitle") ?? [];
  const firstAudio = audioStreams[0];

  const pixFmtInfo = videoStream?.pix_fmt ? PIX_FMT_INFO[videoStream.pix_fmt] : undefined;
  const audioIsPcm = firstAudio?.codec_name?.startsWith("pcm_") ?? false;

  const fileStat = await stat(filePath);

  const frameRate =
    Number(parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate)) || 0;
  const videoBitRate = videoStream?.bit_rate ? Number(videoStream.bit_rate) : 0;
  const overallBitRate = data.format?.bit_rate ? Number(data.format.bit_rate) : 0;
  const bppf = computeBppf(
    videoBitRate > 0 ? videoBitRate : overallBitRate,
    videoStream?.width ?? 0,
    videoStream?.height ?? 0,
    frameRate,
  );

  return {
    file_path: path.resolve(filePath),
    file_name: path.basename(filePath),
    file_size_bytes: String(fileStat.size),
    container_format: data.format?.format_name ?? "",
    duration_seconds: data.format?.duration ?? "",
    overall_bit_rate: data.format?.bit_rate ?? "",
    video_codec: videoStream?.codec_name ?? "",
    video_profile: videoStream?.profile ?? "",
    pix_fmt: videoStream?.pix_fmt ?? "",
    bit_depth: pixFmtInfo?.bitDepth ?? "",
    chroma_subsampling: pixFmtInfo?.chroma ?? "",
    width: videoStream?.width !== undefined ? String(videoStream.width) : "",
    height: videoStream?.height !== undefined ? String(videoStream.height) : "",
    frame_rate: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
    video_bit_rate: videoStream?.bit_rate ?? "",
    bits_per_pixel_per_frame: bppf,
    color_primaries: videoStream?.color_primaries ?? "",
    color_transfer: videoStream?.color_transfer ?? "",
    color_space: videoStream?.color_space ?? "",
    rotation: videoStream ? parseRotation(videoStream) : "",
    audio_codec: firstAudio?.codec_name ?? "",
    audio_is_pcm: String(audioIsPcm),
    audio_sample_rate: firstAudio?.sample_rate ?? "",
    audio_channels: firstAudio?.channels !== undefined ? String(firstAudio.channels) : "",
    audio_bit_rate: firstAudio?.bit_rate ?? "",
    audio_stream_count: String(audioStreams.length),
    subtitle_stream_count: String(subtitleStreams.length),
  };
}

export async function getFfprobeVersion(): Promise<string> {
  const { stdout } = await execFileAsync("ffprobe", ["-version"]);
  const match = stdout.match(/ffprobe version (\S+)/);
  return match ? match[1] : "unknown";
}
