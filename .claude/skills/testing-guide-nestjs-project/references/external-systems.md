> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — MinIO (Real, Docker)

**Strategy:** real S3-compatible storage via the Docker `minio` service. MinIO locally, S3 in production — only environment variables change.

> Phase 03 replaced the previous local-filesystem strategy. Presigned multipart upload has no filesystem equivalent, and it is the riskiest surface of the upload feature (signatures, ETags, part ordering, Range reads) — mocking it would hide exactly the failures these tests exist to catch.

**Compose services:**

```yaml
minio:
  image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
  command: server /data --console-address ":9001"
  ports: ["9000:9000", "9001:9001"]
  environment:
    - MINIO_ROOT_USER=streamtube
    - MINIO_ROOT_PASSWORD=streamtube
```

A one-shot `minio-init` service (`quay.io/minio/mc`) creates the bucket with `mc mb --ignore-existing`, so repeated `docker compose up` is safe.

**Connection config for tests** — build the service straight from the config factory, no DI container needed:

```typescript
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';

const storage = new StorageService(storageConfig());
```

**Test isolation:** object keys are namespaced by a random `videoId` (`videos/{uuid}/source/...`), so suites never collide and there is nothing to clean between tests.

**Presigned-URL gotcha.** SigV4 signs the `Host` header. URLs are signed against `S3_PUBLIC_ENDPOINT`, which in a real deployment is a hostname reachable from outside the Compose network — and therefore may not resolve inside the `nestjs-api` container where tests run. Use the helper:

```typescript
import { putPart, toInternalUrl } from '../test/storage-test-utils';

const etag = await putPart(presignedUrl, buffer); // rewrites host, PUTs, returns the ETag
const res = await fetch(toInternalUrl(presignedDownloadUrl));
```

**Video fixtures: generate them, do not commit them.**

```typescript
import { createVideoFixture } from '../test/video-fixture';

const fixture = await createVideoFixture(3, 320, 240); // ffmpeg testsrc → { buffer, ... }
```

**Integration test:**

```typescript
describe('StorageService (integration)', () => {
  it('should upload an object in two presigned parts', async () => {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const urls = await storage.presignUploadPartUrls(key, uploadId, 2);

    const etag1 = await putPart(urls[0].url, Buffer.alloc(5 * 1024 * 1024, 1));
    const etag2 = await putPart(urls[1].url, Buffer.alloc(1024, 2));

    await storage.completeMultipartUpload(key, uploadId, [
      { part_number: 1, etag: etag1 },
      { part_number: 2, etag: etag2 },
    ]);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(5 * 1024 * 1024 + 1024);
  });
});
```

---

## Message Queue — BullMQ + Redis (Real, Docker)

**Strategy:** real broker via the Docker `redis` service. The technology is no longer TBD — Phase 03 decided it (`phase-03-videos/TD-02`): BullMQ over Redis, through `@nestjs/bullmq`.

**Version constraint (do not "upgrade" past it):** `@nestjs/bullmq@12` is published ESM-only and cannot be required from this CommonJS project. Pin `@nestjs/bullmq@^11.0.5` (CJS, and its peer range already accepts `bullmq ^6`). `ioredis` is an **optional** peer of BullMQ 6 and must be installed explicitly.

**Compose service:**

```yaml
redis:
  image: redis:8-alpine
  ports: ["6379:6379"]
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
```

**Producer test** — construct a real `Queue` and read the job back:

```typescript
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';

const qc = queueConfig();
const queue = new Queue('video-processing', {
  connection: { host: qc.host, port: qc.port },
});

beforeEach(async () => {
  // Redis is shared across runs — start each test from an empty queue.
  await queue.obliterate({ force: true }).catch(() => undefined);
});
afterAll(async () => {
  await queue.close();
});

it('should enqueue a processing job on upload completion', async () => {
  await videosService.completeUpload(userId, videoId, uploadId, parts);

  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].data).toEqual({ videoId });
  expect(jobs[0].opts.attempts).toBe(3);
});
```

Inside a Nest testing module, resolve the same queue with `getQueueToken('video-processing')`.

**Consumer test** — call the processor directly with a stub `Job` instead of racing the worker container; the transport itself is already covered by the producer test.

```typescript
const processor = new VideoProcessor(videoRepository, storage, extractor);
await processor.process({ data: { videoId } } as never);
```

---

## ffmpeg / ffprobe — Real (installed in the image)

`Dockerfile.dev` installs `ffmpeg`, so both `nestjs-api` (which runs the tests) and `video-worker` have `ffmpeg` and `ffprobe` available. Extractor tests run the real binaries against a real presigned URL — that combination is what proves a large source is read over HTTP Range instead of being downloaded to disk.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
