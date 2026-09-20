import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  /** Total attempts per video-processing job (1 initial + retries). */
  videoProcessingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  /** Base delay of the exponential backoff: 2 ^ (attempt - 1) * delay. */
  videoProcessingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
}));
