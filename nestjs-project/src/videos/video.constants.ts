export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** Hard ceiling for a single upload: 10 GiB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

/** Offset of the frame captured as the poster image. */
export const THUMBNAIL_TIMESTAMP_SECONDS = 1;
