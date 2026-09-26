import { getFfprobeVersion } from "./ffprobe.js";
import { PINNED_FFMPEG_VERSION } from "../profile.js";

export async function warnIfVersionMismatch(): Promise<void> {
  try {
    const version = await getFfprobeVersion();
    if (version !== PINNED_FFMPEG_VERSION) {
      console.warn(
        `[warn] ffprobe version ${version} differs from the pinned version ${PINNED_FFMPEG_VERSION} this profile was designed against. Metadata fields may differ.`,
      );
    }
  } catch {
    console.warn("[warn] could not determine ffprobe version");
  }
}
