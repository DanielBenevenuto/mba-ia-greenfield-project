import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { putPart } from '../test/storage-test-utils';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from './video.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Real Postgres + real MinIO. The point of this suite is the side effects that
 * a mocked storage would hide: a multipart session actually open in the object
 * store, and the draft row that points at it.
 */
describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue;
  let service: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = new ChannelsService(dataSource);
    storageService = new StorageService(storageConfig());
    const qc = queueConfig();
    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host: qc.host, port: qc.port },
    });
    service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      queue,
      qc,
    );
  });

  afterAll(async () => {
    await queue.resume().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // Real Redis is shared across runs — start every test from an empty queue.
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { userId: user.id, channelId: channel.id };
  }

  const dto = {
    filename: 'holiday clip.mp4',
    size_bytes: 12 * 1024 * 1024,
    content_type: 'video/mp4',
  };

  describe('startUpload', () => {
    it('should persist the draft with an open upload session', async () => {
      const { userId, channelId } = await createUserWithChannel();

      const result = await service.startUpload(userId, dto);

      const stored = await videoRepository.findOneByOrFail({ id: result.id });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.upload_id).toBe(result.upload.upload_id);
      expect(stored.channel_id).toBe(channelId);
      expect(stored.size_bytes).toBe(dto.size_bytes);
      expect(stored.original_filename).toBe(dto.filename);
      expect(stored.public_id).toMatch(/^[0-9A-Za-z]{11}$/);

      await storageService.abortMultipartUpload(
        stored.storage_key,
        stored.upload_id!,
      );
    }, 30000);

    it('should derive the title from the filename', async () => {
      const { userId } = await createUserWithChannel();

      const result = await service.startUpload(userId, dto);

      expect(result.title).toBe('holiday clip');

      const stored = await videoRepository.findOneByOrFail({ id: result.id });
      await storageService.abortMultipartUpload(
        stored.storage_key,
        stored.upload_id!,
      );
    }, 30000);

    it('should open a multipart session that the storage recognises', async () => {
      const { userId } = await createUserWithChannel();

      const result = await service.startUpload(userId, dto);
      const stored = await videoRepository.findOneByOrFail({ id: result.id });

      // Aborting only succeeds if the session really exists in the object store.
      await expect(
        storageService.abortMultipartUpload(
          stored.storage_key,
          stored.upload_id!,
        ),
      ).resolves.toBeUndefined();
    }, 30000);

    it('should emit one presigned part URL per computed part', async () => {
      const { userId } = await createUserWithChannel();
      const partSize = storageService.partSizeBytes;

      const result = await service.startUpload(userId, {
        ...dto,
        size_bytes: partSize * 2 + 10,
      });

      expect(result.upload.total_parts).toBe(3);
      expect(result.upload.parts).toHaveLength(3);
      expect(result.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      for (const part of result.upload.parts) {
        expect(part.url).toContain('X-Amz-Signature');
      }

      const stored = await videoRepository.findOneByOrFail({ id: result.id });
      await storageService.abortMultipartUpload(
        stored.storage_key,
        stored.upload_id!,
      );
    }, 30000);

    it('should give each video a distinct public_id', async () => {
      const { userId } = await createUserWithChannel();

      const first = await service.startUpload(userId, dto);
      const second = await service.startUpload(userId, dto);

      expect(first.public_id).not.toBe(second.public_id);

      for (const id of [first.id, second.id]) {
        const stored = await videoRepository.findOneByOrFail({ id });
        await storageService.abortMultipartUpload(
          stored.storage_key,
          stored.upload_id!,
        );
      }
    }, 30000);
  });
});

describe('VideosService upload completion (integration)', () => {
  // The suite above owns startUpload; this one drives a real multipart through
  // to completion against MinIO and asserts the job landed in real Redis.
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue;
  let service: VideosService;

  const PART_BYTES = 5 * 1024 * 1024;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = new ChannelsService(dataSource);
    storageService = new StorageService(storageConfig());
    const qc = queueConfig();
    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host: qc.host, port: qc.port },
    });
    service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      queue,
      qc,
    );
  });

  afterAll(async () => {
    await queue.resume().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);
    // The `video-worker` container consumes this very queue. Pausing it keeps
    // the enqueued job observable in `waiting` instead of racing the worker,
    // which would otherwise make these assertions flaky depending on whether
    // the developer has the worker running.
    await queue.pause();
  });

  afterEach(async () => {
    await queue.resume().catch(() => undefined);
  });

  let seq = 0;
  async function startRealUpload(): Promise<{
    userId: string;
    videoId: string;
    uploadId: string;
    parts: { part_number: number; etag: string }[];
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vcomplete_${++seq}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);

    const started = await service.startUpload(user.id, {
      filename: 'clip.mp4',
      size_bytes: PART_BYTES,
      content_type: 'video/mp4',
    });

    const etag = await putPart(
      started.upload.parts[0].url,
      Buffer.alloc(PART_BYTES, 7),
    );

    return {
      userId: user.id,
      videoId: started.id,
      uploadId: started.upload.upload_id,
      parts: [{ part_number: 1, etag }],
    };
  }

  it('should move the video to processing and clear the upload session', async () => {
    const { userId, videoId, uploadId, parts } = await startRealUpload();

    const result = await service.completeUpload(
      userId,
      videoId,
      uploadId,
      parts,
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const stored = await videoRepository.findOneByOrFail({ id: videoId });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.upload_id).toBeNull();

    // The object really exists now, with the full size.
    const head = await storageService.headObject(stored.storage_key);
    expect(head.contentLength).toBe(PART_BYTES);
  }, 120000);

  it('should enqueue a single process-video job on the real queue', async () => {
    const { userId, videoId, uploadId, parts } = await startRealUpload();

    await service.completeUpload(userId, videoId, uploadId, parts);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId });
    expect(jobs[0].opts.attempts).toBe(3);
  }, 120000);

  it('should abort the session, delete the draft and enqueue nothing', async () => {
    const { userId, videoId, uploadId } = await startRealUpload();
    const stored = await videoRepository.findOneByOrFail({ id: videoId });

    await service.abortUpload(userId, videoId, uploadId);

    await expect(
      videoRepository.findOneBy({ id: videoId }),
    ).resolves.toBeNull();

    // Completing an aborted session must now fail at the storage level.
    await expect(
      storageService.completeMultipartUpload(stored.storage_key, uploadId, [
        { part_number: 1, etag: '"x"' },
      ]),
    ).rejects.toThrow();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs).toHaveLength(0);
  }, 120000);
});
