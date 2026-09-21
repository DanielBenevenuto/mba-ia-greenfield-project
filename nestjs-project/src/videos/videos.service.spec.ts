import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  NotVideoOwnerException,
  UnsupportedMediaTypeException,
  UploadSessionNotOpenException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  MAX_VIDEO_SIZE_BYTES,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from './video.constants';
import {
  VideosService,
  buildPartPlan,
  deriveTitleFromFilename,
} from './videos.service';

const PART_SIZE = 64 * 1024 * 1024;

describe('buildPartPlan', () => {
  it('should split the 10 GiB ceiling into ceil(size / partSize) parts', () => {
    const plan = buildPartPlan(MAX_VIDEO_SIZE_BYTES, PART_SIZE);

    expect(plan.totalParts).toBe(Math.ceil(MAX_VIDEO_SIZE_BYTES / PART_SIZE));
    expect(plan.totalParts).toBe(160);
  });

  it('should stay far below the 10000-part ceiling imposed by S3', () => {
    expect(
      buildPartPlan(MAX_VIDEO_SIZE_BYTES, PART_SIZE).totalParts,
    ).toBeLessThan(10_000);
  });

  it('should produce a single part for a file smaller than one part', () => {
    const plan = buildPartPlan(1024, PART_SIZE);

    expect(plan.totalParts).toBe(1);
    expect(plan.lastPartBytes).toBe(1024);
  });

  it('should compute the remainder as the last part size', () => {
    const plan = buildPartPlan(PART_SIZE + 500, PART_SIZE);

    expect(plan.totalParts).toBe(2);
    expect(plan.lastPartBytes).toBe(500);
  });

  it('should make the last part a full part when the size divides exactly', () => {
    const plan = buildPartPlan(PART_SIZE * 3, PART_SIZE);

    expect(plan.totalParts).toBe(3);
    expect(plan.lastPartBytes).toBe(PART_SIZE);
  });
});

describe('deriveTitleFromFilename', () => {
  it('should drop the extension and humanize separators', () => {
    expect(deriveTitleFromFilename('my_holiday-video.mp4')).toBe(
      'my holiday video',
    );
  });

  it('should fall back to a placeholder when nothing remains', () => {
    expect(deriveTitleFromFilename('.mp4')).toBe('Untitled video');
  });

  it('should cap the title at the column limit', () => {
    expect(deriveTitleFromFilename(`${'a'.repeat(400)}.mp4`)).toHaveLength(255);
  });
});

describe('VideosService.startUpload', () => {
  let service: VideosService;
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    partSizeBytes: number;
    uploadUrlExpirationSeconds: number;
    createMultipartUpload: jest.Mock;
    presignUploadPartUrls: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let repository: { create: jest.Mock; save: jest.Mock };
  let queue: { add: jest.Mock };

  const dto = {
    filename: 'holiday.mp4',
    size_bytes: 1024,
    content_type: 'video/mp4',
  };

  beforeEach(async () => {
    channelsService = { findByUserId: jest.fn() };
    storageService = {
      partSizeBytes: PART_SIZE,
      uploadUrlExpirationSeconds: 3600,
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      presignUploadPartUrls: jest
        .fn()
        .mockResolvedValue([{ part_number: 1, url: 'https://signed/1' }]),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    repository = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) => Promise.resolve(v)),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        {
          provide: queueConfig.KEY,
          useValue: {
            host: 'redis',
            port: 6379,
            videoProcessingAttempts: 3,
            videoProcessingBackoffMs: 5000,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('should reject a user without a channel before touching storage', async () => {
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.startUpload('user-1', dto)).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject a file above the 10 GiB ceiling before touching storage', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    await expect(
      service.startUpload('user-1', {
        ...dto,
        size_bytes: MAX_VIDEO_SIZE_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('should accept a file exactly at the 10 GiB ceiling', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    await expect(
      service.startUpload('user-1', {
        ...dto,
        size_bytes: MAX_VIDEO_SIZE_BYTES,
      }),
    ).resolves.toBeDefined();
  });

  it('should reject a content type outside the video allowlist', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    await expect(
      service.startUpload('user-1', {
        ...dto,
        content_type: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should abort the multipart session when persisting the draft fails', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    repository.save.mockRejectedValue(new Error('db down'));

    await expect(service.startUpload('user-1', dto)).rejects.toThrow('db down');
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      expect.stringContaining('/source/holiday.mp4'),
      'upload-id',
    );
  });

  it('should return the draft with one presigned URL per part', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });

    const result = await service.startUpload('user-1', dto);

    expect(result.status).toBe('draft');
    expect(result.title).toBe('holiday');
    expect(result.upload.upload_id).toBe('upload-id');
    expect(result.upload.total_parts).toBe(1);
    expect(result.upload.parts).toHaveLength(1);
    expect(storageService.presignUploadPartUrls).toHaveBeenCalledWith(
      expect.stringContaining('/source/holiday.mp4'),
      'upload-id',
      1,
    );
  });
});

describe('VideosService.completeUpload / abortUpload', () => {
  let service: VideosService;
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    partSizeBytes: number;
    uploadUrlExpirationSeconds: number;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let repository: {
    findOne: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    create: jest.Mock;
  };
  let queue: { add: jest.Mock };

  const parts = [{ part_number: 1, etag: '"etag-1"' }];

  function draft(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      public_id: 'aaaaaaaaaaa',
      channel_id: 'channel-1',
      storage_key: 'videos/video-1/source/a.mp4',
      upload_id: 'upload-id',
      status: VideoStatus.DRAFT,
      processing_error: null,
      ...overrides,
    } as Video;
  }

  beforeEach(async () => {
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storageService = {
      partSizeBytes: PART_SIZE,
      uploadUrlExpirationSeconds: 3600,
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    repository = {
      findOne: jest.fn(),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      remove: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        {
          provide: queueConfig.KEY,
          useValue: {
            host: 'redis',
            port: 6379,
            videoProcessingAttempts: 3,
            videoProcessingBackoffMs: 5000,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('should reject completing a video that does not exist', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.completeUpload('user-1', 'missing', 'upload-id', parts),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject completing a video owned by another channel', async () => {
    repository.findOne.mockResolvedValue(
      draft({ channel_id: 'other-channel' }),
    );

    await expect(
      service.completeUpload('user-1', 'video-1', 'upload-id', parts),
    ).rejects.toBeInstanceOf(NotVideoOwnerException);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject completing when no session is open', async () => {
    repository.findOne.mockResolvedValue(draft({ upload_id: null }));

    await expect(
      service.completeUpload('user-1', 'video-1', 'upload-id', parts),
    ).rejects.toBeInstanceOf(UploadSessionNotOpenException);
  });

  it('should reject completing when the upload id does not match the record', async () => {
    repository.findOne.mockResolvedValue(draft({ upload_id: 'another-id' }));

    await expect(
      service.completeUpload('user-1', 'video-1', 'upload-id', parts),
    ).rejects.toBeInstanceOf(UploadSessionNotOpenException);
  });

  it('should move the video to processing and clear the upload session', async () => {
    repository.findOne.mockResolvedValue(draft());

    const result = await service.completeUpload(
      'user-1',
      'video-1',
      'upload-id',
      parts,
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const saved = repository.save.mock.calls[0][0] as Video;
    expect(saved.status).toBe(VideoStatus.PROCESSING);
    expect(saved.upload_id).toBeNull();
  });

  it('should enqueue exactly one process-video job carrying only the video id', async () => {
    repository.findOne.mockResolvedValue(draft());

    await service.completeUpload('user-1', 'video-1', 'upload-id', parts);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, options] = queue.add.mock.calls[0];
    expect(jobName).toBe(PROCESS_VIDEO_JOB);
    expect(payload).toEqual({ videoId: 'video-1' });
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should abort the session and delete the draft', async () => {
    const video = draft();
    repository.findOne.mockResolvedValue(video);

    await service.abortUpload('user-1', 'video-1', 'upload-id');

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      video.storage_key,
      'upload-id',
    );
    expect(repository.remove).toHaveBeenCalledWith(video);
  });

  it('should not delete anything when aborting a video of another channel', async () => {
    repository.findOne.mockResolvedValue(
      draft({ channel_id: 'other-channel' }),
    );

    await expect(
      service.abortUpload('user-1', 'video-1', 'upload-id'),
    ).rejects.toBeInstanceOf(NotVideoOwnerException);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
  });
});
