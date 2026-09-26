import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";

export async function readCsv<T extends Record<string, string>>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true }),
  );
  for await (const record of parser) {
    rows.push(record as T);
  }
  return rows;
}

export async function writeCsv<T extends object>(
  filePath: string,
  columns: (keyof T)[],
  rows: T[],
): Promise<void> {
  const csv = stringify(rows as Record<string, unknown>[], {
    header: true,
    columns: columns as string[],
  });
  await writeFile(filePath, csv);
}
