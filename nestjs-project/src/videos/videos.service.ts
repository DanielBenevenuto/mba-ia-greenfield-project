import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  NotVideoOwnerException,
  UnsupportedMediaTypeException,
  UploadSessionNotOpenException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import queueConfig from '../config/queue.config';
import {
  StorageService,
  buildSourceKey,
  type CompletedPart,
  type UploadPartUrl,
} from '../storage/storage.service';
import { Video, type VideoMetadata } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { formatContentRange, parseRangeHeader } from './range.util';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from './video.constants';
import type { CreateUploadDto } from './dto/create-upload.dto';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PUBLIC_ID_RETRIES = 5;

export interface PartPlan {
  partSizeBytes: number;
  totalParts: number;
  lastPartBytes: number;
}

export interface ProcessVideoJobData {
  videoId: string;
}

export interface PublicVideoView {
  public_id: string;
  title: string;
  status: VideoStatus;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  metadata: VideoMetadata | null;
  channel: { nickname: string; name: string };
  created_at: Date;
}

export interface StreamTarget {
  body: Readable;
  contentType: string;
  totalBytes: number;
  contentLength: number;
  contentRange: string | null;
  isPartial: boolean;
}

export interface CompleteUploadResult {
  id: string;
  public_id: string;
  status: VideoStatus;
}

export interface StartUploadResult {
  id: string;
  public_id: string;
  title: string;
  status: VideoStatus;
  upload: {
    upload_id: string;
    part_size_bytes: number;
    total_parts: number;
    expires_in_seconds: number;
    parts: UploadPartUrl[];
  };
}

/** Splits a declared file size into the multipart plan the client must follow. */
export function buildPartPlan(
  sizeBytes: number,
  partSizeBytes: number,
): PartPlan {
  const totalParts = Math.max(1, Math.ceil(sizeBytes / partSizeBytes));
  const remainder = sizeBytes % partSizeBytes;

  return {
    partSizeBytes,
    totalParts,
    lastPartBytes:
      remainder === 0 ? Math.min(sizeBytes, partSizeBytes) : remainder,
  };
}

/**
 * Titles are derived from the filename so a draft is never unlabelled; they
 * become editable in Fase 04.
 */
export function deriveTitleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, '');
  const humanized = withoutExtension
    .split(/[\\/]/)
    .pop()!
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return (humanized || 'Untitled video').slice(0, 255);
}

function isUniqueViolation(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly queueSettings: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart session in one
   * operation, returning one presigned URL per part. The file itself never
   * touches this API — the client PUTs the parts straight to storage.
   */
  async startUpload(
    userId: string,
    dto: CreateUploadDto,
  ): Promise<StartUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    if (dto.size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException(MAX_VIDEO_SIZE_BYTES);
    }

    if (
      !ALLOWED_VIDEO_CONTENT_TYPES.includes(
        dto.content_type as (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number],
      )
    ) {
      throw new UnsupportedMediaTypeException(dto.content_type);
    }

    const videoId = randomUUID();
    const storageKey = buildSourceKey(videoId, dto.filename);
    const plan = buildPartPlan(
      dto.size_bytes,
      this.storageService.partSizeBytes,
    );

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.persistDraft(
        videoId,
        channel.id,
        storageKey,
        uploadId,
        dto,
      );
    } catch (err) {
      // Compensate: a draft that could not be persisted must not leave an
      // orphan multipart session holding storage space.
      await this.storageService
        .abortMultipartUpload(storageKey, uploadId)
        .catch(() => undefined);
      throw err;
    }

    const parts = await this.storageService.presignUploadPartUrls(
      storageKey,
      uploadId,
      plan.totalParts,
    );

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      upload: {
        upload_id: uploadId,
        part_size_bytes: plan.partSizeBytes,
        total_parts: plan.totalParts,
        expires_in_seconds: this.storageService.uploadUrlExpirationSeconds,
        parts,
      },
    };
  }

  /**
   * Closes the multipart session, flips the video to `processing` and enqueues
   * the job the worker consumes. The job carries only the id — the consumer
   * re-reads the row, which keeps the message small and the job idempotent.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompleteUploadResult> {
    const video = await this.loadOwnedVideo(userId, videoId);

    if (!video.upload_id || video.upload_id !== uploadId) {
      throw new UploadSessionNotOpenException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      uploadId,
      parts,
    );

    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    video.processing_error = null;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      {
        attempts: this.queueSettings.videoProcessingAttempts,
        backoff: {
          type: 'exponential',
          delay: this.queueSettings.videoProcessingBackoffMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      },
    );

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }

  /** Aborts the multipart session and discards the draft. */
  async abortUpload(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<void> {
    const video = await this.loadOwnedVideo(userId, videoId);

    if (!video.upload_id || video.upload_id !== uploadId) {
      throw new UploadSessionNotOpenException();
    }

    await this.storageService.abortMultipartUpload(video.storage_key, uploadId);
    await this.videoRepository.remove(video);
  }

  /**
   * Resolves a video by its public URL identifier, applying the visibility rule
   * from the Authorization Matrix: to anyone who is not the owning channel, a
   * video that is not `ready` is indistinguishable from one that does not exist.
   */
  async findByPublicId(
    publicId: string,
    requesterUserId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();

    if (video.status === VideoStatus.READY) return video;

    const channel = requesterUserId
      ? await this.channelsService.findByUserId(requesterUserId)
      : null;

    // Not the owner → do not leak that the video exists at all.
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async getPublicVideo(
    publicId: string,
    requesterUserId?: string,
  ): Promise<PublicVideoView> {
    const video = await this.findByPublicId(publicId, requesterUserId);

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: video.thumbnail_key
        ? await this.storageService.presignPublicReadUrl(video.thumbnail_key)
        : null,
      metadata: video.metadata,
      channel: {
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      created_at: video.created_at,
    };
  }

  /**
   * Opens a byte range on the source object. The caller pipes the returned
   * stream straight to the HTTP response, so memory stays bounded no matter how
   * large the video is.
   */
  async openStream(
    publicId: string,
    rangeHeader: string | undefined,
    requesterUserId?: string,
  ): Promise<StreamTarget> {
    const video = await this.requireReadyVideo(publicId, requesterUserId);

    const head = await this.storageService.headObject(video.storage_key);
    const range = parseRangeHeader(rangeHeader, head.contentLength);
    if (range === null) throw new InvalidRangeException();

    const result = await this.storageService.getObjectRange(
      video.storage_key,
      range ? `bytes=${range.start}-${range.end}` : undefined,
    );

    return {
      body: result.body,
      contentType: video.content_type || result.contentType,
      totalBytes: head.contentLength,
      contentLength: result.contentLength,
      contentRange: range
        ? formatContentRange(range, head.contentLength)
        : null,
      isPartial: range !== undefined,
    };
  }

  /** Short-lived, attachment-forcing URL; the bytes never pass through the API. */
  async getDownloadUrl(
    publicId: string,
    requesterUserId?: string,
  ): Promise<string> {
    const video = await this.requireReadyVideo(publicId, requesterUserId);

    return this.storageService.presignDownloadUrl(
      video.storage_key,
      video.original_filename,
      video.content_type,
    );
  }

  private async requireReadyVideo(
    publicId: string,
    requesterUserId?: string,
  ): Promise<Video> {
    const video = await this.findByPublicId(publicId, requesterUserId);
    // Reaching here with a non-ready video means the caller IS the owner —
    // findByPublicId already 404s for everyone else.
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return video;
  }

  private async loadOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();
    if (video.channel_id !== channel.id) throw new NotVideoOwnerException();

    return video;
  }

  private async persistDraft(
    videoId: string,
    channelId: string,
    storageKey: string,
    uploadId: string,
    dto: CreateUploadDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: videoId,
            public_id: generatePublicId(),
            channel_id: channelId,
            title: deriveTitleFromFilename(dto.filename),
            status: VideoStatus.DRAFT,
            original_filename: dto.filename,
            content_type: dto.content_type,
            size_bytes: dto.size_bytes,
            storage_key: storageKey,
            upload_id: uploadId,
          }),
        );
      } catch (err) {
        // 62^11 makes this practically unreachable, but the unique index is the
        // real guarantee of "never conflicts" — so honour it instead of trusting
        // the odds.
        if (!isUniqueViolation(err, 'public_id')) throw err;
      }
    }

    throw new Error('Could not allocate a unique public_id for the video');
  }
}
