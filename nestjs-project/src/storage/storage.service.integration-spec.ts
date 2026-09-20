import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { putPart, toInternalUrl } from '../test/storage-test-utils';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service from `compose.yaml` — no mocks. Presigned
 * multipart is the riskiest surface of this phase (signatures, ETags, part
 * ordering), so it is verified against the actual S3 implementation.
 */
describe('StorageService (integration)', () => {
  let service: StorageService;
  const createdKeys: string[] = [];

  // 5 MiB is the minimum S3 accepts for any part but the last.
  const PART_SIZE = 5 * 1024 * 1024;

  beforeAll(() => {
    service = new StorageService(storageConfig());
  });

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }

  describe('multipart upload', () => {
    it('should upload an object in two presigned parts and expose the full size', async () => {
      const key = `videos/${randomUUID()}/source/two-parts.bin`;
      createdKeys.push(key);
      const first = Buffer.alloc(PART_SIZE, 1);
      const second = Buffer.alloc(1024, 2);

      const uploadId = await service.createMultipartUpload(key, 'video/mp4');
      const urls = await service.presignUploadPartUrls(key, uploadId, 2);
      expect(urls).toHaveLength(2);
      expect(urls.map((u) => u.part_number)).toEqual([1, 2]);

      const etag1 = await putPart(urls[0].url, first);
      const etag2 = await putPart(urls[1].url, second);

      await service.completeMultipartUpload(key, uploadId, [
        { part_number: 2, etag: etag2 },
        { part_number: 1, etag: etag1 },
      ]);

      const head = await service.headObject(key);
      expect(head.contentLength).toBe(first.length + second.length);
      expect(head.contentType).toBe('video/mp4');
    }, 60000);

    it('should reject completing an upload that was aborted', async () => {
      const key = `videos/${randomUUID()}/source/aborted.bin`;
      const body = Buffer.alloc(PART_SIZE, 3);

      const uploadId = await service.createMultipartUpload(key, 'video/mp4');
      const [part] = await service.presignUploadPartUrls(key, uploadId, 1);
      const etag = await putPart(part.url, body);

      await service.abortMultipartUpload(key, uploadId);

      await expect(
        service.completeMultipartUpload(key, uploadId, [
          { part_number: 1, etag },
        ]),
      ).rejects.toThrow();
    }, 60000);
  });

  describe('reading objects', () => {
    let key: string;
    const content = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => i % 256),
    );

    beforeAll(async () => {
      key = `videos/${randomUUID()}/source/readable.bin`;
      createdKeys.push(key);
      await service.putObject(key, content, 'video/mp4');
    });

    it('should return only the requested byte range with a Content-Range header', async () => {
      const result = await service.getObjectRange(key, 'bytes=0-1023');
      const body = await drain(result.body);

      expect(body).toHaveLength(1024);
      expect(result.contentLength).toBe(1024);
      expect(result.contentRange).toBe(`bytes 0-1023/${content.length}`);
      expect(body.equals(content.subarray(0, 1024))).toBe(true);
    });

    it('should return a range from the middle of the object', async () => {
      const result = await service.getObjectRange(key, 'bytes=1000-1999');
      const body = await drain(result.body);

      expect(body.equals(content.subarray(1000, 2000))).toBe(true);
      expect(result.contentRange).toBe(`bytes 1000-1999/${content.length}`);
    });

    it('should return the whole object when no range is given', async () => {
      const result = await service.getObjectRange(key);
      const body = await drain(result.body);

      expect(body).toHaveLength(content.length);
      expect(result.contentRange).toBeUndefined();
    });
  });

  describe('presigned URLs', () => {
    let key: string;

    beforeAll(async () => {
      key = `videos/${randomUUID()}/source/original name.mp4`;
      createdKeys.push(key);
      await service.putObject(key, Buffer.from('payload'), 'video/mp4');
    });

    it('should sign a download URL that forces an attachment with the original filename', async () => {
      const url = await service.presignDownloadUrl(
        key,
        'original name.mp4',
        'video/mp4',
      );

      const response = await fetch(toInternalUrl(url));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'original_name.mp4',
      );
    }, 30000);

    it('should sign a read URL usable without credentials', async () => {
      const url = await service.presignReadUrl(key);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('payload');
    }, 30000);

    it('should sign URLs against the configured public endpoint', async () => {
      const url = await service.presignDownloadUrl(key, 'a.mp4', 'video/mp4');

      expect(url.startsWith(storageConfig().publicEndpoint)).toBe(true);
    });

    it('should reject a tampered signature', async () => {
      const url = await service.presignReadUrl(key);
      const tampered = `${url.slice(0, -4)}dead`;

      const response = await fetch(toInternalUrl(tampered));

      expect(response.status).toBeGreaterThanOrEqual(400);
    }, 30000);
  });
});
