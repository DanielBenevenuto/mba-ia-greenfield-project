export interface ByteRange {
  start: number;
  end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single-range `Range` header against an object of `size` bytes.
 *
 * Returns `null` when the header is malformed or unsatisfiable — the caller
 * answers `416`. Returns `undefined` when there is no header at all, meaning
 * "send the whole object with 200".
 *
 * Multi-range requests (`bytes=0-99,200-299`) are deliberately not supported:
 * they require multipart/byteranges responses and no video player issues them.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | null | undefined {
  if (header === undefined || header.trim() === '') return undefined;

  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  // `bytes=-N` — the last N bytes.
  if (rawStart === '') {
    if (rawEnd === '') return null;
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return null;

  // `bytes=N-` — from N to the end.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return null;

  return { start, end };
}

export function formatContentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
