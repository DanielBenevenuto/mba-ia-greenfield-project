---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1136.0"
    context7_id: "unavailable — see Sourcing note"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html"
    fetched_at: "2026-09-20T18:00:00+00:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1136.0"
    context7_id: "unavailable — see Sourcing note"
    source: "https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner"
    fetched_at: "2026-09-20T18:00:00+00:00"
  "bullmq":
    version: "^6.3.8"
    context7_id: "unavailable — see Sourcing note"
    source: "https://docs.bullmq.io/guide/workers"
    fetched_at: "2026-09-20T18:00:00+00:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "unavailable — see Sourcing note"
    source: "https://docs.nestjs.com/techniques/queues"
    fetched_at: "2026-09-20T18:00:00+00:00"
  "ioredis":
    version: "^5.9.0"
    context7_id: "unavailable — see Sourcing note"
    source: "https://docs.bullmq.io/guide/connections"
    fetched_at: "2026-09-20T18:30:00+00:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T18:23:19.854150+00:00"
---

# phase-03-videos — Library References

> **Sourcing note.** `CLAUDE.md` mandates looking library APIs up through the **context7** MCP server. This checkout's `.mcp.json` registers only the `postgres` server (plus a `figma` HTTP server in `.mcp.json.example`) — **context7 is not configured**, so it was not callable in this session. Every entry below was therefore taken from the library's **official documentation** (URL recorded per lib in the frontmatter) and cross-checked against the version actually resolvable from the npm registry. Flagged here per the CLAUDE.md rule "if the documentation returned does not match the installed version, flag the discrepancy before proceeding".

## Installed / target versions

| Library | Range to install | Latest on registry (2026-09-20) | Compatibility note |
|---|---|---|---|
| `@aws-sdk/client-s3` | `^3.1136.0` | 3.1136.0 | Pure JS, CommonJS-compatible — works with the project's `module: nodenext` + ts-jest CJS build. |
| `@aws-sdk/s3-request-presigner` | `^3.1136.0` | 3.1136.0 | Must track the same minor as `client-s3`. |
| `bullmq` | `^6.3.8` | 6.3.8 | `engines: node >= 14.17`. Bundles its own Redis client. |
| `@nestjs/bullmq` | `^11.0.5` | 12.0.0 | **Deliberately NOT latest.** `12.0.0` is published with `"type": "module"` and a `require` condition pointing at the same ESM bundle, so `require()` from this CommonJS project throws `SyntaxError: Unexpected token 'export'`. `11.0.5` is CJS and its peer range already accepts `bullmq ^6` and `@nestjs/core ^11`. See the `**Revisions:**` block on TD-02. |
| `ioredis` | `^5.9.0` | 6.0.0 | BullMQ 6 declares `ioredis` as an **optional** peer (`>=5.0.0`), so it must be installed explicitly — otherwise the queue fails at runtime with "BullMQ could not load the optional 'ioredis' package". Pinned to the 5.x line that BullMQ 6 is tested against. |

**Rejected for incompatibility (recorded so it is not re-proposed):** `@nestjs/bullmq@12` and `nanoid@6` are both ESM-only (`"type": "module"`, no CJS export condition) and cannot be `require`d from this project's CommonJS build. `@nestjs/bullmq` is therefore pinned to `11.0.5` (see TD-02's Revisions), and `phase-03-videos/TD-07` uses `node:crypto` instead of nanoid.

**System dependency (not npm):** `ffmpeg` / `ffprobe` are installed into the Docker image via `apt-get install -y ffmpeg`. Verified in `node:25.6.0-slim`: `ffprobe version 5.1.9-0+deb12u1`, and `ffmpeg -protocols` lists **`http` and `https`** — required by `phase-03-videos/TD-06`, which feeds a presigned URL as the input so a 10GB source is never downloaded to the worker's disk.

---

## @aws-sdk/client-s3

### Client construction for MinIO (S3-compatible)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'us-east-1',          // MinIO ignores the region but the SDK requires one
  endpoint: 'http://minio:9000', // Compose service name — never localhost (CLAUDE.md)
  forcePathStyle: true,          // MinIO serves path-style buckets, not virtual-host style
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

### Multipart upload commands (the TD-03 handshake)

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

// 1. open the session — returns UploadId
const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType }),
);

// 2. one presigned URL per part (see @aws-sdk/s3-request-presigner below)
new UploadPartCommand({ Bucket, Key, UploadId, PartNumber });  // PartNumber is 1-based

// 3. close the session with the ETags the client collected
await client.send(
  new CompleteMultipartUploadCommand({
    Bucket, Key, UploadId,
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"abc..."' }, /* ... */] },
  }),
);

// abort a session the client gave up on
await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

### Range reads (the TD-08 streaming proxy)

```typescript
const res = await client.send(
  new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1048575' }),
);
// res.Body is a Node Readable  → pipe it straight to the HTTP response
// res.ContentRange  → 'bytes 0-1048575/10737418240'
// res.ContentLength → length of THIS range, not of the whole object
```

`HeadObjectCommand` returns `ContentLength` / `ContentType` for the full object without transferring the body — used to build the `Content-Range` header and to verify the uploaded size.

### Hard limits that shape the design (AWS official docs)

| Item | Value |
|---|---|
| Max object size via a **single PUT** | **5 GB** |
| Max object size via **multipart** | 48.8 TiB (docs also quote "up to 50 TB") |
| Part size | 5 MiB – 5 GiB (no minimum on the **last** part) |
| Max parts per upload | 10,000 |

→ 10GB **cannot** be uploaded with one presigned `PutObject`. With 64 MiB parts, a 10GB file is 160 parts — comfortably inside the 10,000-part ceiling.

Sources: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html>, <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>

---

## @aws-sdk/s3-request-presigner

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

| Option | Meaning |
|---|---|
| `expiresIn` | URL lifetime in seconds. **Default 900.** |
| `signableHeaders` | `Set` of non-`x-amz-*` headers to sign, e.g. `new Set(['content-type'])`. |
| `unhoistableHeaders` | `Set` of `x-amz-*` headers that must be sent as headers rather than query params. |
| `hoistableHeaders` | `Set` of `x-amz-*` headers to hoist into the query string. |

**Any** S3 command can be presigned — including `UploadPartCommand` (per-part upload URLs) and `GetObjectCommand` (download URL).

**Download with a forced filename (TD-09):** put the response overrides on the command, not on the presign options —

```typescript
const cmd = new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${filename}"`,
  ResponseContentType: 'video/mp4',
});
const url = await getSignedUrl(client, cmd, { expiresIn: 300 });
```

**Endpoint duality (TD-01) — the trap.** SigV4 signs the `Host` header, so a URL signed by a client configured with `endpoint: http://minio:9000` is only valid for a request whose Host is `minio:9000`. URLs meant for a caller outside the Compose network must be produced by a **second** client configured with the public endpoint (`S3_PUBLIC_ENDPOINT`). Server-to-server calls keep using the internal endpoint.

Source: <https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner>

---

## bullmq

### Worker and processor

```typescript
import { Worker, Job } from 'bullmq';

const worker = new Worker(queueName, async (job: Job) => {
  // do something with job.data
  return 'some value';          // becomes job.returnvalue
});
```

### Events

```typescript
worker.on('completed', (job: Job, returnvalue: any) => {});
worker.on('failed', (job: Job, error: Error) => {});
worker.on('progress', (job: Job, progress: number | object) => {});
```

A processor that **throws** moves the job to `failed`.

### Retries and backoff (TD-10's failure policy)

```typescript
await queue.add('test-retry', { foo: 'bar' }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },   // delay = 2 ^ (attempts - 1) * delay
});
```

Or once, for every job on the queue:

```typescript
const myQueue = new Queue('foo', {
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
});
```

`type: 'fixed'` retries after a constant delay; both accept `jitter`. The job reaches the `failed` set only after the **last** attempt fails — which is the moment TD-10 flips the video to `failed`.

Source: <https://docs.bullmq.io/guide/workers>, <https://docs.bullmq.io/guide/retrying-failing-jobs>

---

## @nestjs/bullmq

### Root registration

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
})
```

Root options: `connection`, `prefix`, `defaultJobOptions`, `settings`.

### Queue registration and injection

```typescript
BullModule.registerQueue({ name: 'video-processing' })
```

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideosService {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

  async enqueue(videoId: string) {
    await this.queue.add('process-video', { videoId });
  }
}
```

### Processor

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ...
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {}
}
```

Worker events available via `@OnWorkerEvent`: `active`, `completed`, `failed`, `stalled`, and the rest of `WorkerListener`.

### Testing hook (TD-11)

`getQueueToken('video-processing')` resolves the `Queue` instance from a testing module, so an integration test can assert what the producer enqueued:

```typescript
const queue = moduleRef.get<Queue>(getQueueToken('video-processing'));
const jobs = await queue.getJobs(['waiting']);
expect(jobs[0].data).toEqual({ videoId: expect.any(String) });
```

**Note on separate-process processors.** The NestJS docs offer `processors: [join(__dirname, 'processor.js')]` to fork a child process, but **dependency injection is unavailable in forked processors**. `phase-03-videos/TD-05` therefore does *not* use that mechanism — it runs a second Compose service from the same image with its own Nest application context, which keeps DI, TypeORM and the storage service intact.

Source: <https://docs.nestjs.com/techniques/queues>
