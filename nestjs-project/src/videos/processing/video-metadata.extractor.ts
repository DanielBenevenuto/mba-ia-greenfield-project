import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../entities/video.entity';

const execFileAsync = promisify(execFile);

/** ffprobe/ffmpeg are given generous time: the input is remote and can be large. */
const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: FfprobeStream[];
}

export class VideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProcessingError';
  }
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Surfaces the tool's own stderr instead of a bare non-zero exit code. */
function toProcessingError(tool: string, err: unknown): VideoProcessingError {
  const e = err as {
    stderr?: Buffer | string;
    message?: string;
    killed?: boolean;
  };
  const stderr =
    typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8');
  const detail = (stderr?.trim() || e.message || 'unknown error').slice(
    0,
    2000,
  );
  const timedOut = e.killed ? ' (timed out)' : '';
  return new VideoProcessingError(`${tool} failed${timedOut}: ${detail}`);
}

/**
 * Wraps `ffprobe` / `ffmpeg` through `execFile` (no shell, so no command
 * injection). The input is a **presigned URL**, not a local path — both tools
 * read it over HTTP with Range requests, so a 10GB source is never downloaded:
 * ffprobe fetches only the headers it needs and ffmpeg only the neighbourhood
 * of the requested frame.
 */
@Injectable()
export class VideoMetadataExtractor {
  async probe(inputUrl: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_OUTPUT_BYTES },
      ));
    } catch (err) {
      throw toProcessingError('ffprobe', err);
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new VideoProcessingError(
        'ffprobe returned output that is not JSON',
      );
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    if (!video) {
      throw new VideoProcessingError('File contains no video stream');
    }

    return {
      durationSeconds: toNumberOrNull(parsed.format?.duration),
      metadata: {
        width: video.width ?? null,
        height: video.height ?? null,
        video_codec: video.codec_name ?? null,
        audio_codec: audio?.codec_name ?? null,
        bitrate: toNumberOrNull(parsed.format?.bit_rate),
        format_name: parsed.format?.format_name ?? null,
      },
    };
  }

  /**
   * Extracts a single frame as JPEG straight to stdout — nothing is written to
   * the worker's filesystem.
   */
  async extractThumbnail(
    inputUrl: string,
    timestampSeconds: number,
  ): Promise<Buffer> {
    const buffer = await this.runThumbnail(inputUrl, timestampSeconds);
    if (buffer.length > 0) return buffer;

    // Seeking past the end of a short clip yields no frame — fall back to the
    // very first one rather than failing the whole job.
    const fallback = await this.runThumbnail(inputUrl, 0);
    if (fallback.length === 0) {
      throw new VideoProcessingError('ffmpeg produced an empty thumbnail');
    }
    return fallback;
  }

  private async runThumbnail(
    inputUrl: string,
    timestampSeconds: number,
  ): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        [
          '-v',
          'error',
          // Input seek: ffmpeg jumps straight to the offset instead of
          // decoding everything before it.
          '-ss',
          String(timestampSeconds),
          '-i',
          inputUrl,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-f',
          'mjpeg',
          'pipe:1',
        ],
        {
          timeout: THUMBNAIL_TIMEOUT_MS,
          maxBuffer: MAX_THUMBNAIL_BYTES,
          encoding: 'buffer',
        },
      );
      return stdout;
    } catch (err) {
      throw toProcessingError('ffmpeg', err);
    }
  }
}
