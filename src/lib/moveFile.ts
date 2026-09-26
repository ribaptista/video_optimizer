import { rename, copyFile, unlink } from "node:fs/promises";

export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      await copyFile(src, dest);
      await unlink(src);
      return;
    }
    throw err;
  }
}
