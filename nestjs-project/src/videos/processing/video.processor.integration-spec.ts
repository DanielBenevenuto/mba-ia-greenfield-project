import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { ChannelsService } from '../../channels/channels.service';
import storageConfig from '../../config/storage.config';
import { StorageService, buildSourceKey } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { createVideoFixture } from '../../test/video-fixture';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video.constants';
import type { ProcessVideoJobData } from '../videos.service';
import { VideoMetadataExtractor } from './video-metadata.extractor';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Drives the processor against real Postgres, real MinIO and real ffmpeg. The
 * BullMQ `Job` is stubbed to the two fields the processor reads (`data` and,
 * for the failure path, the retry bookkeeping) — the queue transport itself is
 * covered by the VideosService integration suite.
 */
describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let storage: StorageService;
  let processor: VideoProcessor;
  let fixture: Awaited<ReturnType<typeof createVideoFixture>>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = new ChannelsService(dataSource);
    storage = new StorageService(storageConfig());
    processor = new VideoProcessor(
      videoRepository,
      storage,
      new VideoMetadataExtractor(),
    );
    fixture = await createVideoFixture(3, 320, 240);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  function jobFor(
    videoId: string,
    attemptsMade = 1,
    attempts = 3,
  ): Job<ProcessVideoJobData> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts },
    } as unknown as Job<ProcessVideoJobData>;
  }

  let seq = 0;
  async function seedVideo(options: {
    uploadSource: boolean;
    status?: VideoStatus;
  }): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `proc_${++seq}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const videoId = randomUUID();
    const storageKey = buildSourceKey(videoId, 'fixture.mp4');

    if (options.uploadSource) {
      await storage.putObject(storageKey, fixture.buffer, 'video/mp4');
    }

    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        public_id: `p${String(seq).padStart(10, '0')}`,
        channel_id: channel.id,
        title: 'fixture',
        status: options.status ?? VideoStatus.PROCESSING,
        original_filename: 'fixture.mp4',
        content_type: 'video/mp4',
        size_bytes: fixture.buffer.length,
        storage_key: storageKey,
        upload_id: null,
      }),
    );
  }

  it('should take a processing video to ready with duration, metadata and thumbnail', async () => {
    const video = await seedVideo({ uploadSource: true });

    await processor.process(jobFor(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThan(2.9);
    expect(updated.duration_seconds).toBeLessThan(3.2);
    expect(updated.metadata).toEqual(
      expect.objectContaining({
        width: 320,
        height: 240,
        video_codec: 'h264',
      }),
    );
    expect(updated.thumbnail_key).toBe(`thumbnails/${video.id}/poster.jpg`);
    expect(updated.processing_error).toBeNull();
  }, 120000);

  it('should write the thumbnail object to storage', async () => {
    const video = await seedVideo({ uploadSource: true });

    await processor.process(jobFor(video.id));

    const head = await storage.headObject(`thumbnails/${video.id}/poster.jpg`);
    expect(head.contentLength).toBeGreaterThan(0);
    expect(head.contentType).toBe('image/jpeg');
  }, 120000);

  it('should leave a video that is not processing untouched (idempotent redelivery)', async () => {
    const video = await seedVideo({
      uploadSource: true,
      status: VideoStatus.READY,
    });

    await processor.process(jobFor(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.duration_seconds).toBeNull();
    expect(updated.thumbnail_key).toBeNull();
    expect(updated.status).toBe(VideoStatus.READY);
  }, 60000);

  it('should be a no-op when the video row no longer exists', async () => {
    await expect(
      processor.process(jobFor(randomUUID())),
    ).resolves.toBeUndefined();
  }, 60000);

  it('should raise when the source object cannot be read', async () => {
    const video = await seedVideo({ uploadSource: false });

    await expect(processor.process(jobFor(video.id))).rejects.toThrow(
      /ffprobe failed/,
    );

    // Still processing: earlier attempts must not mark the video failed.
    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.PROCESSING);
  }, 120000);

  describe('onFailed', () => {
    it('should keep the video processing while retries remain', async () => {
      const video = await seedVideo({ uploadSource: false });

      await processor.onFailed(
        jobFor(video.id, 1, 3),
        new Error('transient storage error'),
      );

      const updated = await videoRepository.findOneByOrFail({ id: video.id });
      expect(updated.status).toBe(VideoStatus.PROCESSING);
      expect(updated.processing_error).toBeNull();
    }, 60000);

    it('should mark the video failed with the error on the last attempt', async () => {
      const video = await seedVideo({ uploadSource: false });

      await processor.onFailed(
        jobFor(video.id, 3, 3),
        new Error('ffprobe failed: no such file'),
      );

      const updated = await videoRepository.findOneByOrFail({ id: video.id });
      expect(updated.status).toBe(VideoStatus.FAILED);
      expect(updated.processing_error).toContain('ffprobe failed');
    }, 60000);

    it('should truncate a very long error message to fit the column', async () => {
      const video = await seedVideo({ uploadSource: false });

      await processor.onFailed(
        jobFor(video.id, 3, 3),
        new Error('x'.repeat(5000)),
      );

      const updated = await videoRepository.findOneByOrFail({ id: video.id });
      expect(updated.processing_error!.length).toBeLessThanOrEqual(1000);
    }, 60000);
  });
});
