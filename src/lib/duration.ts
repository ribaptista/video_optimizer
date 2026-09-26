// Parses a duration like "5s", "90", "1m30s", or "1h" into seconds. A bare
// number is treated as seconds. Used for --sample.
export function parseDurationSeconds(input: string): number {
  const trimmed = input.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error(
      `invalid duration "${input}" — use a plain number of seconds (e.g. "5"), or a combination like "5s", "1m30s", "1h"`,
    );
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}
