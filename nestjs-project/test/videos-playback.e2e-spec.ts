import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putPart } from '../src/test/storage-test-utils';
import { createVideoFixture } from '../src/test/video-fixture';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VideoMetadataExtractor } from '../src/videos/processing/video-metadata.extractor';
import { VideoProcessor } from '../src/videos/processing/video.processor';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from '../src/videos/video.constants';

/**
 * Covers the public playback surface end to end: metadata by public URL,
 * streaming with Range/206 and the download redirect. A real video is uploaded
 * and processed so the assertions run against genuine bytes in MinIO.
 */
describe('Videos playback (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let processor: VideoProcessor;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let fixture: Awaited<ReturnType<typeof createVideoFixture>>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    const qc = queueConfig();
    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host: qc.host, port: qc.port },
    });
    // The `video-worker` container consumes this queue. Pausing it for the
    // duration of the suite keeps the tests deterministic: the worker cannot
    // process (or race the cleanup of) rows these tests create.
    await queue.pause();
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    // The API process does not host the processor (the worker container does),
    // so the spec instantiates it directly to drive a video to `ready` instead
    // of racing the worker container for the job.
    processor = new VideoProcessor(
      videoRepository,
      moduleFixture.get(StorageService),
      new VideoMetadataExtractor(),
    );

    fixture = await createVideoFixture(3, 320, 240);
  }, 180000);

  afterAll(async () => {
    await queue.resume().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let seq = 0;
  async function loginAs(): Promise<string> {
    const email = `player_${++seq}_${Date.now()}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;

    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return res.body.access_token as string;
  }

  /** Uploads the fixture and runs the processor, returning a ready video. */
  async function publishVideo(
    accessToken: string,
  ): Promise<{ publicId: string; id: string; sizeBytes: number }> {
    const started = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'playback fixture.mp4',
        size_bytes: fixture.buffer.length,
        content_type: 'video/mp4',
      })
      .expect(201);

    const etag = await putPart(
      started.body.upload.parts[0].url,
      fixture.buffer,
    );

    await request(app.getHttpServer())
      .post(
        `/videos/${started.body.id}/uploads/${started.body.upload.upload_id}/complete`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    await processor.process({
      data: { videoId: started.body.id },
    } as never);

    return {
      publicId: started.body.public_id as string,
      id: started.body.id as string,
      sizeBytes: fixture.buffer.length,
    };
  }

  async function createDraft(accessToken: string): Promise<string> {
    const started = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'draft.mp4',
        size_bytes: 4096,
        content_type: 'video/mp4',
      })
      .expect(201);

    return started.body.public_id as string;
  }

  describe('GET /videos/:publicId', () => {
    it('returns 200 to an anonymous caller for a ready video', async () => {
      const token = await loginAs();
      const { publicId } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect(res.body.public_id).toBe(publicId);
      expect(res.body.status).toBe('ready');
      expect(res.body.title).toBe('playback fixture');
      expect(Number(res.body.duration_seconds)).toBeGreaterThan(2.9);
      expect(res.body.thumbnail_url).toContain('X-Amz-Signature');
      expect(res.body.channel.nickname).toBeDefined();
    }, 180000);

    it('returns 404 to an anonymous caller for a draft video', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }, 60000);

    it('lets the owning channel see its own draft', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.status).toBe('draft');
    }, 60000);

    it('returns 404 for an unknown public id', async () => {
      await request(app.getHttpServer()).get('/videos/zzzzzzzzzzz').expect(404);
    }, 30000);
  });

  describe('GET /videos/:publicId/stream', () => {
    it('returns 206 with Content-Range and exactly the requested bytes', async () => {
      const token = await loginAs();
      const { publicId, sizeBytes } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-1023/${sizeBytes}`);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe('1024');
      expect(res.body.length).toBe(1024);
    }, 180000);

    it('serves a range from the middle of the file', async () => {
      const token = await loginAs();
      const { publicId, sizeBytes } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=1000-1999')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 1000-1999/${sizeBytes}`);
      expect(res.body.length).toBe(1000);
      expect(
        Buffer.from(res.body).equals(fixture.buffer.subarray(1000, 2000)),
      ).toBe(true);
    }, 180000);

    it('returns 200 with the whole file when no Range is sent', async () => {
      const token = await loginAs();
      const { publicId, sizeBytes } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(sizeBytes));
      expect(res.headers['content-range']).toBeUndefined();
    }, 180000);

    it('returns 416 INVALID_RANGE for an unsatisfiable range', async () => {
      const token = await loginAs();
      const { publicId } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=999999999999-')
        .expect(416);

      expect(res.body.error).toBe('INVALID_RANGE');
    }, 180000);

    it('returns 409 VIDEO_NOT_READY when the owner streams a draft', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    }, 60000);

    it('returns 404 when an anonymous caller streams a draft', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }, 60000);
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns 302 to a presigned URL that forces an attachment', async () => {
      const token = await loginAs();
      const { publicId } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('X-Amz-Signature');
      expect(location).toContain('response-content-disposition');
      expect(decodeURIComponent(location)).toContain('attachment');
      expect(decodeURIComponent(location)).toContain('playback_fixture.mp4');
    }, 180000);

    it('returns 404 when an anonymous caller downloads a draft', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(404);
    }, 60000);

    it('returns 409 when the owner downloads a video that is not ready', async () => {
      const token = await loginAs();
      const publicId = await createDraft(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    }, 60000);
  });

  it('keeps the video status lifecycle observable in the database', async () => {
    const token = await loginAs();
    const { id } = await publishVideo(token);

    const stored = await videoRepository.findOneByOrFail({ id });
    expect(stored.status).toBe(VideoStatus.READY);
    expect(stored.thumbnail_key).toBe(`thumbnails/${id}/poster.jpg`);
  }, 180000);
});
