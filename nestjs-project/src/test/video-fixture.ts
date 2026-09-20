import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoFixture {
  buffer: Buffer;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Generates a small, deterministic mp4 with ffmpeg's `testsrc` source instead of
 * committing a binary to the repository. Produced in a temp dir that is removed
 * before the function returns — the caller only gets the bytes.
 */
export async function createVideoFixture(
  durationSeconds = 3,
  width = 320,
  height = 240,
): Promise<VideoFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const path = join(dir, 'fixture.mp4');

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=15`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        // `+faststart` moves the moov atom to the front so a player (and
        // ffprobe over HTTP) can read metadata without fetching the whole file.
        '-movflags',
        '+faststart',
        '-y',
        path,
      ],
      { timeout: 60_000 },
    );

    return {
      buffer: await readFile(path),
      durationSeconds,
      width,
      height,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
