import { randomBytes } from 'node:crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PUBLIC_ID_LENGTH = 11;

/**
 * Short, URL-safe, non-guessable identifier used as the public URL of a video.
 *
 * 62^11 ≈ 5.2e19 possibilities, so collisions are negligible; the unique index
 * on `videos.public_id` is the actual guarantee of "never conflicts".
 *
 * Bytes are rejected instead of taken modulo 62 when they fall in the last,
 * incomplete block of the 0-255 range — modulo would bias the first
 * `256 % 62 = 8` symbols of the alphabet.
 */
export function generatePublicId(length = PUBLIC_ID_LENGTH): string {
  const maxUnbiased = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let id = '';

  while (id.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte >= maxUnbiased) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === length) break;
    }
  }

  return id;
}
