export interface ScanRow {
  file_path: string;
  file_name: string;
  file_size_bytes: string;
  container_format: string;
  duration_seconds: string;
  overall_bit_rate: string;
  video_codec: string;
  video_profile: string;
  pix_fmt: string;
  bit_depth: string;
  chroma_subsampling: string;
  width: string;
  height: string;
  frame_rate: string;
  video_bit_rate: string;
  color_primaries: string;
  color_transfer: string;
  color_space: string;
  rotation: string;
  audio_codec: string;
  audio_is_pcm: string;
  audio_sample_rate: string;
  audio_channels: string;
  audio_bit_rate: string;
  audio_stream_count: string;
  subtitle_stream_count: string;
  scan_result: "ok" | "error";
  scan_error: string;
}

export const SCAN_COLUMNS: (keyof ScanRow)[] = [
  "file_path",
  "file_name",
  "file_size_bytes",
  "container_format",
  "duration_seconds",
  "overall_bit_rate",
  "video_codec",
  "video_profile",
  "pix_fmt",
  "bit_depth",
  "chroma_subsampling",
  "width",
  "height",
  "frame_rate",
  "video_bit_rate",
  "color_primaries",
  "color_transfer",
  "color_space",
  "rotation",
  "audio_codec",
  "audio_is_pcm",
  "audio_sample_rate",
  "audio_channels",
  "audio_bit_rate",
  "audio_stream_count",
  "subtitle_stream_count",
  "scan_result",
  "scan_error",
];

export interface ReencodeRow extends ScanRow {
  output_file_path: string;
  output_file_size_bytes: string;
  size_optimization_pct: string;
  profile_id: string;
  ffmpeg_command: string;
  reencode_result: "ok" | "error" | "skip_size" | "skip_scan_error";
  reencode_error: string;
}

export const REENCODE_COLUMNS: (keyof ReencodeRow)[] = [
  ...SCAN_COLUMNS,
  "output_file_path",
  "output_file_size_bytes",
  "size_optimization_pct",
  "profile_id",
  "ffmpeg_command",
  "reencode_result",
  "reencode_error",
];

export interface FinalizeRow extends ReencodeRow {
  finalize_action: "deleted" | "promoted" | "skip_not_encoded" | "error";
  finalize_error: string;
  original_archived: "true" | "false";
}

export const FINALIZE_COLUMNS: (keyof FinalizeRow)[] = [
  ...REENCODE_COLUMNS,
  "finalize_action",
  "finalize_error",
  "original_archived",
];
