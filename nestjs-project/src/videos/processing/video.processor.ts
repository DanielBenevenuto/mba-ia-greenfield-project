import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import {
  StorageService,
  buildThumbnailKey,
} from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import {
  THUMBNAIL_TIMESTAMP_SECONDS,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from '../video.constants';
import type { ProcessVideoJobData } from '../videos.service';
import { VideoMetadataExtractor } from './video-metadata.extractor';

/** Long enough for ffmpeg to finish reading the source through the URL. */
const SOURCE_URL_TTL_SECONDS = 3600;
const MAX_PERSISTED_ERROR_LENGTH = 1000;

/**
 * Consumes `video-processing` jobs. Runs in the dedicated `video-worker`
 * container, never inside the API process — a long ffmpeg run must not compete
 * with the event loop serving HTTP.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly extractor: VideoMetadataExtractor,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    // A job for a video that no longer exists, or that is not awaiting
    // processing, is a no-op. This is what makes redelivery safe: the payload
    // carries only the id and the state of record lives in the database.
    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists; skipping job`);
      return;
    }
    if (video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Video ${videoId} is ${video.status}, not processing; skipping job`,
      );
      return;
    }

    // Presigned URL as ffmpeg's input: the source is read over HTTP with Range
    // requests, so even a 10GB file never lands on this container's disk.
    const sourceUrl = await this.storageService.presignReadUrl(
      video.storage_key,
      SOURCE_URL_TTL_SECONDS,
    );

    const { durationSeconds, metadata } = await this.extractor.probe(sourceUrl);
    const thumbnail = await this.extractor.extractThumbnail(
      sourceUrl,
      THUMBNAIL_TIMESTAMP_SECONDS,
    );

    const thumbnailKey = buildThumbnailKey(video.id);
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    video.duration_seconds = durationSeconds;
    video.metadata = metadata;
    video.thumbnail_key = thumbnailKey;
    video.status = VideoStatus.READY;
    video.processing_error = null;
    await this.videoRepository.save(video);

    this.logger.log(`Video ${videoId} is ready (${durationSeconds}s)`);
  }

  /**
   * Fires on every failed attempt. Only the **last** one flips the video to
   * `failed` — earlier failures are transient and BullMQ will retry them with
   * the configured exponential backoff.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Video ${job.data?.videoId} attempt ${job.attemptsMade}/${maxAttempts} failed: ${err.message}`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data?.videoId} failed after ${job.attemptsMade} attempts: ${err.message}`,
    );

    // Background handler: log and record, never rethrow — a throw here would
    // take the worker process down.
    try {
      await this.videoRepository.update(
        { id: job.data.videoId },
        {
          status: VideoStatus.FAILED,
          processing_error: err.message.slice(0, MAX_PERSISTED_ERROR_LENGTH),
        },
      );
    } catch (updateError) {
      this.logger.error(
        `Could not persist failure for video ${job.data?.videoId}`,
        updateError as Error,
      );
    }
  }
}
