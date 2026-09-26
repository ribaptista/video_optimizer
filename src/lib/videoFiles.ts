import { readdir } from "node:fs/promises";
import path from "node:path";

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".mov",
  ".avi",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".3gp",
  ".vob",
  ".ogv",
]);

export async function findVideoFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}
