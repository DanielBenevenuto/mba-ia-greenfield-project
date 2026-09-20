import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putPart } from '../src/test/storage-test-utils';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
} from '../src/videos/video.constants';

/**
 * Drives the full upload handshake over HTTP against the real MinIO and Redis
 * from `compose.yaml`: pre-register → PUT parts straight to storage → complete.
 */
describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

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
    const email = `uploader_${++seq}_${Date.now()}@example.com`;
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

  const validBody = {
    filename: 'trip.mp4',
    size_bytes: 2048,
    content_type: 'video/mp4',
  };

  describe('POST /videos/uploads', () => {
    it('returns 201 with the draft and one presigned URL per part', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);

      expect(res.body.status).toBe('draft');
      expect(res.body.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(res.body.title).toBe('trip');
      expect(res.body.upload.total_parts).toBe(1);
      expect(res.body.upload.parts).toHaveLength(1);
      expect(res.body.upload.parts[0].part_number).toBe(1);
      expect(res.body.upload.parts[0].url).toContain('X-Amz-Signature');
      expect(res.body.upload.upload_id).toBeDefined();
    }, 60000);

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send(validBody)
        .expect(401);
    }, 30000);

    it('returns 400 when the body fails validation', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: '', size_bytes: 0 })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    }, 30000);

    it('returns 413 VIDEO_TOO_LARGE above the 10 GiB ceiling', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, size_bytes: MAX_VIDEO_SIZE_BYTES + 1 })
        .expect(413);

      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    }, 30000);

    it('returns 415 UNSUPPORTED_MEDIA_TYPE for a non-video content type', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, content_type: 'application/pdf' })
        .expect(415);

      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    }, 30000);

    it('accepts a declared size of exactly 10 GiB and plans every part', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, size_bytes: MAX_VIDEO_SIZE_BYTES })
        .expect(201);

      expect(res.body.upload.total_parts).toBe(
        Math.ceil(MAX_VIDEO_SIZE_BYTES / res.body.upload.part_size_bytes),
      );
      expect(res.body.upload.parts).toHaveLength(res.body.upload.total_parts);
    }, 60000);
  });

  describe('POST /videos/:id/uploads/:uploadId/complete', () => {
    async function startAndUpload(accessToken: string) {
      const started = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);

      const etag = await putPart(
        started.body.upload.parts[0].url,
        Buffer.alloc(validBody.size_bytes, 9),
      );

      return {
        id: started.body.id as string,
        uploadId: started.body.upload.upload_id as string,
        parts: [{ part_number: 1, etag }],
      };
    }

    it('returns 200 with status processing after the parts are uploaded', async () => {
      const accessToken = await loginAs();
      const { id, uploadId, parts } = await startAndUpload(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      expect(res.body.status).toBe('processing');
      expect(res.body.id).toBe(id);
    }, 60000);

    it('returns 403 NOT_VIDEO_OWNER for a user from another channel', async () => {
      const owner = await loginAs();
      const { id, uploadId, parts } = await startAndUpload(owner);
      const intruder = await loginAs();

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ parts })
        .expect(403);

      expect(res.body.error).toBe('NOT_VIDEO_OWNER');
    }, 60000);

    it('returns 409 UPLOAD_SESSION_NOT_OPEN when completing twice', async () => {
      const accessToken = await loginAs();
      const { id, uploadId, parts } = await startAndUpload(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${id}/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(409);

      expect(res.body.error).toBe('UPLOAD_SESSION_NOT_OPEN');
    }, 60000);

    it('returns 404 VIDEO_NOT_FOUND for an unknown video id', async () => {
      const accessToken = await loginAs();

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/uploads/x/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }, 30000);

    it('returns 400 when parts is empty', async () => {
      const accessToken = await loginAs();
      const { id, uploadId } = await startAndUpload(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${id}/uploads/${uploadId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [] })
        .expect(400);
    }, 60000);
  });

  describe('DELETE /videos/:id/uploads/:uploadId', () => {
    it('returns 204 and removes the draft', async () => {
      const accessToken = await loginAs();
      const started = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);

      await request(app.getHttpServer())
        .delete(
          `/videos/${started.body.id}/uploads/${started.body.upload.upload_id}`,
        )
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const rows = await dataSource.query(
        'SELECT id FROM videos WHERE id = $1',
        [started.body.id],
      );
      expect(rows).toHaveLength(0);
    }, 60000);

    it('returns 403 for a user from another channel', async () => {
      const owner = await loginAs();
      const started = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner}`)
        .send(validBody)
        .expect(201);
      const intruder = await loginAs();

      const res = await request(app.getHttpServer())
        .delete(
          `/videos/${started.body.id}/uploads/${started.body.upload.upload_id}`,
        )
        .set('Authorization', `Bearer ${intruder}`)
        .expect(403);

      expect(res.body.error).toBe('NOT_VIDEO_OWNER');
    }, 60000);
  });
});
