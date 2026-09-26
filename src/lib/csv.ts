import { createReadStream, createWriteStream } from "node:fs";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";

export async function readCsv<T extends object>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true }),
  );
  for await (const record of parser) {
    rows.push(record as T);
  }
  return rows;
}

// Writes a header immediately on construction and appends one row at a
// time as writeRow is called, so the file on disk always reflects
// everything processed so far — a `tail -f` on it during a long run shows
// rows landing live instead of nothing until the whole command finishes.
export class CsvWriter<T extends object> {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private readonly columns: string[];

  constructor(filePath: string, columns: (keyof T)[]) {
    this.columns = columns as string[];
    this.stream = createWriteStream(filePath);
    this.stream.write(stringify([], { header: true, columns: this.columns }));
  }

  writeRow(row: T): void {
    this.stream.write(stringify([row as Record<string, unknown>], { header: false, columns: this.columns }));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.on("error", reject);
      this.stream.end(() => resolve());
    });
  }
}
